/**
 * Browser My Template Report orchestration.
 *
 * Authentication, request parsing, HTTP status mapping, TransformStream
 * ownership, and SSE byte serialization stay in app/api/generate-report/route.ts.
 * This module owns the My Template application workflow and emits semantic
 * events so the route remains a transport adapter.
 *
 * Provenance note (deferred, not addressed here): this module receives
 * user_template_text/user_template_conclusion/user_template_title exactly as
 * supplied in the request body. It does not re-fetch or verify against
 * user_report_templates — matching current, pre-extraction behavior exactly.
 * Ownership/provenance validation is a separately tracked follow-up, not part
 * of this extraction.
 *
 * Supabase client boundary: retrieveSimilarUserTemplates MUST be called with
 * the AUTHENTICATED client (supabaseAuth) — its SECURITY DEFINER RPC scopes
 * to auth.uid(), which is null under the service-role client. Every other
 * call in this module uses the service-role client (supabase). Do not
 * collapse these into one client.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { calculateAnthropicCost } from "../ai/anthropic-cost.ts";
import { loadDatabaseAbbreviations } from "../ai/database-abbreviations.ts";
import { retrieveSimilarUserTemplates } from "../embeddings/retrieve.ts";
import {
  ALLOWED_MODELS,
  buildCachedSystemBlocks,
  checkReportRateLimit,
  getAnthropic,
  resolvePartialNormals,
  type AllowedModel,
} from "./kernel.ts";
import { enforceOpinionOrder } from "./opinion-order.ts";
import { persistReportUsageWithRetry } from "./usage-log-persistence.ts";
import { getSkeleton } from "../skeletons/skeletons.ts";
import { getUserPlan } from "../stripe/get-user-plan.ts";
import { buildPrompt } from "../templates/prompt_builder.ts";
import type { MatchInput, ReportingStyleProfile } from "../templates/matcher.ts";
import { runMyTemplateQualityCheck } from "../templates/my_template_quality_check.ts";
import {
  getOrCreateUsage,
  refundCredits,
  reserveCredits,
} from "../usage/credits.ts";

const CREDIT_MODE = "fast" as const;
const REPORT_MODE = "my_template";
const REVIEW_MODE = "my_template";
const CREDIT_COST = 1.0;

export interface MyTemplateGenerationInput {
  modality: string;
  body_region: string;
  indication: string;
  findings: string;
  field_strength?: string;
  study_type?: string;
  laterality?: string;
  model?: string;
  report_header?: string;
  opinion_hints?: string;
  residual_opinion_hints?: string;
  preserve_findings_order?: boolean;
  user_template_text: string;
  user_template_conclusion?: string;
  user_template_title?: string;
  template_edits?: string;
  use_reporting_style_profile?: boolean;
}

export type MyTemplateGenerationEvent =
  | { type: "prelude"; text: string }
  | { type: "delta"; data: { t: string } }
  | {
      type: "done";
      data: {
        final_report: string;
        review_id: string | null;
        credits_remaining: number;
        credits_limit: number;
        confidence: "high";
        category: string;
        template_names: string[];
        style_validation: null;
        quality_warnings: string[];
      };
    }
  | { type: "error"; data: { error: string } };

export type MyTemplateGenerationPreparation =
  | { ok: false; category: "rate-limited"; retry_after_seconds: number }
  | {
      ok: false;
      category: "credits-exhausted";
      credits_remaining: number;
      credits_limit: number;
      plan: string;
      upgrade_required: boolean;
    }
  | { ok: false; category: "credit-reservation-failed" }
  | { ok: false; category: "setup-error"; message: string }
  | {
      ok: true;
      run: (emit: (event: MyTemplateGenerationEvent) => Promise<void>) => Promise<void>;
    };

export interface MyTemplateGenerationDeps {
  /** Service-role client — style profile, credits, usage/review persistence. */
  supabase: SupabaseClient;
  /** Authenticated (session) client — REQUIRED for retrieveSimilarUserTemplates. */
  supabaseAuth: SupabaseClient;
  anthropic?: Pick<Anthropic, "messages">;
  checkReportRateLimit?: typeof checkReportRateLimit;
  getUserPlan?: typeof getUserPlan;
  getOrCreateUsage?: typeof getOrCreateUsage;
  loadDatabaseAbbreviations?: typeof loadDatabaseAbbreviations;
  getSkeleton?: typeof getSkeleton;
  reserveCredits?: typeof reserveCredits;
  refundCredits?: typeof refundCredits;
  retrieveSimilarUserTemplates?: typeof retrieveSimilarUserTemplates;
  buildPrompt?: typeof buildPrompt;
  runMyTemplateQualityCheck?: typeof runMyTemplateQualityCheck;
  fetchStyleProfile?: (
    supabase: SupabaseClient,
    userId: string,
  ) => Promise<ReportingStyleProfile | null>;
  logReportUsage?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<void>;
  insertReportReview?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<string | null>;
}

