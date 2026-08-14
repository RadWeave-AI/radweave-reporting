/**
 * Checklist / auto-match report generation.
 *
 * Owns the Checklist workflow in both of its shapes:
 *  - prepareBrowserAutoMatchedReport — the browser's streaming (SSE) Checklist
 *    mode, driven by app/api/generate-report/route.ts
 *  - generateAutoMatchedReport — the blocking, non-streaming variant used by
 *    app/api/desktop/generate-report/route.ts
 *
 * Both use the same "server auto-matches templates, no client-selected
 * template" strategy; they remain separate functions because their
 * provider/error/refund semantics are intentionally different.
 *
 * Workflow-agnostic primitives (env/client factories, rate limiting,
 * cache-block formatting, resolvePartialNormals, ALLOWED_MODELS) live in the
 * sibling lib/reporting/kernel.ts and are imported below. The other four
 * workflow modules import those same primitives from the kernel directly.
 *
 * Split out of lib/reporting/generation-engine.ts. The function bodies below
 * are unchanged from that file.
 *
 * PHI / governance:
 *  - Only clinical/reporting fields ever enter DesktopReportRequest — no
 *    patient identifiers, accession numbers, or DICOM UIDs are accepted or
 *    referenced by this module.
 *  - report_usage_logs receives metadata and counts only (no report text).
 *  - report_reviews.original_report stores the AI-GENERATED report text —
 *    exactly the same column the existing browser modes already write to.
 *    The radiologist's raw input findings are never separately persisted.
 *  - Nothing in this module logs request bodies or clinical text; console
 *    output here is limited to token counts and non-clinical error text.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
// Value import (not `import type`): Anthropic.APIUserAbortError is used as a
// value in generateAutoMatchedReport's provider error handling.
import Anthropic from "@anthropic-ai/sdk";

import { getUserPlan } from "@/lib/stripe/get-user-plan";
import {
  getOrCreateUsage,
  reserveCredits,
  refundCredits,
  type CreditCostKey,
} from "@/lib/usage/credits";
import { matchTemplates, type MatchInput } from "@/lib/templates/matcher";
import { buildPrompt } from "@/lib/templates/prompt_builder";
import { isNormalTemplateRow } from "@/lib/templates/normal-template";
import { canUseFeature } from "@/lib/features/access";
import { parseToPrompt } from "@/lib/ai/abbreviation-parser";
import { loadDatabaseAbbreviations } from "@/lib/ai/database-abbreviations";
import { calculateAnthropicCost } from "@/lib/ai/anthropic-cost";
import { isPairedStudyType, normalizeLaterality } from "@/lib/config/laterality";
import { strip as stripPlaceholderSyntax } from "@/lib/checklists/placeholders";
import { enforceOpinionOrder } from "@/lib/reporting/opinion-order";
import { getSkeleton } from "@/lib/skeletons/skeletons";
import { persistReportUsageWithRetry } from "@/lib/reporting/usage-log-persistence";
import {
  ALLOWED_MODELS,
  buildCachedSystemBlocks,
  checkReportRateLimit,
  getAnthropic,
  resolvePartialNormals,
  type AllowedModel,
} from "@/lib/reporting/kernel";

/**
 * Post-processing safety net shared by every generation branch in route.ts
 * (previously copy-pasted five times, once per streaming mode): strips any
 * [PARTIAL NORMAL ...] marker the AI failed to resolve, and deduplicates
 * repeated OPINION bullets (the AI plus opinion_hints can otherwise both
 * emit the same line).
 */
