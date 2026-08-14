import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkflowContext } from "../app.ts";
import { getServiceConfig } from "../config.ts";
import { ServiceError } from "../http/errors.ts";
import { strip as stripPlaceholderSyntax } from "../lib/checklists/placeholders.ts";
import { isPairedStudyType, normalizeLaterality } from "../lib/config/laterality.ts";
import { canUseFeature } from "../lib/features/access.ts";
import {
  prepareBrowserAutoMatchedReport,
  type BrowserAutoMatchInput,
} from "../lib/reporting/checklist-generation.ts";
import {
  prepareComparisonReport,
  hasComparisonContent,
  type ComparisonGenerationInput,
} from "../lib/reporting/comparison-generation.ts";
import { getSupabaseService, ALLOWED_MODELS } from "../lib/reporting/kernel.ts";
import {
  prepareMyTemplateReport,
  type MyTemplateGenerationInput,
} from "../lib/reporting/my-template-generation.ts";
import {
  prepareQuickReport,
  type QuickReportGenerationInput,
} from "../lib/reporting/quick-report-generation.ts";
import {
  prepareTemplateGuidedReport,
  type TemplateGuidedGenerationInput,
} from "../lib/reporting/template-guided-generation.ts";
import { persistReportUsageWithRetry } from "../lib/reporting/usage-log-persistence.ts";
import { getSkeleton } from "../lib/skeletons/skeletons.ts";
import { getUserPlan } from "../lib/stripe/get-user-plan.ts";
import { assertAuthUid, createRlsUserClient } from "../supabase/clients.ts";
import type { EmitFn, ReportResult, WorkflowName, WorkflowRun } from "./types.ts";

type PreparationFailure =
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
  | { ok: false; category: "setup-error"; message: string };

interface LegacyDoneData {
  final_report: string;
  review_id: string | null;
  credits_remaining: number;
  credits_limit: number;
  confidence: string;
  category: string;
  template_names?: string[];
}

type LegacyEvent =
  | { type: "prelude"; text: string }
  | { type: "status"; data: { msg: string } }
  | { type: "delta"; data: { t: string } }
  | { type: "done"; data: LegacyDoneData }
  | { type: "error"; data: { error: string } };

interface UsageCapture {
  row: Record<string, unknown> | null;
}

export interface RealWorkflowDeps {
  serviceSupabase?: SupabaseClient;
  createRlsClient?: typeof createRlsUserClient;
  assertAuthUid?: typeof assertAuthUid;
  prepareChecklist?: typeof prepareBrowserAutoMatchedReport;
  prepareQuick?: typeof prepareQuickReport;
  prepareComparison?: typeof prepareComparisonReport;
  prepareMyTemplate?: typeof prepareMyTemplateReport;
  prepareTemplateGuided?: typeof prepareTemplateGuidedReport;
}

function preparationError(failure: PreparationFailure): ServiceError {
  switch (failure.category) {
    case "rate-limited":
      return new ServiceError("rate-limited", "Too many report requests.", {
        retry_after_seconds: failure.retry_after_seconds,
      });
    case "credits-exhausted":
      return new ServiceError("insufficient-credits", "No report credits remain.", {
        credits_remaining: failure.credits_remaining,
        credits_limit: failure.credits_limit,
      });
    case "credit-reservation-failed":
      return new ServiceError("internal-error", "Report credits could not be reserved.");
    case "setup-error":
      if (/plan upgrade/i.test(failure.message)) {
        return new ServiceError("upgrade-required", failure.message);
      }
      return new ServiceError("provider-error", "Report generation could not be prepared.");
  }
}

function selectedModel(body: Record<string, unknown>): string {
  const requested = typeof body.model === "string" ? body.model : "";
  return (ALLOWED_MODELS as readonly string[]).includes(requested)
    ? requested
    : "claude-sonnet-4-6";
}