async function defaultFetchStyleProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<ReportingStyleProfile | null> {
  // Non-critical: any failure (missing row, RLS, network) falls back to no
  // profile — generation must never be blocked by this lookup.
  try {
    const { data: styleRow } = await supabase
      .from("user_reporting_style_profiles")
      .select("profile")
      .eq("user_id", userId)
      .maybeSingle();
    if (styleRow?.profile && typeof styleRow.profile === "object") {
      return styleRow.profile as ReportingStyleProfile;
    }
    return null;
  } catch {
    return null;
  }
}

async function defaultLogReportUsage(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  await persistReportUsageWithRetry(
    supabase,
    { id: crypto.randomUUID(), ...row },
    { workflow: REPORT_MODE },
  );
}

async function defaultInsertReportReview(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("report_reviews")
    .insert(row)
    .select("id")
    .single();
  if (error) console.warn("[generate-report] review record insert failed:", error.message);
  return data?.id ?? null;
}

function cleanMyTemplateReport(reportTextPreClean: string): string {
  const lines = reportTextPreClean
    .split("\n")
    .filter((line) => !/\[PARTIAL NORMAL/i.test(line));
  let inOpinion = false;
  const seenOpinionBullets = new Set<string>();
  const deduplicated = lines.filter((line) => {
    const upper = line.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, "");
    if (/^(OPINION|IMPRESSION|CONCLUSION)\s*:?\s*$/.test(line.trim().toUpperCase())) {
      inOpinion = true;
      return true;
    }
    if (inOpinion && line.trim().startsWith("- ")) {
      if (seenOpinionBullets.has(upper)) return false;
      seenOpinionBullets.add(upper);
    }
    return true;
  });
  return deduplicated.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function prepareMyTemplateReport(
  user: { id: string; email?: string | null },
  input: MyTemplateGenerationInput,
  deps: MyTemplateGenerationDeps,
): Promise<MyTemplateGenerationPreparation> {
  const { supabase, supabaseAuth } = deps;
  const checkReportRateLimitFn = deps.checkReportRateLimit ?? checkReportRateLimit;
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const getOrCreateUsageFn = deps.getOrCreateUsage ?? getOrCreateUsage;
  const loadDatabaseAbbreviationsFn = deps.loadDatabaseAbbreviations ?? loadDatabaseAbbreviations;
  const getSkeletonFn = deps.getSkeleton ?? getSkeleton;
  const reserveCreditsFn = deps.reserveCredits ?? reserveCredits;
  const refundCreditsFn = deps.refundCredits ?? refundCredits;
  const retrieveSimilarUserTemplatesFn = deps.retrieveSimilarUserTemplates ?? retrieveSimilarUserTemplates;
  const buildPromptFn = deps.buildPrompt ?? buildPrompt;
  const runMyTemplateQualityCheckFn = deps.runMyTemplateQualityCheck ?? runMyTemplateQualityCheck;
  const fetchStyleProfileFn = deps.fetchStyleProfile ?? defaultFetchStyleProfile;
  const logReportUsageFn = deps.logReportUsage ?? defaultLogReportUsage;
  const insertReportReviewFn = deps.insertReportReview ?? defaultInsertReportReview;

  const rateLimit = await checkReportRateLimitFn(user.id, supabase);
  if (rateLimit.limited) {
    return {
      ok: false,
      category: "rate-limited",
      retry_after_seconds: rateLimit.retryAfterSeconds,
    };
  }

  // Early balance check — a stale-read UX nicety, not the guard. reserveCredits
  // below is the atomic, race-safe check.
  const sub = await getUserPlanFn(user.id);
  const usageRecord = await getOrCreateUsageFn(
    supabase,
    user.id,
    sub.plan,
    sub.current_period_end,
  );
  if (usageRecord.credits_remaining < CREDIT_COST) {
    return {
      ok: false,
      category: "credits-exhausted",
      credits_remaining: usageRecord.credits_remaining,
      credits_limit: usageRecord.credits_limit,
      plan: sub.plan,
      upgrade_required: sub.plan !== "pro" && sub.plan !== "institution",
    };
  }

  const modality = input.modality;
  const bodyRegion = input.body_region;
  const studyType = input.study_type || undefined;
  const userTemplateText = input.user_template_text;

  // Called unconditionally to preserve current (pre-extraction) behavior
  // exactly — its result is not used by the My Template path today. See
  // Phase 4 deferred-issues notes; not addressed in this extraction.
  const databaseAbbreviations = await loadDatabaseAbbreviationsFn(
    supabase,
    modality,
    bodyRegion,
    studyType,
  );
  void databaseAbbreviations;

  const mriTechniqueLines: string[] | undefined = modality === "MRI"
    ? (() => {
        const sk = getSkeletonFn(modality, bodyRegion, studyType || bodyRegion);
        return sk?.technique?.length ? sk.technique : undefined;
      })()
    : undefined;

  // ── Style profile (server-side; user_id from the authenticated session,
  // never from the client). Non-critical — any failure falls back to null.
  let resolvedStyleProfile: ReportingStyleProfile | null = null;
  if (input.use_reporting_style_profile !== false) {
    resolvedStyleProfile = await fetchStyleProfileFn(supabase, user.id);
  }

  // ── Similar past reports (Voyage embedding + per-user cosine RPC). Same
  // gate as the style profile. Fully graceful: any failure returns [] and
  // generation proceeds with no examples. MUST use the authenticated client
  // — see module-level note.
  let resolvedStyleExamples: MatchInput["style_examples"] = [];
  if (input.use_reporting_style_profile !== false) {
    const queryText = [
      [modality, bodyRegion, studyType].filter(Boolean).join(" "),
      input.indication,
      input.findings,
      input.template_edits,
    ]
      .filter((v) => typeof v === "string" && v.trim())
      .join("\n")
      .trim();
    const retrieved = await retrieveSimilarUserTemplatesFn({
      supabase: supabaseAuth,
      queryText,
      limit: 3,
      excludeTemplateId: undefined,
    });
    // Content-based self-exclusion: the current My Template's id is not sent
    // to this route, so drop any retrieved row whose body matches it so it
    // can't appear as its own example.
    const baseline = (userTemplateText ?? "").trim();
    resolvedStyleExamples = retrieved.filter(
      (r) => r.findings_text.trim() !== baseline,
    );
  }

  const inputPayload: MatchInput & { preserve_findings_order: boolean } = {
    modality,
    body_region: bodyRegion,
    indication: input.indication,
    findings: resolvePartialNormals(input.findings ?? ""),
    field_strength: input.field_strength || undefined,
    study_type: studyType,
    age: undefined,
    sex: undefined,
    laterality: input.laterality,
    report_header: input.report_header || undefined,
    opinion_hints: input.opinion_hints ?? "",
    preserve_findings_order: !!input.preserve_findings_order,
    template_guided: true,
    my_template_mode: true,
    template_edits: input.template_edits?.trim() || undefined,
    mri_technique: mriTechniqueLines,
    normal_skeleton_findings: undefined,
    style_profile: resolvedStyleProfile,
    style_examples: resolvedStyleExamples,
  };

  let reserved = false;
  try {
    reserved = await reserveCreditsFn(supabase, user.id, CREDIT_MODE);
  } catch (reserveError) {
    const message = reserveError instanceof Error
      ? reserveError.message
      : "credit reservation failed";
    console.error("[generate-report] credit reservation error:", message);
    return { ok: false, category: "credit-reservation-failed" };
  }
  if (!reserved) {
    return {
      ok: false,
      category: "credits-exhausted",
      credits_remaining: 0,
      credits_limit: usageRecord.credits_limit,
      plan: sub.plan,
      upgrade_required: sub.plan !== "pro" && sub.plan !== "institution",
    };
  }

  try {
    // My Template bypasses template matching entirely — the user's own
    // template text/conclusion/title is the (synthetic) sole match.
    const matchResult = {
      matched_templates: [{
        id: "user-template",
        file_name: input.user_template_title ?? "My Template",
        body_region: bodyRegion,
        modality,
        pathology_category: "User Template",
        pathology_name: input.user_template_title ?? "My Template",
        findings_text: userTemplateText,
        opinion_text: input.user_template_conclusion ?? "",
        full_text: input.user_template_conclusion
          ? `${userTemplateText}\n\nOPINION:\n${input.user_template_conclusion}`
          : userTemplateText,
        keywords: [] as string[],
        relevance_score: 999,
      }],
      match_confidence: "high" as const,
      pathology_category: "User Template",
      query_terms: [] as string[],
    };

    // My Template skips parseToPrompt for its own findings (isTemplateMode
    // path) — the parsed value is simply the raw findings, which then
    // overrides inputPayload.findings (the resolvePartialNormals'd value)
    // in promptInput below. Preserved exactly, including this override.
    const parsedFindings = input.findings;
    const finalFindings = parsedFindings || input.findings || "";
    const promptInput = { ...inputPayload, findings: finalFindings };
    const { system, user: userMsg, staticInstructions } =
      buildPromptFn(matchResult.matched_templates, promptInput);
    const anthropic = deps.anthropic ?? getAnthropic();
    const selectedModel: AllowedModel = (ALLOWED_MODELS as readonly string[]).includes(input.model ?? "")
      ? (input.model as AllowedModel)
      : "claude-sonnet-4-6";

    return {
      ok: true,
      run: async (emit) => {
        let streamSucceeded = false;
        let accText = "";
        try {
          await emit({ type: "prelude", text: `: ${" ".repeat(2048)}\n\n` });

          const claudeStream = anthropic.messages.stream(
            {
              model: selectedModel,
              max_tokens: 2048,
              temperature: 0, // isTemplateMode is true for My Template → temperature 0
              system: buildCachedSystemBlocks(system, staticInstructions),
              messages: [{ role: "user", content: userMsg }],
            },
            { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
          );

          for await (const event of claudeStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const textChunk = event.delta.text;
              accText += textChunk;
              await emit({ type: "delta", data: { t: textChunk } });
            }
          }

          const finalMsg = await claudeStream.finalMessage();
          const inputTokens = finalMsg.usage.input_tokens;
          const outputTokens = finalMsg.usage.output_tokens;
          const cachedTokens = finalMsg.usage.cache_read_input_tokens ?? 0;
          const cacheCreationTokens = finalMsg.usage.cache_creation_input_tokens ?? 0;
          const estimatedCostUsd = calculateAnthropicCost({
            model: selectedModel,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cachedTokens,
          }).estimated_cost_usd;

          try {
            await logReportUsageFn(supabase, {
              user_id: user.id,
              model: selectedModel,
              mode: REPORT_MODE,
              modality: modality ?? null,
              body_region: bodyRegion ?? null,
              study_type: studyType ?? null,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cached_tokens: cachedTokens,
              estimated_cost_usd: estimatedCostUsd,
              templates_used: 0,
              report_chars: 0,
            });
          } catch (usageError) {
            console.error("[usage-log] my_template insert failed:", usageError);
          }
          console.log("TOKENS (stream/my-template)", {
            input: inputTokens, output: outputTokens,
            cached: cachedTokens, cache_creation: cacheCreationTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          // Post-processing: same pipeline as before extraction.
          const reportTextPreClean = enforceOpinionOrder(
            accText,
            input.opinion_hints ?? "",
            input.residual_opinion_hints ?? "",
          );
          const reportText = cleanMyTemplateReport(reportTextPreClean);

          // My Template quality check — deterministic, no AI call.
          const { cleanedText: finalReportText, warnings } = runMyTemplateQualityCheckFn({
            reportText,
            hadOpinionInOriginal: /\b(OPINION|IMPRESSION|CONCLUSION|DIAGNOSIS)\s*:?/i.test(
              input.user_template_conclusion ?? ""
            ),
            templateEdits: inputPayload.template_edits ?? "",
          });
          if (warnings.length) {
            console.warn("[generate-report] My Template quality check warnings:", warnings);
          }
          const myTemplateQualityWarnings = warnings;

          const reviewId = await insertReportReviewFn(supabase, {
            user_id: user.id, user_email: user.email ?? null,
            modality, body_region: bodyRegion, study_type: studyType ?? null,
            report_mode: REVIEW_MODE, model: selectedModel,
            category: matchResult.pathology_category,
            template_names: matchResult.matched_templates.map((t) => t.pathology_name || t.file_name),
            original_report: finalReportText,
            input_tokens: inputTokens, output_tokens: outputTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          await emit({
            type: "done",
            data: {
              final_report: finalReportText,
              review_id: reviewId,
              credits_remaining: Math.max(0, usageRecord.credits_remaining - CREDIT_COST),
              credits_limit: usageRecord.credits_limit,
              confidence: matchResult.match_confidence,
              category: matchResult.pathology_category,
              template_names: matchResult.matched_templates.map((t) => t.pathology_name || t.file_name),
              style_validation: null,
              quality_warnings: myTemplateQualityWarnings,
            },
          });

          streamSucceeded = true;
        } catch (pumpError) {
          const errorMessage = pumpError instanceof Error
            ? pumpError.message
            : "Streaming failed";
          console.error("[generate-report] stream pump error (my-template):", errorMessage);
          if (!streamSucceeded) {
            try {
              await refundCreditsFn(supabase, user.id, CREDIT_MODE);
            } catch (refundError) {
              console.error(
                `[generate-report] CRITICAL: refundCredits FAILED after my-template stream pump error — ` +
                `user ${user.id} charged ${CREDIT_COST} credits for a failed report (needs manual refund): ` +
                (refundError instanceof Error ? refundError.message : String(refundError))
              );
            }
          }
          try {
            await emit({ type: "error", data: { error: errorMessage } });
          } catch {
            // The browser may have disconnected.
          }
        }
      },
    };
  } catch (setupError) {
    const message = setupError instanceof Error ? setupError.message : "Unknown error";
    console.error("[generate-report] error:", message);
    try {
      await refundCreditsFn(supabase, user.id, CREDIT_MODE);
    } catch (refundError) {
      const refundMessage = refundError instanceof Error ? refundError.message : "unknown error";
      console.error(
        `[generate-report] CRITICAL: refund_credits FAILED after an unsuccessful generation — ` +
        `user ${user.id} was charged ${CREDIT_COST} for a failed report and needs a manual refund: ${refundMessage}`,
      );
    }
    return { ok: false, category: "setup-error", message };
  }
}

