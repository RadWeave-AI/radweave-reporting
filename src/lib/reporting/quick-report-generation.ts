/**
 * Browser Quick Report orchestration.
 *
 * Authentication, request parsing, HTTP status mapping, TransformStream
 * ownership, and SSE byte serialization stay in app/api/generate-report/route.ts.
 * This module owns the Quick Report application workflow and emits semantic
 * events so the route remains a transport adapter.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseToPrompt } from "@/lib/ai/abbreviation-parser";
import { calculateAnthropicCost } from "@/lib/ai/anthropic-cost";
import { canUseFeature } from "@/lib/features/access";
import { enforceOpinionOrder } from "@/lib/reporting/opinion-order";
import {
  ALLOWED_MODELS,
  buildCachedSystemBlocks,
  checkReportRateLimit,
  getAnthropic,
  resolvePartialNormals,
  type AllowedModel,
} from "@/lib/reporting/kernel";
import { persistReportUsageWithRetry } from "@/lib/reporting/usage-log-persistence";
import { getSkeleton, type Skeleton } from "@/lib/skeletons/skeletons";
import { getUserPlan } from "@/lib/stripe/get-user-plan";
import { isNormalTemplateRow } from "@/lib/templates/normal-template";
import {
  matchTemplates,
  type MatchedTemplate,
  type MatchInput,
  type MatchResult,
} from "@/lib/templates/matcher";
import {
  buildQuickReportPrompt,
  cleanTemplateText,
  type QuickReportPromptInput,
} from "@/lib/templates/prompt_builder";
import { isRegionMismatch } from "@/lib/templates/region-match";
import { reorderQuickReportBullets } from "@/lib/templates/reorder";
import { expandForSegmentMatching, selectSegmentForFinding } from "@/lib/templates/segment";
import { getOrCreateUsage, refundCredits, reserveCredits } from "@/lib/usage/credits";

const CREDIT_MODE = "fast" as const;
const REPORT_MODE = "quick_report";
const REVIEW_MODE = "quick";
const CREDIT_COST = 1.0;

export interface QuickReportGenerationInput {
  modality: string;
  body_region: string;
  indication: string;
  findings: string;
  field_strength?: string;
  study_type?: string;
  laterality?: string;
  age?: number;
  sex?: "Male" | "Female";
  model?: string;
  opinion_hints?: string;
  residual_opinion_hints?: string;
  preserve_findings_order?: boolean;
}

export type QuickReportGenerationEvent =
  | { type: "prelude"; text: string }
  | { type: "delta"; data: { t: string } }
  | {
      type: "done";
      data: {
        final_report: string;
        review_id: string | null;
        credits_remaining: number;
        credits_limit: number;
        confidence: "high" | "medium" | "low";
        category: string;
        style_validation: null;
      };
    }
  | { type: "error"; data: { error: string } };

export type QuickReportPreparation =
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
      run: (emit: (event: QuickReportGenerationEvent) => Promise<void>) => Promise<void>;
    };

interface QuickReorderResult {
  text: string;
  reordered: boolean;
  ambiguous: boolean;
}

export interface QuickReportGenerationDeps {
  supabase: SupabaseClient;
  anthropic?: Pick<Anthropic, "messages">;
  checkReportRateLimit?: typeof checkReportRateLimit;
  getUserPlan?: typeof getUserPlan;
  getOrCreateUsage?: typeof getOrCreateUsage;
  getSkeleton?: (modality: string, bodyRegion: string, studyType: string) => Skeleton | null;
  reserveCredits?: typeof reserveCredits;
  refundCredits?: typeof refundCredits;
  canUseFeature?: typeof canUseFeature;
  matchTemplates?: typeof matchTemplates;
  isNormalTemplateRow?: typeof isNormalTemplateRow;
  isRegionMismatch?: typeof isRegionMismatch;
  cleanTemplateText?: typeof cleanTemplateText;
  expandForSegmentMatching?: typeof expandForSegmentMatching;
  selectSegmentForFinding?: typeof selectSegmentForFinding;
  parseToPrompt?: typeof parseToPrompt;
  buildQuickReportPrompt?: typeof buildQuickReportPrompt;
  reorderQuickReportBullets?: (
    reportText: string,
    typedFindingLines: string[],
    modality: string,
    region: string,
  ) => QuickReorderResult;
  logReportUsage?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<void>;
  insertReportReview?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<string | null>;
}

async function defaultLogReportUsage(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
) {
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

function cleanQuickReport(reportTextPreClean: string): string {
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

export async function matchQuickStyleReferences(
  user: { id: string },
  plan: string,
  inputPayload: MatchInput,
  deps: {
    supabase: SupabaseClient;
    canUseFeature: typeof canUseFeature;
    matchTemplates: typeof matchTemplates;
    isNormalTemplateRow: typeof isNormalTemplateRow;
    isRegionMismatch: typeof isRegionMismatch;
    cleanTemplateText: typeof cleanTemplateText;
    expandForSegmentMatching: typeof expandForSegmentMatching;
    selectSegmentForFinding: typeof selectSegmentForFinding;
  },
): Promise<MatchResult> {
  try {
    const quickFindingLines = (inputPayload.findings ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const hasPathologyAccess = await deps.canUseFeature(
      user.id,
      plan,
      "pathology_reports",
    );

    if (quickFindingLines.length === 0) {
      const quickMatch = await deps.matchTemplates(deps.supabase, inputPayload);
      const gatedTemplates = hasPathologyAccess
        ? quickMatch.matched_templates
        : quickMatch.matched_templates.filter(deps.isNormalTemplateRow);
      return {
        matched_templates: gatedTemplates.slice(0, 8),
        match_confidence: quickMatch.match_confidence,
        pathology_category: "Quick Report",
        query_terms: quickMatch.query_terms,
      };
    }

    const queryRegion = inputPayload.study_type || inputPayload.body_region;
    const perFindingResults = await Promise.all(
      quickFindingLines.map(async (findingLine) => {
        try {
          const quickMatch = await deps.matchTemplates(
            deps.supabase,
            { ...inputPayload, findings: findingLine },
            { limit: 20 },
          );
          const gatedTemplates = hasPathologyAccess
            ? quickMatch.matched_templates
            : quickMatch.matched_templates.filter(deps.isNormalTemplateRow);
          const topTemplate = gatedTemplates.find((candidate) => !deps.isRegionMismatch(
            `${candidate.file_name} ${candidate.pathology_name} ${candidate.pathology_category}`,
            queryRegion,
          ));
          if (!topTemplate) return { quickMatch, matchedTemplate: null };

          const cleanFindingsText = deps.cleanTemplateText(topTemplate.findings_text ?? "");
          const segmentMatchingFinding = deps.expandForSegmentMatching(
            findingLine,
            inputPayload.modality,
            queryRegion,
          ) || findingLine;
          const selectedSegment = deps.selectSegmentForFinding(
            segmentMatchingFinding,
            cleanFindingsText,
            deps.cleanTemplateText(topTemplate.opinion_text ?? ""),
            deps.cleanTemplateText(topTemplate.full_text ?? ""),
          );

          return {
            quickMatch,
            matchedTemplate: {
              ...topTemplate,
              matched_segment_findings: selectedSegment?.findings ?? cleanFindingsText,
              matched_segment_opinion: selectedSegment?.opinion ?? null,
            },
          };
        } catch (quickFindingMatchError) {
          console.warn(
            "[generate-report] quick-report per-finding style-reference match failed (non-fatal, skipping finding):",
            quickFindingMatchError instanceof Error
              ? quickFindingMatchError.message
              : quickFindingMatchError,
          );
          return null;
        }
      }),
    );

    const successfulResults = perFindingResults.filter(
      (result): result is NonNullable<typeof result> => result !== null,
    );
    const deduplicatedTemplates: MatchedTemplate[] = [];
    const seenSegments = new Set<string>();
    for (const result of successfulResults) {
      if (!result.matchedTemplate) continue;
      const segmentKey = result.matchedTemplate.matched_segment_findings ?? "";
      if (seenSegments.has(segmentKey)) continue;
      seenSegments.add(segmentKey);
      deduplicatedTemplates.push(result.matchedTemplate);
    }

    const matchConfidence = successfulResults.some(
      ({ quickMatch }) => quickMatch.match_confidence === "high",
    )
      ? "high" as const
      : successfulResults.some(({ quickMatch }) => quickMatch.match_confidence === "medium")
        ? "medium" as const
        : successfulResults.length > 0
          ? "low" as const
          : "high" as const;
    const queryTerms = Array.from(new Set(
      successfulResults.flatMap(({ quickMatch }) => quickMatch.query_terms),
    ));

    return {
      matched_templates: deduplicatedTemplates.slice(0, 8),
      match_confidence: matchConfidence,
      pathology_category: "Quick Report",
      query_terms: queryTerms,
    };
  } catch (quickMatchError) {
    console.warn(
      "[generate-report] quick-report style-reference match failed (non-fatal, falling back to skeleton-only):",
      quickMatchError instanceof Error ? quickMatchError.message : quickMatchError,
    );
    return {
      matched_templates: [],
      match_confidence: "high",
      pathology_category: "Quick Report",
      query_terms: [],
    };
  }
}

export async function prepareQuickReport(
  user: { id: string; email?: string | null },
  input: QuickReportGenerationInput,
  deps: QuickReportGenerationDeps,
): Promise<QuickReportPreparation> {
  const { supabase } = deps;
  const checkReportRateLimitFn = deps.checkReportRateLimit ?? checkReportRateLimit;
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const getOrCreateUsageFn = deps.getOrCreateUsage ?? getOrCreateUsage;
  const getSkeletonFn = deps.getSkeleton ?? getSkeleton;
  const reserveCreditsFn = deps.reserveCredits ?? reserveCredits;
  const refundCreditsFn = deps.refundCredits ?? refundCredits;
  const canUseFeatureFn = deps.canUseFeature ?? canUseFeature;
  const matchTemplatesFn = deps.matchTemplates ?? matchTemplates;
  const isNormalTemplateRowFn = deps.isNormalTemplateRow ?? isNormalTemplateRow;
  const isRegionMismatchFn = deps.isRegionMismatch ?? isRegionMismatch;
  const cleanTemplateTextFn = deps.cleanTemplateText ?? cleanTemplateText;
  const expandForSegmentMatchingFn = deps.expandForSegmentMatching ?? expandForSegmentMatching;
  const selectSegmentForFindingFn = deps.selectSegmentForFinding ?? selectSegmentForFinding;
  const parseToPromptFn = deps.parseToPrompt ?? parseToPrompt;
  const buildQuickReportPromptFn = deps.buildQuickReportPrompt ?? buildQuickReportPrompt;
  const reorderQuickReportBulletsFn = deps.reorderQuickReportBullets ?? reorderQuickReportBullets;
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
  const quickReportSkeleton = getSkeletonFn(
    modality,
    bodyRegion,
    studyType || bodyRegion,
  );
  const mriTechniqueLines = modality === "MRI" && quickReportSkeleton?.technique?.length
    ? quickReportSkeleton.technique
    : undefined;
  const inputPayload: MatchInput & { preserve_findings_order: boolean } = {
    modality,
    body_region: bodyRegion,
    indication: input.indication,
    findings: resolvePartialNormals(input.findings ?? ""),
    field_strength: input.field_strength || undefined,
    study_type: studyType,
    age: input.age,
    sex: input.sex,
    laterality: input.laterality,
    report_header: quickReportSkeleton?.title || undefined,
    opinion_hints: input.opinion_hints ?? "",
    preserve_findings_order: !!input.preserve_findings_order,
    template_guided: false,
    my_template_mode: false,
    template_edits: undefined,
    mri_technique: mriTechniqueLines,
    normal_skeleton_findings: quickReportSkeleton?.findings?.length
      ? quickReportSkeleton.findings
      : undefined,
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
    const matchResult = await matchQuickStyleReferences(user, sub.plan, inputPayload, {
      supabase,
      canUseFeature: canUseFeatureFn,
      matchTemplates: matchTemplatesFn,
      isNormalTemplateRow: isNormalTemplateRowFn,
      isRegionMismatch: isRegionMismatchFn,
      cleanTemplateText: cleanTemplateTextFn,
      expandForSegmentMatching: expandForSegmentMatchingFn,
      selectSegmentForFinding: selectSegmentForFindingFn,
    });
    const parsedFindings = parseToPromptFn(
      input.findings ?? "",
      modality,
      bodyRegion,
      [],
    );
    const promptInput: QuickReportPromptInput & { preserve_findings_order: boolean } = {
      ...inputPayload,
      findings: parsedFindings || inputPayload.findings || "",
      style_reference_templates: matchResult.matched_templates,
    };
    const { system, user: userMessage, staticInstructions } =
      buildQuickReportPromptFn(promptInput);
    const anthropic = deps.anthropic ?? getAnthropic();
    const selectedModel: AllowedModel = (ALLOWED_MODELS as readonly string[]).includes(input.model ?? "")
      ? (input.model as AllowedModel)
      : "claude-sonnet-4-6";

    return {
      ok: true,
      run: async (emit) => {
        let streamSucceeded = false;
        let accumulatedText = "";
        try {
          await emit({ type: "prelude", text: `: ${" ".repeat(2048)}\n\n` });

          const claudeStream = anthropic.messages.stream(
            {
              model: selectedModel,
              max_tokens: 2048,
              temperature: 0.2,
              system: buildCachedSystemBlocks(system, staticInstructions),
              messages: [{ role: "user", content: userMessage }],
            },
            { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
          );

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
              templates_used: 0,
              report_chars: 0,
            });
          } catch (usageError) {
            console.error("[usage-log] quick_report insert failed:", usageError);
          }
          console.log("TOKENS (stream/quick)", {
            input: inputTokens,
            output: outputTokens,
            cached: cachedTokens,
            cache_creation: cacheCreationTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          const reportTextPreClean = enforceOpinionOrder(
            accumulatedText,
            input.opinion_hints ?? "",
            input.residual_opinion_hints ?? "",
          );
          const finalReportText = cleanQuickReport(reportTextPreClean);
          const quickFindingLinesForReorder = (inputPayload.findings ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const reorderResult = reorderQuickReportBulletsFn(
            finalReportText,
            quickFindingLinesForReorder,
            inputPayload.modality,
            inputPayload.study_type || inputPayload.body_region,
          );
          if (reorderResult.ambiguous) {
            console.log("[generate-report] quick-report bullet reorder: ambiguous, left unchanged");
          } else if (reorderResult.reordered) {
            console.log("[generate-report] quick-report bullet reorder: applied");
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
            template_names: [] as string[],
            original_report: reorderResult.text,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            estimated_cost_usd: estimatedCostUsd,
          });

          await emit({
            type: "done",
            data: {
              final_report: reorderResult.text,
              review_id: reviewId,
              credits_remaining: Math.max(0, usageRecord.credits_remaining - CREDIT_COST),
              credits_limit: usageRecord.credits_limit,
              confidence: matchResult.match_confidence,
              category: matchResult.pathology_category,
              style_validation: null,
            },
          });
          streamSucceeded = true;
        } catch (pumpError) {
          const errorMessage = pumpError instanceof Error
            ? pumpError.message
            : "Streaming failed";
          console.error("[generate-report] stream pump error:", errorMessage);
          if (!streamSucceeded) {
            try {
              await refundCreditsFn(supabase, user.id, CREDIT_MODE);
            } catch (refundError) {
              console.error(
                `[generate-report] CRITICAL: refundCredits FAILED after stream pump error — ` +
                `user ${user.id} charged ${CREDIT_COST} credits for a failed report (needs manual refund): ` +
                (refundError instanceof Error ? refundError.message : String(refundError)),
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

