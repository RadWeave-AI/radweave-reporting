/**
 * Browser Template-guided Report orchestration.
 *
 * Authentication, request parsing, HTTP status mapping, TransformStream
 * ownership, and SSE byte serialization stay in app/api/generate-report/route.ts.
 * This module owns the Template-guided application workflow and emits
 * semantic events so the route remains a transport adapter.
 *
 * Two-provider-call workflow: the first Anthropic call is streamed and the
 * user sees its deltas live. A second, blocking correction call runs ONLY
 * when the streamed report fails strict-style validation against curated
 * template_edits phrases (see lib/ai/strict-style.ts) — never unconditionally.
 * Both calls' token usage are aggregated (lib/ai/anthropic-cost.ts) into one
 * total before cost is calculated and persisted exactly once.
 *
 * Template trust boundary (preserved, not redesigned): the browser supplies
 * only an opaque selected_template_id. The server resolves it either against
 * the built-in skeleton-normal library or a real row in the shared `templates`
 * table (which has no user_id column — it is a global, admin-curated library,
 * not user-owned data) — content is never client-supplied. Hidden/deleted
 * rows are rejected and non-normal templates require the pathology_reports
 * plan feature. This module does not add or change any of that.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseToPrompt } from "../ai/abbreviation-parser.ts";
import { calculateAnthropicCost, aggregateAnthropicUsage } from "../ai/anthropic-cost.ts";
import {
  buildStrictCorrectionPrompt,
  enforceStrictStyle,
  extractStrictStyleRequirements,
  validateStrictStyle,
} from "../ai/strict-style.ts";
import { loadDatabaseAbbreviations } from "../ai/database-abbreviations.ts";
import { canUseFeature } from "../features/access.ts";
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
import { getSkeleton, type Skeleton } from "../skeletons/skeletons.ts";
import { getUserPlan } from "../stripe/get-user-plan.ts";
import { isNormalTemplateRow } from "../templates/normal-template.ts";
import { buildPrompt } from "../templates/prompt_builder.ts";
import type { MatchedTemplate, MatchInput } from "../templates/matcher.ts";
import {
  getOrCreateUsage,
  refundCredits,
  reserveCredits,
} from "../usage/credits.ts";

const CREDIT_MODE = "fast" as const;
const REPORT_MODE = "template_guided";
// Preserved intentionally — report_reviews.report_mode uses "template" while
// report_usage_logs.mode uses "template_guided". A pre-existing naming
// inconsistency between the two tables; not this extraction's job to fix.
const REVIEW_MODE = "template";
const CREDIT_COST = 1.0;

export interface TemplateGuidedGenerationInput {
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
  selected_template_id: string;
  template_edits?: string;
}

export type TemplateGuidedGenerationEvent =
  | { type: "prelude"; text: string }
  | { type: "delta"; data: { t: string } }
  | { type: "status"; data: { msg: string } }
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
        style_validation: {
          passed: boolean;
          corrected: boolean;
          issues: string[];
          unknown_tokens: string[];
        };
      };
    }
  | { type: "error"; data: { error: string } };

export type TemplateGuidedGenerationPreparation =
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
      run: (emit: (event: TemplateGuidedGenerationEvent) => Promise<void>) => Promise<void>;
    };

interface SelectedTemplateRow {
  id: string;
  file_name: string;
  body_region: string;
  modality: string;
  pathology_category: string | null;
  pathology_name: string | null;
  findings_text: string;
  opinion_text: string;
  full_text: string;
  keywords: string[];
  is_hidden: boolean;
  deleted_at: string | null;
  is_normal?: boolean;
}

export interface TemplateGuidedGenerationDeps {
  supabase: SupabaseClient;
  anthropic?: Pick<Anthropic, "messages">;
  checkReportRateLimit?: typeof checkReportRateLimit;
  getUserPlan?: typeof getUserPlan;
  getOrCreateUsage?: typeof getOrCreateUsage;
  loadDatabaseAbbreviations?: typeof loadDatabaseAbbreviations;
  getSkeleton?: typeof getSkeleton;
  reserveCredits?: typeof reserveCredits;
  refundCredits?: typeof refundCredits;
  canUseFeature?: typeof canUseFeature;
  isNormalTemplateRow?: typeof isNormalTemplateRow;
  parseToPrompt?: typeof parseToPrompt;
  buildPrompt?: typeof buildPrompt;
  fetchSelectedTemplate?: (
    supabase: SupabaseClient,
    selectedTemplateId: string,
    modality: string,
  ) => Promise<SelectedTemplateRow>;
  logReportUsage?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<void>;
  insertReportReview?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<string | null>;
}

function replaceSidePlaceholder(text: string, laterality?: string) {
  return text
    .replace(/\[SIDE\]/g, laterality?.toUpperCase() ?? "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([:,.])/g, "$1")
    .trim();
}

function skeletonFullText(
  getSkeletonFn: (modality: string, bodyRegion: string, studyType: string) => Skeleton | null,
  modality: string,
  bodyRegion: string,
  studyType: string,
  laterality?: string,
): string | null {
  const skeleton = getSkeletonFn(modality, bodyRegion, studyType);
  if (!skeleton) return null;

  const title = replaceSidePlaceholder(skeleton.title, laterality);
  if (modality === "MRI") {
    return [
      title,
      "",
      "MRI TECHNIQUE:",
      ...skeleton.technique.map((line) => `- ${replaceSidePlaceholder(line, laterality)}`),
      "",
      "MRI FINDINGS:",
      ...skeleton.findings.map((line) => `- ${replaceSidePlaceholder(line, laterality)}`),
      "",
      "OPINION:",
      `- ${replaceSidePlaceholder(skeleton.opinion, laterality)}`,
    ].join("\n");
  }

  return [
    title,
    ...skeleton.findings.map((line) => `- ${replaceSidePlaceholder(line, laterality)}`),
    "",
    "OPINION:",
    `- ${replaceSidePlaceholder(skeleton.opinion, laterality)}`,
  ].join("\n");
}

async function defaultFetchSelectedTemplate(
  supabase: SupabaseClient,
  selectedTemplateId: string,
  modality: string,
): Promise<SelectedTemplateRow> {
  const { data, error } = await supabase
    .from("templates")
    .select("id, file_name, body_region, modality, pathology_category, pathology_name, findings_text, opinion_text, full_text, keywords, is_hidden, deleted_at, is_normal")
    .eq("id", selectedTemplateId)
    .in("modality", [modality, `Normal ${modality}`])
    .single();

  if (error || !data) {
    throw new Error("Selected template was not found for this study.");
  }
  if (data.is_hidden || data.deleted_at) {
    throw new Error("Selected template was not found for this study.");
  }
  return data as SelectedTemplateRow;
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

function cleanTemplateGuidedReport(reportTextPreClean: string): string {
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

export async function prepareTemplateGuidedReport(
  user: { id: string; email?: string | null },
  input: TemplateGuidedGenerationInput,
  deps: TemplateGuidedGenerationDeps,
): Promise<TemplateGuidedGenerationPreparation> {
  const { supabase } = deps;
  const checkReportRateLimitFn = deps.checkReportRateLimit ?? checkReportRateLimit;
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const getOrCreateUsageFn = deps.getOrCreateUsage ?? getOrCreateUsage;
  const loadDatabaseAbbreviationsFn = deps.loadDatabaseAbbreviations ?? loadDatabaseAbbreviations;
  const getSkeletonFn = deps.getSkeleton ?? getSkeleton;
  const reserveCreditsFn = deps.reserveCredits ?? reserveCredits;
  const refundCreditsFn = deps.refundCredits ?? refundCredits;
  const canUseFeatureFn = deps.canUseFeature ?? canUseFeature;
  const isNormalTemplateRowFn = deps.isNormalTemplateRow ?? isNormalTemplateRow;
  const parseToPromptFn = deps.parseToPrompt ?? parseToPrompt;
  const buildPromptFn = deps.buildPrompt ?? buildPrompt;
  const fetchSelectedTemplateFn = deps.fetchSelectedTemplate ?? defaultFetchSelectedTemplate;
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

  // Called unconditionally to preserve current (pre-extraction) behavior —
  // Template-guided is the one workflow that genuinely consumes this result
  // (via template_edits parsing below), unlike My Template's dead call.
  const databaseAbbreviations = await loadDatabaseAbbreviationsFn(
    supabase,
    modality,
    bodyRegion,
    studyType,
  );

  const mriTechniqueLines: string[] | undefined = modality === "MRI"
    ? (() => {
        const sk = getSkeletonFn(modality, bodyRegion, studyType || bodyRegion);
        return sk?.technique?.length ? sk.technique : undefined;
      })()
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
    laterality: input.laterality,
    report_header: input.report_header || undefined,
    opinion_hints: input.opinion_hints ?? "",
    preserve_findings_order: !!input.preserve_findings_order,
    template_guided: true,
    my_template_mode: false,
    template_edits: input.template_edits?.trim()
      ? (parseToPromptFn(input.template_edits.trim(), modality, studyType || bodyRegion, databaseAbbreviations) || input.template_edits.trim())
      : undefined,
    mri_technique: mriTechniqueLines,
    normal_skeleton_findings: undefined,
    style_profile: null,
    style_examples: [],
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
    const selectedTemplateId = input.selected_template_id;
    const matchResult = selectedTemplateId.startsWith("skeleton-normal:")
      ? (() => {
          const fullText = skeletonFullText(
            getSkeletonFn, modality, bodyRegion, studyType || bodyRegion, input.laterality,
          );
          if (!fullText) throw new Error("Normal skeleton was not found for this study.");
          return {
            matched_templates: [{
              id: selectedTemplateId,
              file_name: `Built-in normal ${modality} ${studyType || bodyRegion}`,
              body_region: bodyRegion,
              modality,
              pathology_category: "Normal",
              pathology_name: "Normal report",
              findings_text: fullText,
              opinion_text: "Normal study.",
              full_text: fullText,
              keywords: ["normal", studyType || bodyRegion],
              relevance_score: 999,
            } as MatchedTemplate],
            match_confidence: "high" as const,
            pathology_category: "Normal",
            query_terms: [] as string[],
          };
        })()
      : await (async () => {
          const data = await fetchSelectedTemplateFn(supabase, selectedTemplateId, modality);
          if (!isNormalTemplateRowFn(data) && !(await canUseFeatureFn(user.id, sub.plan, "pathology_reports"))) {
            throw new Error("This template requires a plan upgrade.");
          }
          return {
            matched_templates: [{ ...data, relevance_score: 999 } as MatchedTemplate],
            match_confidence: "high" as const,
            pathology_category: data.pathology_category ?? "Selected template",
            query_terms: [] as string[],
          };
        })();

    // Template-guided skips parseToPrompt for its own findings (isTemplateMode
    // path) — the parsed value is simply the raw findings, which then
    // overrides inputPayload.findings (the resolvePartialNormals'd value) in
    // promptInput below. Preserved exactly, including this override.
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
              temperature: 0,
              system: buildCachedSystemBlocks(system, staticInstructions),
              messages: [{ role: "user", content: userMsg }],
            },
            { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
          );

          for await (const event of claudeStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              accText += event.delta.text;
              await emit({ type: "delta", data: { t: event.delta.text } });
            }
          }

          const finalMsg = await claudeStream.finalMessage();
          let aggregatedUsage = aggregateAnthropicUsage(finalMsg.usage);

          // Strict-style validation — same logic/functions as before extraction.
          const strictRequirements = extractStrictStyleRequirements(inputPayload.template_edits);
          let strictValidation = validateStrictStyle(accText, strictRequirements);
          let strictCorrected = false;
          let strictReport = accText;

          if (!strictValidation.passed && (
            strictValidation.missingFindings.length > 0 ||
            strictValidation.missingOpinions.length > 0
          )) {
            // Signal the client to show a brief "finalizing style" indicator.
            await emit({ type: "status", data: { msg: "finalizing_style" } });
            const correction = await anthropic.messages.create(
              {
                model: selectedModel,
                max_tokens: 2048,
                temperature: 0,
                system: buildCachedSystemBlocks("You are a strict radiology report editor. Obey protected wording exactly."),
                messages: [{
                  role: "user",
                  content: buildStrictCorrectionPrompt(strictReport, strictRequirements, strictValidation),
                }],
              },
              { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
            );
            strictReport = correction.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { type: "text"; text: string }).text)
              .join("\n");
            aggregatedUsage = aggregateAnthropicUsage(aggregatedUsage, correction.usage);
            strictCorrected = true;
            strictValidation = validateStrictStyle(strictReport, strictRequirements);
          }

          if (
            strictValidation.missingFindings.length > 0 ||
            strictValidation.missingOpinions.length > 0
          ) {
            strictReport = enforceStrictStyle(strictReport, strictRequirements);
            strictCorrected = true;
            strictValidation = validateStrictStyle(strictReport, strictRequirements);
          }

          const inputTokens = aggregatedUsage.input_tokens;
          const outputTokens = aggregatedUsage.output_tokens;
          const cachedTokens = aggregatedUsage.cache_read_input_tokens;
          const cacheCreationTokens = aggregatedUsage.cache_creation_input_tokens;
          const estimatedCostUsd = calculateAnthropicCost({
            model: selectedModel,
            ...aggregatedUsage,
          }).estimated_cost_usd;
          console.log("TOKENS", {
            input: inputTokens, output: outputTokens,
            cached: cachedTokens, cache_creation: cacheCreationTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          // Post-processing — opinion order, PARTIAL NORMAL strip, dedup.
          const reportTextPreClean = enforceOpinionOrder(strictReport, input.opinion_hints ?? "", input.residual_opinion_hints ?? "");
          const finalReportText = cleanTemplateGuidedReport(reportTextPreClean);

          try {
            await logReportUsageFn(supabase, {
              user_id: user.id,
              model: selectedModel,
              mode: REPORT_MODE,
              modality,
              body_region: bodyRegion,
              study_type: studyType ?? null,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cached_tokens: cachedTokens,
              estimated_cost_usd: estimatedCostUsd,
              templates_used: matchResult.matched_templates.length,
              report_chars: finalReportText.length,
            });
          } catch (usageError) {
            console.error("[usage-log] template_guided insert failed:", usageError);
          }

          const reviewId = await insertReportReviewFn(supabase, {
            user_id: user.id,
            user_email: user.email ?? null,
            modality,
            body_region: bodyRegion,
            study_type: studyType ?? null,
            report_mode: REVIEW_MODE,
            model: selectedModel,
            category: matchResult.pathology_category,
            template_names: matchResult.matched_templates.map((t) => t.pathology_name || t.file_name),
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
              credits_remaining: Math.max(0, usageRecord.credits_remaining - CREDIT_COST),
              credits_limit: usageRecord.credits_limit,
              confidence: matchResult.match_confidence,
              category: matchResult.pathology_category,
              template_names: matchResult.matched_templates.map((t) => t.pathology_name || t.file_name),
              style_validation: {
                passed: strictValidation.passed,
                corrected: strictCorrected,
                issues: strictValidation.issues,
                unknown_tokens: strictValidation.unknownTokens,
              },
            },
          });

          streamSucceeded = true;
        } catch (pumpError) {
          const errorMessage = pumpError instanceof Error
            ? pumpError.message
            : "Streaming failed";
          console.error("[generate-report] stream pump error (template-guided):", errorMessage);
          if (!streamSucceeded) {
            try {
              await refundCreditsFn(supabase, user.id, CREDIT_MODE);
            } catch (refundError) {
              console.error(
                `[generate-report] CRITICAL: refundCredits FAILED after template-guided stream pump error — ` +
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

