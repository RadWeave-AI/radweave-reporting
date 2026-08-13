/**
 * The transport-neutral shape every reporting workflow produces.
 *
 * A workflow does not know whether it is being streamed or returned as one
 * blocking JSON body — it just emits events. That is what lets a single
 * handler serve both `Accept: text/event-stream` and `Accept: application/json`
 * without two divergent implementations, which is the defect the website has
 * today (its streaming route and its Desktop route evolved separately).
 */

import type { ServiceError } from "../http/errors.ts";

export const WORKFLOWS = [
  "checklist",
  "quick",
  "comparison",
  "my-template",
  "template-guided",
] as const;

export type WorkflowName = (typeof WORKFLOWS)[number];

export interface ReportUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost_usd: number;
}

export interface ReportCredits {
  remaining: number;
  limit: number;
}

/** The `done` payload — also the body of a blocking 200 response. */
export interface ReportResult {
  report: string;
  model: string;
  mode: string;
  category: string;
  confidence: string;
  templates_used: number;
  template_names: string[];
  review_id: string | null;
  usage: ReportUsage;
  credits: ReportCredits;
}

export type WorkflowEvent =
  | { type: "delta"; data: { t: string } }
  | { type: "done"; data: ReportResult }
  | { type: "error"; data: ServiceError };

export type EmitFn = (event: WorkflowEvent) => Promise<void>;

/**
 * A prepared workflow: every pre-flight check (auth, validation, rate limit,
 * plan/entitlement, credit reservation) has already passed, and `run` is the
 * part that actually produces output.
 *
 * Pre-flight failures are thrown as ServiceError before a WorkflowRun exists,
 * so they become ordinary HTTP errors in BOTH transports rather than an error
 * event inside an already-committed 200 stream.
 */
export interface WorkflowRun {
  run(emit: EmitFn): Promise<void>;
}
