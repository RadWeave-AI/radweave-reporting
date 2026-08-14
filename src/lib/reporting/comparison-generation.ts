/**
 * Browser Comparison-report orchestration.
 *
 * Authentication, request parsing, HTTP status mapping, TransformStream
 * ownership, and SSE byte serialization stay in app/api/generate-report/route.ts.
 * This module owns the Comparison application workflow and emits semantic
 * events so the route remains a transport adapter.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseToPrompt } from "@/lib/ai/abbreviation-parser";
import { calculateAnthropicCost } from "@/lib/ai/anthropic-cost";
import { loadDatabaseAbbreviations } from "@/lib/ai/database-abbreviations";
import { getSkeleton } from "@/lib/skeletons/skeletons";
import { getUserPlan } from "@/lib/stripe/get-user-plan";
import type { MatchInput } from "@/lib/templates/matcher";
import {
  buildComparisonReportPrompt,
  type ComparisonBlock,
  type ComparisonPromptInput,
} from "@/lib/templates/prompt_builder";
import {
  getOrCreateUsage,
  refundCredits,
  reserveCredits,
} from "@/lib/usage/credits";
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

const CREDIT_MODE = "fast" as const;
const REPORT_MODE = "comparison";
const CREDIT_COST = 1.0;
const ALLOWED_COMPARISON_STATUSES = new Set([
  "stationary",
  "regressive",
  "progressive",
  "resolved",
  "new",
]);
const LEGACY_STATUS_ORDER = [
  "stationary",
  "regressive",
  "progressive",
  "resolved",
  "new",
] as const;

export interface ComparisonLegacyFinding {
  text: string;
  status: string;
  comment?: string;
}

export interface ComparisonLegacyNewFinding {
  text: string;
  comment?: string;
}

export interface ComparisonGenerationInput {
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
  prior_date: string;
  prior_opinion?: string;
  comparison_blocks?: ComparisonBlock[];
  annotated_findings?: ComparisonLegacyFinding[];
  new_findings?: ComparisonLegacyNewFinding[];
  stationary_phrasing?: string;
  new_phrasing?: string;
}

export type ComparisonGenerationEvent =
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
        category: "Comparison Report";
        template_names: string[];
        style_validation: null;
      };
    }
  | { type: "error"; data: { error: string } };

export type ComparisonPreparation =
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
      run: (emit: (event: ComparisonGenerationEvent) => Promise<void>) => Promise<void>;
    };

export interface ComparisonGenerationDeps {
  supabase: SupabaseClient;
  anthropic?: Pick<Anthropic, "messages">;
  checkReportRateLimit?: typeof checkReportRateLimit;
  getUserPlan?: typeof getUserPlan;
  getOrCreateUsage?: typeof getOrCreateUsage;
  reserveCredits?: typeof reserveCredits;
  refundCredits?: typeof refundCredits;
  loadDatabaseAbbreviations?: typeof loadDatabaseAbbreviations;
  parseToPrompt?: typeof parseToPrompt;
  getMriTechnique?: (
    modality: string,
    bodyRegion: string,
    studyType: string,
  ) => string[] | undefined;
  buildComparisonReportPrompt?: typeof buildComparisonReportPrompt;
  logReportUsage?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<void>;
  insertReportReview?: (
    supabase: SupabaseClient,
    row: Record<string, unknown>,
  ) => Promise<string | null>;
}

export function normalizeComparisonBlocks(
  blocks: ComparisonBlock[] | undefined,
): ComparisonBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];

  return blocks
    .map((block): ComparisonBlock | null => {
      if (block?.type === "group") {
        const status = block.status?.trim().toLowerCase() as ComparisonBlock["status"] | undefined;
        const findings = Array.isArray(block.findings)
          ? block.findings
              .filter((finding) => finding?.text?.trim())
              .map((finding) => ({
                text: finding.text.trim(),
                is_new: finding.is_new === true,
              }))
          : [];
        if (!status || !ALLOWED_COMPARISON_STATUSES.has(status) || findings.length === 0) {
          return null;
        }
        return {
          type: "group",
          status,
          header: block.header?.trim() || undefined,
          findings,
        };
      }
      if (block?.type === "loose" && block.text?.trim()) {
        return { type: "loose", text: block.text.trim() };
      }
      return null;
    })
    .filter((block): block is ComparisonBlock => block !== null);
}

export function hasComparisonContent(input: Pick<
  ComparisonGenerationInput,
  "comparison_blocks" | "annotated_findings" | "new_findings"
>): boolean {
  if (normalizeComparisonBlocks(input.comparison_blocks).length > 0) return true;
  if (Array.isArray(input.annotated_findings) && input.annotated_findings.some((finding) => finding?.text?.trim())) {
    return true;
  }
  return Array.isArray(input.new_findings) && input.new_findings.some((finding) => finding?.text?.trim());
}

function formatComparisonPriorDate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return trimmed;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function cleanComparisonReport(report: string): string {
  const lines = report
    .split("\n")
    .filter((line) => !/\[PARTIAL NORMAL/i.test(line));
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

async function defaultLogReportUsage(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  await persistReportUsageWithRetry(supabase, { id: crypto.randomUUID(), ...row }, { workflow: REPORT_MODE });
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

export async function prepareComparisonReport(
  user: { id: string; email?: string | null },
  input: ComparisonGenerationInput,
  deps: ComparisonGenerationDeps,
): Promise<ComparisonPreparation> {
  const { supabase } = deps;
  const checkReportRateLimitFn = deps.checkReportRateLimit ?? checkReportRateLimit;
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const getOrCreateUsageFn = deps.getOrCreateUsage ?? getOrCreateUsage;
  const reserveCreditsFn = deps.reserveCredits ?? reserveCredits;
  const refundCreditsFn = deps.refundCredits ?? refundCredits;
  const loadDatabaseAbbreviationsFn = deps.loadDatabaseAbbreviations ?? loadDatabaseAbbreviations;
  const parseToPromptFn = deps.parseToPrompt ?? parseToPrompt;
  const getMriTechniqueFn = deps.getMriTechnique ?? ((modality, bodyRegion, studyType) =>
    getSkeleton(modality, bodyRegion, studyType)?.technique);
  const buildComparisonReportPromptFn = deps.buildComparisonReportPrompt ?? buildComparisonReportPrompt;
  const logReportUsageFn = deps.logReportUsage ?? defaultLogReportUsage;
  const insertReportReviewFn = deps.insertReportReview ?? defaultInsertReportReview;

  const canonicalBlocks = normalizeComparisonBlocks(input.comparison_blocks);
  const annotatedFindings = Array.isArray(input.annotated_findings)
    ? input.annotated_findings.filter((finding) => finding?.text?.trim())
    : [];
  const newFindings = Array.isArray(input.new_findings)
    ? input.new_findings.filter((finding) => finding?.text?.trim())
    : [];

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
  const databaseAbbreviations = await loadDatabaseAbbreviationsFn(
    supabase,
    modality,
    bodyRegion,
    studyType,
  );
  const mriTechniqueLines = modality === "MRI"
    ? getMriTechniqueFn(modality, bodyRegion, studyType || bodyRegion)
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
    template_guided: false,
    my_template_mode: false,
    template_edits: undefined,
    mri_technique: mriTechniqueLines?.length ? mriTechniqueLines : undefined,
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
    const expandedFindings = parseToPromptFn(
      inputPayload.findings ?? "",
      modality,
      bodyRegion,
      databaseAbbreviations,
    );
    const stationaryHeader = `${input.stationary_phrasing?.trim() || "Rather stationary course"} regarding:`;
    const newHeader = `${input.new_phrasing?.trim() || "Newly developed"}:`;
    const headerForStatus = (status: NonNullable<ComparisonBlock["status"]>) => {
      if (status === "stationary") return stationaryHeader;
      if (status === "regressive") return "Regressive course regarding:";
      if (status === "progressive") return "Progressive course regarding:";
      if (status === "resolved") return "Resolution of:";
      return newHeader;
    };
    const expandComparisonText = (text: string) =>
      parseToPromptFn(text.trim(), modality, bodyRegion, databaseAbbreviations) || text.trim();
    const combineFindingAndComment = (text: string, comment?: string) => {
      const expandedText = expandComparisonText(text);
      const expandedComment = comment?.trim() ? expandComparisonText(comment) : "";
      return expandedComment ? `${expandedText}. ${expandedComment}` : expandedText;
    };

    const comparisonBlocksForPrompt: ComparisonBlock[] = canonicalBlocks.length > 0
      ? canonicalBlocks.map((block) => {
          if (block.type === "group") {
            const status = block.status!;
            return {
              type: "group",
              status,
              header: block.header?.trim() || headerForStatus(status),
              findings: (block.findings ?? []).map((finding) => ({
                text: finding.text.trim(),
                is_new: finding.is_new === true,
              })),
            };
          }
          return { type: "loose", text: block.text?.trim() ?? "" };
        })
      : LEGACY_STATUS_ORDER
          .map((status): ComparisonBlock | null => {
            const findings = [
              ...annotatedFindings
                .filter((finding) => finding.status?.trim().toLowerCase() === status)
                .map((finding) => ({
                  text: combineFindingAndComment(finding.text, finding.comment),
                })),
              ...(status === "new"
                ? newFindings.map((finding) => ({
                    text: combineFindingAndComment(finding.text, finding.comment),
                    is_new: true,
                  }))
                : []),
            ];
            if (findings.length === 0) return null;
            return {
              type: "group",
              status,
              header: headerForStatus(status),
              findings,
            };
          })
          .filter((block): block is ComparisonBlock => block !== null);

    const promptInput: ComparisonPromptInput = {
      ...inputPayload,
      findings: expandedFindings || inputPayload.findings || "",
      prior_date: formatComparisonPriorDate(input.prior_date),
      prior_opinion: input.prior_opinion?.trim() || undefined,
      comparison_blocks: comparisonBlocksForPrompt,
      stationary_phrasing: input.stationary_phrasing?.trim() || undefined,
      new_phrasing: input.new_phrasing?.trim() || undefined,
    };
    const { system, user: userMessage, staticInstructions } =
      buildComparisonReportPromptFn(promptInput);
    const anthropic = deps.anthropic ?? getAnthropic();
    const selectedModel: AllowedModel = (ALLOWED_MODELS as readonly string[]).includes(input.model ?? "")
      ? (input.model as AllowedModel)
      : "claude-sonnet-4-6";

    return {
      ok: true,
      run: async (emit) => {
        let streamSucceeded = false;
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
            console.error("[usage-log] comparison insert failed:", usageError);
          }
          console.log("TOKENS (stream/comparison)", {
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
          const finalReportText = cleanComparisonReport(reportTextPreClean);
          const reviewId = await insertReportReviewFn(supabase, {
            user_id: user.id,
            user_email: user.email ?? null,
            modality,
            body_region: bodyRegion,
            study_type: studyType ?? null,
            report_mode: REPORT_MODE,
            model: selectedModel,
            category: "Comparison Report",
            template_names: [] as string[],
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
              confidence: "high",
              category: "Comparison Report",
              template_names: [] as string[],
              style_validation: null,
            },
          });
          streamSucceeded = true;
        } catch (pumpError) {
          const errorMessage = pumpError instanceof Error
            ? pumpError.message
            : "Streaming failed";
          console.error("[generate-report] stream pump error (comparison):", errorMessage);
          if (!streamSucceeded) {
            try {
              await refundCreditsFn(supabase, user.id, CREDIT_MODE);
            } catch (refundError) {
              console.error(
                `[generate-report] CRITICAL: refundCredits FAILED after comparison stream pump error — ` +
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