function skeletonContainsSidePlaceholder(modality: string, bodyRegion: string, studyType: string) {
  const skeleton = getSkeleton(modality, bodyRegion, studyType);
  if (!skeleton) return false;
  return [skeleton.title, ...skeleton.technique, ...skeleton.findings, skeleton.opinion]
    .some((text) => /\[SIDE\]/i.test(text));
}

/** Mirrors the website route's non-clinical input normalization exactly. */
function normalizeWorkflowBody(workflow: WorkflowName, body: Record<string, unknown>) {
  const normalized = { ...body };
  const modality = typeof body.modality === "string" ? body.modality : "";
  const bodyRegion = typeof body.body_region === "string" ? body.body_region : "";
  const studyType = typeof body.study_type === "string" ? body.study_type : "";
  const selectedTemplateId = typeof body.selected_template_id === "string"
    ? body.selected_template_id
    : "";
  const rawFindings = typeof body.findings === "string" ? body.findings : "";
  normalized.findings = stripPlaceholderSyntax(rawFindings).result;
  normalized.model = selectedModel(body);
  normalized.preserve_findings_order = body.preserve_findings_order === true;
  normalized.age = typeof body.age === "number" && Number.isInteger(body.age) && body.age >= 0 && body.age <= 130
    ? body.age
    : undefined;
  normalized.sex = body.sex === "Male" || body.sex === "Female" ? body.sex : undefined;

  const hasLateralityValue = typeof body.laterality === "string"
    ? body.laterality.trim().length > 0
    : body.laterality != null;
  const laterality = normalizeLaterality(body.laterality);
  if (hasLateralityValue && !laterality) {
    throw new ServiceError("validation-error", "Laterality must be right, left, or bilateral.");
  }
  if (isPairedStudyType(studyType) && !laterality) {
    throw new ServiceError("validation-error", "Laterality is required for this study type.");
  }
  const skeletonAllowsLaterality = selectedTemplateId.startsWith("skeleton-normal:") &&
    skeletonContainsSidePlaceholder(modality, bodyRegion, studyType || bodyRegion);
  normalized.laterality = laterality && (isPairedStudyType(studyType) || skeletonAllowsLaterality)
    ? laterality
    : undefined;

  if (workflow === "comparison" && !hasComparisonContent(normalized as unknown as ComparisonGenerationInput)) {
    throw new ServiceError("validation-error", "Comparison input contains no comparison findings.", {
      missing_fields: ["comparison_blocks"],
    });
  }
  return normalized;
}

