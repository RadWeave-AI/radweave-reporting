/**
 * Placeholder generation.
 *
 * DELIBERATELY NOT REAL. The actual workflow modules (checklist-generation,
 * quick-report-generation, comparison-generation, my-template-generation,
 * template-guided-generation) are copied in during a later mission, once the
 * auth/transport/error foundation in this repo is proven.
 *
 * What this stub exists to prove, and does prove:
 *  - the same WorkflowRun drives both transports
 *  - `delta` events stream incrementally and the `done` payload is complete
 *  - a workflow that fails mid-run surfaces correctly in both transports
 *
 * It makes no provider call, touches no database, and consumes no credits.
 */

import { ServiceError } from "../http/errors.ts";
import type { EmitFn, ReportResult, WorkflowName, WorkflowRun } from "./types.ts";

export const STUB_MARKER = "STUB — no clinical content was generated.";

export function stubResult(workflow: WorkflowName): ReportResult {
  return {
    report: `${STUB_MARKER}\n\nworkflow: ${workflow}`,
    model: "stub-model",
    mode: workflow,
    category: "stub",
    confidence: "none",
    templates_used: 0,
    template_names: [],
    review_id: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      estimated_cost_usd: 0,
    },
    credits: { remaining: 0, limit: 0 },
  };
}

/**
 * A WorkflowRun that emits the stub report as two deltas and one done event.
 * Two deltas rather than one so a streaming client's incremental assembly is
 * actually exercised.
 */
export function createStubWorkflow(workflow: WorkflowName): WorkflowRun {
  return {
    async run(emit: EmitFn) {
      const result = stubResult(workflow);
      const midpoint = Math.ceil(result.report.length / 2);
      await emit({ type: "delta", data: { t: result.report.slice(0, midpoint) } });
      await emit({ type: "delta", data: { t: result.report.slice(midpoint) } });
      await emit({ type: "done", data: result });
    },
  };
}

/** Used by the transport tests to exercise the mid-run failure path. */
export function createFailingWorkflow(error: ServiceError): WorkflowRun {
  return {
    async run(emit: EmitFn) {
      await emit({ type: "error", data: error });
    },
  };
}
