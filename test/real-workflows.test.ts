import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkflowContext } from "../src/app.ts";
import type { BrowserAutoMatchEvent } from "../src/lib/reporting/checklist-generation.ts";
import type { ComparisonGenerationEvent } from "../src/lib/reporting/comparison-generation.ts";
import type { MyTemplateGenerationEvent } from "../src/lib/reporting/my-template-generation.ts";
import type { QuickReportGenerationEvent } from "../src/lib/reporting/quick-report-generation.ts";
import type { TemplateGuidedGenerationEvent } from "../src/lib/reporting/template-guided-generation.ts";
import { createRealWorkflow, type RealWorkflowDeps } from "../src/workflows/real.ts";
import type { WorkflowEvent, WorkflowName } from "../src/workflows/types.ts";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";
process.env.ANTHROPIC_API_KEY ??= "anthropic";
process.env.VOYAGE_API_KEY ??= "voyage";

const MODES: Record<WorkflowName, string> = {
  checklist: "checklist",
  quick: "quick_report",
  comparison: "comparison",
  "my-template": "my_template",
  "template-guided": "template_guided",
};

const serviceSupabase = {
  from: () => ({ insert: async () => ({ error: null }) }),
} as unknown as SupabaseClient;

const rlsSupabase = { auth: {} } as SupabaseClient;

function context(workflow: WorkflowName): WorkflowContext {
  return {
    workflow,
    principal: {
      kind: "user",
      userId: "user-1",
      email: "radiologist@example.com",
      plan: "pro",
      accessToken: "verified-access-token",
    },
    body: {
      modality: "MRI",
      body_region: "Brain",
      indication: "",
      findings: "Finding",
      model: "claude-opus-4-6",
      ...(workflow === "comparison"
        ? { prior_date: "2026-01-01", new_findings: [{ text: "Finding" }] }
        : {}),
      ...(workflow === "my-template" ? { user_template_text: "Template" } : {}),
      ...(workflow === "template-guided" ? { selected_template_id: "template-1" } : {}),
    },
    signal: new AbortController().signal,
  };
}

type AnyLegacyEvent =
  | BrowserAutoMatchEvent
  | QuickReportGenerationEvent
  | ComparisonGenerationEvent
  | MyTemplateGenerationEvent
  | TemplateGuidedGenerationEvent;

for (const workflow of Object.keys(MODES) as WorkflowName[]) {
  test(`${workflow} adapter preserves deltas and maps the real done payload`, async () => {
    let prepared = false;
    let authAsserted = false;
    let receivedAuthClient: SupabaseClient | undefined;

    const prepare = async (...args: unknown[]) => {
      prepared = true;
      const workflowDeps = args[2] as {
        supabaseAuth?: SupabaseClient;
        logReportUsage?: (client: SupabaseClient, row: Record<string, unknown>) => Promise<void>;
      };
      receivedAuthClient = workflowDeps.supabaseAuth;
      return {
        ok: true as const,
        run: async (emit: (event: AnyLegacyEvent) => Promise<void>) => {
          await workflowDeps.logReportUsage?.(serviceSupabase, {
            user_id: "user-1",
            model: "claude-opus-4-6",
            mode: MODES[workflow],
            input_tokens: 101,
            output_tokens: 202,
            cached_tokens: 33,
            estimated_cost_usd: 0.0042,
            templates_used: 2,
          });
          await emit({ type: "prelude", text: ": pad\n\n" });
          await emit({ type: "delta", data: { t: "REPORT" } });
          await emit({
            type: "done",
            data: {
              final_report: "REPORT",
              review_id: "review-1",
              credits_remaining: 9,
              credits_limit: 10,
              confidence: "high",
              category: "Category",
              template_names: ["One", "Two"],
              style_validation: null,
              quality_warnings: [],
            },
          } as AnyLegacyEvent);
        },
      };
    };

    const deps: RealWorkflowDeps = {
      serviceSupabase,
      createRlsClient: (_config, token) => {
        assert.equal(token, "verified-access-token");
        return rlsSupabase;
      },
      assertAuthUid: async (client, expectedUserId) => {
        authAsserted = true;
        assert.equal(client, rlsSupabase);
        assert.equal(expectedUserId, "user-1");
      },
      prepareChecklist: prepare as RealWorkflowDeps["prepareChecklist"],
      prepareQuick: prepare as RealWorkflowDeps["prepareQuick"],
      prepareComparison: prepare as RealWorkflowDeps["prepareComparison"],
      prepareMyTemplate: prepare as RealWorkflowDeps["prepareMyTemplate"],
      prepareTemplateGuided: prepare as RealWorkflowDeps["prepareTemplateGuided"],
    };

    const run = await createRealWorkflow(context(workflow), deps);
    const events: WorkflowEvent[] = [];
    await run.run(async (event) => { events.push(event); });

    assert.equal(prepared, true);
    assert.deepEqual(events.map((event) => event.type), ["delta", "done"]);
    assert.deepEqual(events[0], { type: "delta", data: { t: "REPORT" } });
    assert.equal(events[1]?.type, "done");
    if (events[1]?.type === "done") {
      assert.deepEqual(events[1].data, {
        report: "REPORT",
        model: "claude-opus-4-6",
        mode: MODES[workflow],
        category: "Category",
        confidence: "high",
        templates_used: 2,
        template_names: ["One", "Two"],
        review_id: "review-1",
        usage: {
          input_tokens: 101,
          output_tokens: 202,
          cached_tokens: 33,
          estimated_cost_usd: 0.0042,
        },
        credits: { remaining: 9, limit: 10 },
      });
    }

    assert.equal(authAsserted, workflow === "my-template");
    assert.equal(receivedAuthClient, workflow === "my-template" ? rlsSupabase : undefined);
  });
}

test("My Template refuses to prepare when the RLS client cannot resolve auth.uid()", async () => {
  let prepared = false;
  await assert.rejects(
    createRealWorkflow(context("my-template"), {
      serviceSupabase,
      createRlsClient: () => rlsSupabase,
      assertAuthUid: async () => {
        throw new Error("Authenticated Supabase client did not resolve the expected auth.uid().");
      },
      prepareMyTemplate: (async () => {
        prepared = true;
        throw new Error("must not run");
      }) as RealWorkflowDeps["prepareMyTemplate"],
    }),
    /did not resolve the expected auth\.uid/,
  );
  assert.equal(prepared, false);
});