function numberFrom(row: Record<string, unknown> | null, key: string): number {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringFrom(row: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value : fallback;
}

function resultFrom(
  workflow: WorkflowName,
  body: Record<string, unknown>,
  done: LegacyDoneData,
  usage: UsageCapture,
): ReportResult {
  return {
    report: done.final_report,
    model: stringFrom(usage.row, "model", selectedModel(body)),
    mode: stringFrom(usage.row, "mode", workflow),
    category: done.category,
    confidence: done.confidence,
    templates_used: numberFrom(usage.row, "templates_used"),
    template_names: done.template_names ?? [],
    review_id: done.review_id,
    usage: {
      input_tokens: numberFrom(usage.row, "input_tokens"),
      output_tokens: numberFrom(usage.row, "output_tokens"),
      cached_tokens: numberFrom(usage.row, "cached_tokens"),
      estimated_cost_usd: numberFrom(usage.row, "estimated_cost_usd"),
    },
    credits: {
      remaining: done.credits_remaining,
      limit: done.credits_limit,
    },
  };
}

function adaptRun(
  workflow: WorkflowName,
  body: Record<string, unknown>,
  usage: UsageCapture,
  run: (emit: (event: LegacyEvent) => Promise<void>) => Promise<void>,
): WorkflowRun {
  return {
    run: (emit: EmitFn) => run(async (event) => {
      if (event.type === "prelude" || event.type === "status") return;
      if (event.type === "delta") {
        await emit(event);
        return;
      }
      if (event.type === "error") {
        await emit({
          type: "error",
          data: new ServiceError("provider-error", event.data.error),
        });
        return;
      }
      await emit({ type: "done", data: resultFrom(workflow, body, event.data, usage) });
    }),
  };
}

function usageLogger(workflow: string, capture: UsageCapture) {
  return async (supabase: SupabaseClient, row: Record<string, unknown>): Promise<void> => {
    const persistedRow = { id: crypto.randomUUID(), ...row };
    capture.row = persistedRow;
    await persistReportUsageWithRetry(supabase, persistedRow, { workflow });
  };
}

export async function createRealWorkflow(
  context: WorkflowContext,
  deps: RealWorkflowDeps = {},
): Promise<WorkflowRun> {
  if (context.principal.kind !== "user") {
    throw new ServiceError("not-implemented", "Organization reporting is not available yet.");
  }

  const principal = context.principal;
  const serviceSupabase = deps.serviceSupabase ?? getSupabaseService();
  const user = { id: principal.userId, email: principal.email };
  const body = normalizeWorkflowBody(context.workflow, context.body);
  const usage: UsageCapture = { row: null };
  const getUserPlanScoped = (userId: string) => getUserPlan(userId, serviceSupabase);
  const canUseFeatureScoped: typeof canUseFeature = (userId, plan, feature) =>
    canUseFeature(userId, plan, feature, serviceSupabase);

  let prepared:
    | PreparationFailure
    | { ok: true; run: (emit: (event: LegacyEvent) => Promise<void>) => Promise<void> };

  switch (context.workflow) {
    case "checklist":
      prepared = await (deps.prepareChecklist ?? prepareBrowserAutoMatchedReport)(
        user,
        body as unknown as BrowserAutoMatchInput,
        {
          supabase: serviceSupabase,
          signal: context.signal,
          getUserPlan: getUserPlanScoped,
          canUseFeature: canUseFeatureScoped,
          logReportUsage: usageLogger("checklist", usage),
        },
      );
      break;
    case "quick":
      prepared = await (deps.prepareQuick ?? prepareQuickReport)(
        user,
        body as unknown as QuickReportGenerationInput,
        {
          supabase: serviceSupabase,
          getUserPlan: getUserPlanScoped,
          canUseFeature: canUseFeatureScoped,
          logReportUsage: usageLogger("quick_report", usage),
        },
      );
      break;
    case "comparison":
      prepared = await (deps.prepareComparison ?? prepareComparisonReport)(
        user,
        body as unknown as ComparisonGenerationInput,
        {
          supabase: serviceSupabase,
          getUserPlan: getUserPlanScoped,
          logReportUsage: usageLogger("comparison", usage),
        },
      );
      break;
    case "my-template": {
      const config = getServiceConfig();
      const createUserClient = deps.createRlsClient ?? createRlsUserClient;
      const rlsClient = createUserClient(config, principal.accessToken);
      await (deps.assertAuthUid ?? assertAuthUid)(rlsClient, principal.userId);
      prepared = await (deps.prepareMyTemplate ?? prepareMyTemplateReport)(
        user,
        body as unknown as MyTemplateGenerationInput,
        {
          supabase: serviceSupabase,
          supabaseAuth: rlsClient,
          getUserPlan: getUserPlanScoped,
          logReportUsage: usageLogger("my_template", usage),
        },
      );
      break;
    }
    case "template-guided":
      prepared = await (deps.prepareTemplateGuided ?? prepareTemplateGuidedReport)(
        user,
        body as unknown as TemplateGuidedGenerationInput,
        {
          supabase: serviceSupabase,
          getUserPlan: getUserPlanScoped,
          canUseFeature: canUseFeatureScoped,
          logReportUsage: usageLogger("template_guided", usage),
        },
      );
      break;
  }

  if (!prepared.ok) throw preparationError(prepared);
  return adaptRun(context.workflow, body, usage, prepared.run);
}
