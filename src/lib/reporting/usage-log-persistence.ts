import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared, workflow-agnostic report_usage_logs persistence.
 *
 * Every AI workflow in this codebase (Checklist, Quick Report, Comparison,
 * My Template, Template-guided, Consultant Review, Viewer Report, CSF
 * extraction, style extraction, teaching-content generation, Atlas labeling)
 * writes one best-effort accounting row to report_usage_logs after a
 * successful provider call. Each call site used to perform its own
 * single-attempt insert and — with one exception (Consultant Review, fixed
 * in 35341e6) — never inspected the `{ error }` Supabase resolves on an
 * ordinary query-level failure, so a genuine rejection produced no retry and
 * frequently no log output at all.
 *
 * This module generalizes the Consultant Review fix into one shared helper
 * every writer can call. It knows nothing about prompts, report text,
 * findings, clinical workflow, credits, provider calls, SSE, or templates —
 * it only persists the row it is given and reports success/failure.
 *
 * Duplicate-insert safety relies on report_usage_logs.id being a plain
 * uuid primary key with no CHECK constraints or triggers (confirmed by
 * read-only schema inspection): callers supply a stable client-generated
 * `id` inside `row` themselves (this module never mutates or injects one),
 * and a Postgres unique-violation (23505) on the retry means the first
 * attempt's write actually committed — that is treated as success, not
 * retried again.
 */

// Postgres unique-violation code.
const POSTGRES_UNIQUE_VIOLATION = "23505";
export const MAX_USAGE_LOG_ATTEMPTS = 2;

export interface PersistReportUsageMetadata {
  /**
   * Safe, non-clinical label for log lines only (e.g. "comparison",
   * "checklist", "consultant_review"). Never put report text, findings, or
   * any patient-identifying information here — it exists purely to make a
   * console warning attributable to a workflow.
   */
  workflow?: string;
}

export interface PersistReportUsageResult {
  ok: boolean;
  attempts: number;
}

/**
 * Best-effort report_usage_logs insert with exactly one retry on ordinary
 * failure. Safe against duplicate rows because the caller supplies a stable
 * `id` inside `row` up front: a unique-violation on retry means the first
 * attempt already succeeded server-side, so it is treated as success rather
 * than retried again. Never throws — logging failures must never affect
 * report delivery, credits, or the Anthropic request for any workflow.
 *
 * `row` is passed through to Supabase untouched (this function never reads,
 * mutates, or adds fields to it) — the caller owns the row shape entirely.
 */
export async function persistReportUsageWithRetry(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
  metadata?: PersistReportUsageMetadata
): Promise<PersistReportUsageResult> {
  const workflow = metadata?.workflow ?? "unknown";
  let lastMessage = "unknown error";
  for (let attempt = 1; attempt <= MAX_USAGE_LOG_ATTEMPTS; attempt++) {
    try {
      const { error } = await supabase.from("report_usage_logs").insert(row);
      if (!error) return { ok: true, attempts: attempt };
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        console.warn(
          `[usage-log-persistence] insert attempt ${attempt} reported a duplicate id; treating as already persisted (workflow=${workflow}).`
        );
        return { ok: true, attempts: attempt };
      }
      lastMessage = error.message;
    } catch (thrown) {
      lastMessage = thrown instanceof Error ? thrown.message : String(thrown);
    }
    console.warn(
      `[usage-log-persistence] report_usage_logs insert attempt ${attempt}/${MAX_USAGE_LOG_ATTEMPTS} failed (workflow=${workflow}): ${lastMessage}`
    );
  }
  console.warn(
    `[usage-log-persistence] report_usage_logs persistence failed after ${MAX_USAGE_LOG_ATTEMPTS} attempts (workflow=${workflow}): ${lastMessage}. Delivery and credits are unaffected.`
  );
  return { ok: false, attempts: MAX_USAGE_LOG_ATTEMPTS };
}