export function cleanGeneratedReportText(reportTextPreClean: string): string {
  const lines = reportTextPreClean.split("\n").filter((line) => !/\[PARTIAL NORMAL/i.test(line));

  let inOpinion = false;
  const seenOpinionBullets = new Set<string>();
  const deduped = lines.filter((line) => {
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

  return deduped.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Non-streaming "auto-match" generation engine ────────────────────────────
// Same generation strategy as route.ts's checklist/auto-match streaming
// branch (server matches templates itself; no client-selected template, no
// user_template_text, no quick/comparison mode) — as one blocking call.

/** Credit cost bucket used for every mode today (mirrors route.ts's constant "fast"). */
const CREDIT_MODE: CreditCostKey = "fast";
/** report_usage_logs.mode / report_reviews.report_mode value for a server-auto-matched
 *  request with no client-selected template — the SAME value route.ts's own
 *  auto-match/checklist mode already writes, so Desktop traffic is accounted
 *  for with the existing taxonomy rather than a new one. */
const REPORT_MODE = "checklist";

export interface DesktopReportRequest {
  modality: string;
  body_region: string;
  indication?: string;
  findings: string;
  field_strength?: string;
  study_type?: string;
  laterality?: string;
  age?: number;
  sex?: "Male" | "Female";
  model?: string;
}

export type GenerationErrorCategory =
  | "validation-error"
  | "rate-limited"
  | "insufficient-credits"
  | "upgrade-required"
  | "provider-error"
  | "timeout"
  // The caller (Desktop) disconnected before the Anthropic call finished --
  // distinct from "timeout" (which is the CLIENT's own perspective) and from
  // "provider-error" (an actual Anthropic failure). Nothing reads this value
  // over the wire (the client is gone by definition), but it keeps server
  // logs honest about why generationSucceeded stayed false and the credit
  // was refunded.
  | "aborted";

export interface GenerationUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost_usd: number;
}

export interface GenerationCredits {
  remaining: number;
  limit: number;
}

export interface GenerationSuccess {
  ok: true;
  report: string;
  model: AllowedModel;
  usage: GenerationUsage;
  credits: GenerationCredits;
  mode: string;
  category: string;
  confidence: string;
  templates_used: number;
  template_names: string[];
  review_id: string | null;
}

export interface GenerationFailure {
  ok: false;
  category: GenerationErrorCategory;
  message: string;
  retry_after_seconds?: number;
  credits_remaining?: number;
  credits_limit?: number;
}

export type GenerationResult = GenerationSuccess | GenerationFailure;

function fail(category: GenerationErrorCategory, message: string, extra: Partial<GenerationFailure> = {}): GenerationFailure {
  return { ok: false, category, message, ...extra };
}

/**
 * Every external collaborator the engine calls, as an injectable bag with
 * real defaults. Production code (both route.ts and the Desktop route) never
 * passes overrides, so it always runs the real matchTemplates / buildPrompt /
 * credits / rate-limit / feature-gate functions — the same ones the browser's
 * streaming modes use. Tests inject minimal fakes for only the collaborator(s)
 * relevant to what they're checking, instead of one giant fake Supabase client
 * that has to faithfully emulate every table this call graph touches.
 */
export interface GenerationDeps {
  supabase: SupabaseClient;
  anthropic?: Pick<Anthropic, "messages">;
  /** Forwarded from the route's NextRequest.signal (standard Fetch API
   * AbortSignal). When the Desktop client disconnects (e.g. its own
   * client-side timeout), this fires, the in-flight Anthropic call is
   * aborted, generationSucceeded stays false, and the existing finally
   * block refunds the reserved credit -- see the anthropic.messages.create
   * call below. Optional and backward compatible: omitting it behaves
   * exactly as before (no cancellation wired up). */
  signal?: AbortSignal;
  matchTemplates?: typeof matchTemplates;
  buildPrompt?: typeof buildPrompt;
  getUserPlan?: typeof getUserPlan;
  getOrCreateUsage?: typeof getOrCreateUsage;
  reserveCredits?: typeof reserveCredits;
  refundCredits?: typeof refundCredits;
  checkReportRateLimit?: typeof checkReportRateLimit;
  canUseFeature?: typeof canUseFeature;
  loadDatabaseAbbreviations?: typeof loadDatabaseAbbreviations;
  logReportUsage?: (supabase: SupabaseClient, row: Record<string, unknown>) => Promise<void>;
  insertReportReview?: (supabase: SupabaseClient, row: Record<string, unknown>) => Promise<string | null>;
}

async function defaultLogReportUsage(supabase: SupabaseClient, row: Record<string, unknown>): Promise<void> {
  await persistReportUsageWithRetry(supabase, { id: crypto.randomUUID(), ...row }, { workflow: REPORT_MODE });
}

async function defaultInsertReportReview(supabase: SupabaseClient, row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.from("report_reviews").insert(row).select("id").single();
  if (error) console.warn("[desktop-generate-report] review record insert failed:", error.message);
  return data?.id ?? null;
}

// ── Browser Checklist / auto-match streaming orchestration ──────────────────

export interface BrowserAutoMatchInput {
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
  template_edits?: string;
}

export type BrowserAutoMatchEvent =
  | { type: "prelude"; text: string }
  | { type: "delta"; data: { t: string } }
  | {
      type: "done";
      data: {
        final_report: string;
        review_id: string | null;
        credits_remaining: number;
        credits_limit: number;
        confidence: string;
        category: string;
        template_names: string[];
        style_validation: null;
      };
    }
  | { type: "error"; data: { error: string } };

export type BrowserAutoMatchPreparation =
  | {
      ok: false;
      category: "rate-limited";
      retry_after_seconds: number;
    }
  | {
      ok: false;
      category: "credits-exhausted";
      credits_remaining: number;
      credits_limit: number;
      plan: string;
      upgrade_required: boolean;
    }
  | {
      ok: false;
      category: "credit-reservation-failed";
    }
  | {
      ok: false;
      category: "setup-error";
      message: string;
    }
  | {
      ok: true;
      run: (emit: (event: BrowserAutoMatchEvent) => Promise<void>) => Promise<void>;
    };

function enforceBrowserFindingsOrder(report: string, orderedFindings: string): string {
  const findingsBlock = orderedFindings
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .join("\n");
  if (!findingsBlock) return report;

  const mriPattern = /(MRI FINDINGS:\s*)([\s\S]*?)(\n\s*OPINION:)/i;
  if (mriPattern.test(report)) {
    return report.replace(mriPattern, `$1\n${findingsBlock}$3`);
  }

  const opinionPattern = /(\n\s*OPINION:)/i;
  const opinionMatch = report.match(opinionPattern);
  if (!opinionMatch?.index) return report;

  const beforeOpinion = report.slice(0, opinionMatch.index).trimEnd();
  const opinion = report.slice(opinionMatch.index);
  const lines = beforeOpinion.split("\n");
  const firstFindingIndex = lines.findIndex((line) => line.trim().startsWith("- "));
  if (firstFindingIndex < 0) return report;

  return [
    ...lines.slice(0, firstFindingIndex),
    findingsBlock,
  ].join("\n") + opinion;
}

async function defaultInsertBrowserReportReview(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await supabase.from("report_reviews").insert(row).select("id").single();
  if (error) console.warn("[generate-report] review record insert failed:", error.message);
  return data?.id ?? null;
}

/**
 * Prepare the browser's existing Checklist/default auto-match stream.
 *
 * HTTP parsing/authentication/validation and SSE byte serialization stay in
 * app/api/generate-report/route.ts. This function preserves the Checklist
 * business sequence, including its historical report_chars: 0 usage row and
 * stream-local refund ownership. The blocking Desktop function below remains
 * separate because its provider/error/response semantics are intentionally
 * different.
 */
export async function prepareBrowserAutoMatchedReport(
  user: { id: string; email?: string | null },
  input: BrowserAutoMatchInput,
  deps: GenerationDeps,
): Promise<BrowserAutoMatchPreparation> {
  const { supabase } = deps;
  const checkReportRateLimitFn = deps.checkReportRateLimit ?? checkReportRateLimit;
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const getOrCreateUsageFn = deps.getOrCreateUsage ?? getOrCreateUsage;
  const reserveCreditsFn = deps.reserveCredits ?? reserveCredits;
  const refundCreditsFn = deps.refundCredits ?? refundCredits;
  const loadDatabaseAbbreviationsFn = deps.loadDatabaseAbbreviations ?? loadDatabaseAbbreviations;
  const matchTemplatesFn = deps.matchTemplates ?? matchTemplates;
  const canUseFeatureFn = deps.canUseFeature ?? canUseFeature;
  const buildPromptFn = deps.buildPrompt ?? buildPrompt;
  const logReportUsageFn = deps.logReportUsage ?? defaultLogReportUsage;
  const insertReportReviewFn = deps.insertReportReview ?? defaultInsertBrowserReportReview;

  const rateLimit = await checkReportRateLimitFn(user.id, supabase);
  if (rateLimit.limited) {
    return {
      ok: false,
      category: "rate-limited",
      retry_after_seconds: rateLimit.retryAfterSeconds,
    };
  }

  const sub = await getUserPlanFn(user.id);
  const usageRecord = await getOrCreateUsageFn(
    supabase,
    user.id,
    sub.plan,
    sub.current_period_end,
  );
  const creditCost = 1.0;

  if (usageRecord.credits_remaining < creditCost) {
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
  const databaseAbbreviations = await loadDatabaseAbbreviationsFn(
    supabase,
    modality,
    bodyRegion,
    studyType,
  );
  const mriTechniqueLines = modality === "MRI"
    ? getSkeleton(modality, bodyRegion, studyType || bodyRegion)?.technique
    : undefined;

  const inputPayload: MatchInput & { preserve_findings_order: boolean } = {
    modality,
    body_region: bodyRegion,
    indication: input.indication,
    findings: resolvePartialNormals(input.findings ?? ""),
    field_strength: input.field_strength || undefined,
    study_type: studyType,
    age: undefined,
    sex: undefined,
    laterality: input.laterality || undefined,
    report_header: input.report_header || undefined,
    opinion_hints: input.opinion_hints ?? "",
    preserve_findings_order: !!input.preserve_findings_order,
    template_guided: false,
    my_template_mode: false,
    template_edits: input.template_edits?.trim()
      ? (parseToPrompt(
          input.template_edits.trim(),
          modality,
          studyType || bodyRegion,
          databaseAbbreviations,
        ) || input.template_edits.trim())
      : undefined,
    mri_technique: mriTechniqueLines?.length ? mriTechniqueLines : undefined,
    normal_skeleton_findings: undefined,
    style_profile: null,
    style_examples: [],
  };

  let reserved = false;
  try {
    reserved = await reserveCreditsFn(supabase, user.id, CREDIT_MODE);
  } catch (reserveErr) {
    const msg = reserveErr instanceof Error ? reserveErr.message : "credit reservation failed";
    console.error("[generate-report] credit reservation error:", msg);
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
    const matchResult = await matchTemplatesFn(supabase, inputPayload);
    const hasPathologyMatch = matchResult.matched_templates.some(
      (template) => !isNormalTemplateRow(template),
    );
    if (
      hasPathologyMatch &&
      !(await canUseFeatureFn(user.id, sub.plan, "pathology_reports"))
    ) {
      throw new Error("This template requires a plan upgrade.");
    }

    const parsedFindings = parseToPrompt(
      inputPayload.findings ?? "",
      modality,
      bodyRegion,
      databaseAbbreviations,
    );
    const promptInput: MatchInput = {
      ...inputPayload,
      findings: parsedFindings || inputPayload.findings || "",
    };
    const { system, user: userMsg, staticInstructions } = buildPromptFn(
      matchResult.matched_templates,
      promptInput,
    );
    const anthropic = deps.anthropic ?? getAnthropic();

    return {
      ok: true,
      run: async (emit) => {
        let streamSucceeded = false;
        try {
          await emit({ type: "prelude", text: `: ${" ".repeat(2048)}\n\n` });

          const claudeStream = anthropic.messages.stream(
            {
              model: (ALLOWED_MODELS as readonly string[]).includes(input.model ?? "")
                ? (input.model as AllowedModel)
                : "claude-sonnet-4-6",
              max_tokens: 2048,
              temperature: 0.2,
              system: buildCachedSystemBlocks(system, staticInstructions),
              messages: [{ role: "user", content: userMsg }],
            },
            { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
          );

          let accumulatedText = "";
          for await (const event of claudeStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              accumulatedText += event.delta.text;
              await emit({ type: "delta", data: { t: event.delta.text } });
            }
          }

          const finalMessage = await claudeStream.finalMessage();
          const selectedModel: AllowedModel =
            (ALLOWED_MODELS as readonly string[]).includes(input.model ?? "")
              ? (input.model as AllowedModel)
              : "claude-sonnet-4-6";
          const inputTokens = finalMessage.usage.input_tokens;
          const outputTokens = finalMessage.usage.output_tokens;
          const cachedTokens = finalMessage.usage.cache_read_input_tokens ?? 0;
          const cacheCreationTokens = finalMessage.usage.cache_creation_input_tokens ?? 0;
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
              templates_used: matchResult.matched_templates.length,
              report_chars: 0,
            });
          } catch (logError) {
            console.error("[usage-log] checklist insert failed:", logError);
          }

          console.log("TOKENS", {
            input: inputTokens,
            output: outputTokens,
            cached: cachedTokens,
            cache_creation: cacheCreationTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          const findingsOrderedReport = input.preserve_findings_order
            ? enforceBrowserFindingsOrder(accumulatedText, input.findings)
            : accumulatedText;
          const reportTextPreClean = enforceOpinionOrder(
            findingsOrderedReport,
            input.opinion_hints ?? "",
            input.residual_opinion_hints ?? "",
          );
          const finalReportText = cleanGeneratedReportText(reportTextPreClean);
          const templateNames = matchResult.matched_templates.map(
            (template) => template.pathology_name || template.file_name,
          );

          const reviewId = await insertReportReviewFn(supabase, {
            user_id: user.id,
            user_email: user.email ?? null,
            modality,
            body_region: bodyRegion,
            study_type: studyType ?? null,
            report_mode: REPORT_MODE,
            model: selectedModel,
            category: matchResult.pathology_category,
            template_names: templateNames,
            original_report: finalReportText,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          await emit({
            type: "done",
            data: {
              final_report: finalReportText,
              review_id: reviewId,
              credits_remaining: Math.max(0, usageRecord.credits_remaining - creditCost),
              credits_limit: usageRecord.credits_limit,
              confidence: matchResult.match_confidence,
              category: matchResult.pathology_category,
              template_names: templateNames,
              style_validation: null,
            },
          });
          streamSucceeded = true;
        } catch (pumpError) {
          const errorMessage = pumpError instanceof Error
            ? pumpError.message
            : "Streaming failed";
          if (!streamSucceeded) {
            try {
              await refundCreditsFn(supabase, user.id, CREDIT_MODE);
            } catch (refundError) {
              console.error(
                `CRITICAL: refundCredits FAILED after checklist stream error. user=${user.id} mode=${REPORT_MODE} err=${refundError instanceof Error ? refundError.message : refundError}`,
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
        `[generate-report] CRITICAL: refund_credits FAILED after an unsuccessful generation — user ${user.id} was charged ${creditCost} for a failed report and needs a manual refund: ${refundMessage}`,
      );
    }
    return { ok: false, category: "setup-error", message };
  }
}

export async function generateAutoMatchedReport(
  user: { id: string; email?: string | null },
  input: DesktopReportRequest,
  deps: GenerationDeps,
): Promise<GenerationResult> {
  const { supabase } = deps;
  const matchTemplatesFn = deps.matchTemplates ?? matchTemplates;
  const buildPromptFn = deps.buildPrompt ?? buildPrompt;
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const getOrCreateUsageFn = deps.getOrCreateUsage ?? getOrCreateUsage;
  const reserveCreditsFn = deps.reserveCredits ?? reserveCredits;
  const refundCreditsFn = deps.refundCredits ?? refundCredits;
  const checkReportRateLimitFn = deps.checkReportRateLimit ?? checkReportRateLimit;
  const canUseFeatureFn = deps.canUseFeature ?? canUseFeature;
  const loadDatabaseAbbreviationsFn = deps.loadDatabaseAbbreviations ?? loadDatabaseAbbreviations;
  const logReportUsageFn = deps.logReportUsage ?? defaultLogReportUsage;
  const insertReportReviewFn = deps.insertReportReview ?? defaultInsertReportReview;

  const modality = input.modality?.trim();
  const body_region = input.body_region?.trim();
  const indication = input.indication?.trim() ?? "";
  const study_type = input.study_type?.trim() || undefined;
  const field_strength = input.field_strength?.trim() || undefined;

  if (!modality || !body_region || !input.findings?.trim()) {
    return fail("validation-error", "modality, body_region, and findings are required.");
  }

  const findingsStrip = stripPlaceholderSyntax(input.findings ?? "");
  const findings = findingsStrip.result;

  const age = typeof input.age === "number" && Number.isInteger(input.age) && input.age >= 0 && input.age <= 130
    ? input.age
    : undefined;
  const sex = input.sex === "Male" || input.sex === "Female" ? input.sex : undefined;

  const selectedModel: AllowedModel = (ALLOWED_MODELS as readonly string[]).includes(input.model ?? "")
    ? (input.model as AllowedModel)
    : "claude-sonnet-4-6";

  const hasLateralityValue = typeof input.laterality === "string" ? input.laterality.trim().length > 0 : false;
  const normalizedLaterality = normalizeLaterality(input.laterality);
  if (hasLateralityValue && !normalizedLaterality) {
    return fail("validation-error", "Laterality must be right, left, or bilateral.");
  }
  if (isPairedStudyType(study_type) && !normalizedLaterality) {
    return fail("validation-error", "Select right, left, or bilateral for this study type.");
  }
  const effectiveLaterality = normalizedLaterality && isPairedStudyType(study_type) ? normalizedLaterality : undefined;

  const rateLimit = await checkReportRateLimitFn(user.id, supabase);
  if (rateLimit.limited) {
    return fail("rate-limited", "Too many report generations in a short period. Please wait and try again.", {
      retry_after_seconds: rateLimit.retryAfterSeconds,
    });
  }

  const sub = await getUserPlanFn(user.id);
  const usageRecord = await getOrCreateUsageFn(supabase, user.id, sub.plan, sub.current_period_end);
  const creditCost = 1.0; // CREDIT_COST[CREDIT_MODE] — "fast" costs 1.0 credit today.

  if (usageRecord.credits_remaining < creditCost) {
    return fail("insufficient-credits", "Not enough credits remain this billing period.", {
      credits_remaining: usageRecord.credits_remaining,
      credits_limit: usageRecord.credits_limit,
    });
  }

  const databaseAbbreviations = await loadDatabaseAbbreviationsFn(supabase, modality, body_region, study_type);
  const mriTechniqueLines = modality === "MRI"
    ? getSkeleton(modality, body_region, study_type || body_region)?.technique
    : undefined;

  const inputPayload: MatchInput = {
    modality,
    body_region,
    indication,
    findings: resolvePartialNormals(findings),
    field_strength,
    study_type,
    age,
    sex,
    laterality: effectiveLaterality,
    opinion_hints: "",
    template_guided: false,
    my_template_mode: false,
    mri_technique: mriTechniqueLines?.length ? mriTechniqueLines : undefined,
  };

  let reserved = false;
  try {
    reserved = await reserveCreditsFn(supabase, user.id, CREDIT_MODE);
  } catch (reserveErr) {
    const msg = reserveErr instanceof Error ? reserveErr.message : "credit reservation failed";
    console.error("[desktop-generate-report] credit reservation error:", msg);
    return fail("provider-error", "Could not reserve credits for this request.");
  }
  if (!reserved) {
    return fail("insufficient-credits", "Not enough credits remain this billing period.", {
      credits_remaining: 0,
      credits_limit: usageRecord.credits_limit,
    });
  }

  let generationSucceeded = false;
  try {
    const matchResult = await matchTemplatesFn(supabase, inputPayload);

    const hasPathologyMatch = matchResult.matched_templates.some((t) => !isNormalTemplateRow(t));
    if (hasPathologyMatch && !(await canUseFeatureFn(user.id, sub.plan, "pathology_reports"))) {
      return fail("upgrade-required", "This template requires a plan upgrade.");
    }

    const parsedFindings = parseToPrompt(inputPayload.findings ?? "", modality, body_region, databaseAbbreviations);
    const promptInput: MatchInput = { ...inputPayload, findings: parsedFindings || inputPayload.findings || "" };
    const { system, user: userMsg, staticInstructions } = buildPromptFn(matchResult.matched_templates, promptInput);

    const anthropic = deps.anthropic ?? getAnthropic();
    let message;
    try {
      message = await anthropic.messages.create(
        {
          model: selectedModel,
          max_tokens: 2048,
          temperature: 0.2,
          system: buildCachedSystemBlocks(system, staticInstructions),
          messages: [{ role: "user", content: userMsg }],
        },
        { headers: { "anthropic-beta": "prompt-caching-2024-07-31" }, signal: deps.signal },
      );
    } catch (providerErr) {
      if (providerErr instanceof Anthropic.APIUserAbortError) {
        // The Desktop client disconnected (its own client-side timeout, most
        // commonly). generationSucceeded is still false here, so the
        // existing finally block below refunds the reserved credit exactly
        // as any other pre-success failure does -- no separate refund path
        // needed for this case.
        return fail("aborted", "The request was cancelled before the report finished generating.");
      }
      const isTimeout = providerErr instanceof Error && /timeout|timed out/i.test(providerErr.message);
      return fail(
        isTimeout ? "timeout" : "provider-error",
        isTimeout ? "The report generation request timed out." : "The report generation provider returned an error.",
      );
    }

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cachedTokens = message.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = message.usage.cache_creation_input_tokens ?? 0;

    const reportTextRaw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    const estimatedCostUsd = calculateAnthropicCost({
      model: selectedModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cachedTokens,
    }).estimated_cost_usd;
    console.log("TOKENS", { input: inputTokens, output: outputTokens, cached: cachedTokens, cache_creation: cacheCreationTokens, estimated_cost_usd: estimatedCostUsd });

    const reportTextPreClean = enforceOpinionOrder(reportTextRaw, "", "");
    const finalReportText = cleanGeneratedReportText(reportTextPreClean);

    if (!finalReportText.trim()) {
      return fail("provider-error", "The report generation provider returned an empty report.");
    }

    try {
      await logReportUsageFn(supabase, {
        user_id: user.id,
        model: selectedModel,
        mode: REPORT_MODE,
        modality,
        body_region,
        study_type: study_type ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        estimated_cost_usd: estimatedCostUsd,
        templates_used: matchResult.matched_templates.length,
        report_chars: finalReportText.length,
      });
    } catch (err) {
      console.error("[desktop-generate-report] usage log insert failed:", err instanceof Error ? err.message : err);
    }

    let reviewId: string | null = null;
    try {
      reviewId = await insertReportReviewFn(supabase, {
        user_id: user.id,
        user_email: user.email ?? null,
        modality,
        body_region,
        study_type: study_type ?? null,
        report_mode: REPORT_MODE,
        model: selectedModel,
        category: matchResult.pathology_category,
        template_names: matchResult.matched_templates.map((t) => t.pathology_name || t.file_name),
        original_report: finalReportText,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        estimated_cost_usd: estimatedCostUsd,
      });
    } catch (err) {
      console.error("[desktop-generate-report] review insert threw:", err instanceof Error ? err.message : err);
    }

    generationSucceeded = true;

    return {
      ok: true,
      report: finalReportText,
      model: selectedModel,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens, estimated_cost_usd: estimatedCostUsd },
      credits: { remaining: Math.max(0, usageRecord.credits_remaining - creditCost), limit: usageRecord.credits_limit },
      mode: REPORT_MODE,
      category: matchResult.pathology_category,
      confidence: matchResult.match_confidence,
      templates_used: matchResult.matched_templates.length,
      template_names: matchResult.matched_templates.map((t) => t.pathology_name || t.file_name),
      review_id: reviewId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[desktop-generate-report] error:", message);
    return fail("provider-error", "Report generation failed.");
  } finally {
    if (!generationSucceeded) {
      try {
        await refundCreditsFn(supabase, user.id, CREDIT_MODE);
      } catch (refundErr) {
        console.error(
          `[desktop-generate-report] CRITICAL: refundCredits FAILED after an unsuccessful generation — user ${user.id} was charged ${creditCost} for a failed report and needs a manual refund: ${refundErr instanceof Error ? refundErr.message : refundErr}`,
        );
      }
    }
  }
}

