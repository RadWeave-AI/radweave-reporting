import assert from "node:assert/strict";
import test from "node:test";

const {
  prepareBrowserAutoMatchedReport,
} = await import("@/lib/reporting/generation-engine");

const USER = { id: "browser-user-123", email: "radiologist@example.com" };

const BASE_INPUT = {
  modality: "MRI",
  body_region: "Spine",
  indication: "Low back pain.",
  findings: "- First input finding.\n- Second input finding.",
  field_strength: "HIGH FIELD (3.0 TESLA)",
  study_type: "Lumbosacral Spine",
  laterality: undefined,
  model: "claude-sonnet-4-6",
  report_header: "MRI LUMBOSACRAL SPINE",
  opinion_hints: "",
  residual_opinion_hints: "",
  preserve_findings_order: true,
};

function normalMatch() {
  return {
    matched_templates: [{
      id: "template-1",
      file_name: "mri-lss-normal.docx",
      body_region: "Spine",
      modality: "MRI",
      pathology_category: "Normal",
      pathology_name: "Normal lumbosacral spine",
      findings_text: "Normal vertebral alignment.",
      opinion_text: "Normal study.",
      full_text: "Normal vertebral alignment.\n\nOPINION:\n- Normal study.",
      keywords: ["normal", "spine"],
      relevance_score: 20,
      is_normal: true,
    }],
    match_confidence: "high",
    pathology_category: "Normal",
    query_terms: ["spine"],
  };
}

function fakeAnthropicStream(chunks = [
  "MRI FINDINGS:\n- Provider second.\n- Provider first.\n\nOPINION:\n- Normal study.\n",
  "- normal study!\n[PARTIAL NORMAL: must be removed]",
]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
    },
    async finalMessage() {
      return {
        usage: {
          input_tokens: 500,
          output_tokens: 120,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 50,
        },
      };
    },
  };
}

function happyScenario(overrides = {}) {
  const calls = {
    sequence: [],
    rateLimit: 0,
    reserve: [],
    refund: [],
    matchInputs: [],
    buildPrompt: [],
    provider: [],
    usageRows: [],
    reviewRows: [],
    entitlement: [],
  };

  const deps = {
    supabase: {},
    anthropic: {
      messages: {
        stream(params, options) {
          calls.sequence.push("provider");
          calls.provider.push({ params, options });
          return fakeAnthropicStream();
        },
      },
    },
    checkReportRateLimit: async () => {
      calls.sequence.push("rate-limit");
      calls.rateLimit += 1;
      return { limited: false, retryAfterSeconds: 0 };
    },
    getUserPlan: async () => {
      calls.sequence.push("plan");
      return { plan: "pro", current_period_end: null };
    },
    getOrCreateUsage: async () => {
      calls.sequence.push("usage");
      return {
        credits_used: 1,
        credits_limit: 300,
        credits_remaining: 299,
        plan: "pro",
        period_end: "2026-09-01T00:00:00.000Z",
      };
    },
    reserveCredits: async (_supabase, userId, mode) => {
      calls.sequence.push("reserve");
      calls.reserve.push({ userId, mode });
      return true;
    },
    refundCredits: async (_supabase, userId, mode) => {
      calls.refund.push({ userId, mode });
    },
    matchTemplates: async (_supabase, input) => {
      calls.sequence.push("match");
      calls.matchInputs.push(input);
      return normalMatch();
    },
    canUseFeature: async (userId, plan, feature) => {
      calls.entitlement.push({ userId, plan, feature });
      return true;
    },
    loadDatabaseAbbreviations: async () => {
      calls.sequence.push("abbreviations");
      return [];
    },
    buildPrompt: (templates, input) => {
      calls.sequence.push("prompt");
      calls.buildPrompt.push({ templates, input });
      return { system: "SYSTEM", user: "USER", staticInstructions: "STATIC" };
    },
    logReportUsage: async (_supabase, row) => {
      calls.sequence.push("usage-log");
      calls.usageRows.push(row);
    },
    insertReportReview: async (_supabase, row) => {
      calls.sequence.push("review-log");
      calls.reviewRows.push(row);
      return "review-123";
    },
    ...overrides,
  };

  return { calls, deps };
}

async function prepareAndRun(scenario, input = BASE_INPUT) {
  const prepared = await prepareBrowserAutoMatchedReport(USER, input, scenario.deps);
  const events = [];
  if (prepared.ok) {
    await prepared.run(async (event) => {
      events.push(event);
    });
  }
  return { prepared, events };
}

function eventTypes(events) {
  return events.map((event) => event.type);
}

function serializeEvents(events) {
  return events.map((event) => event.type === "prelude"
    ? event.text
    : `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
  ).join("");
}

test("successful browser Checklist generation preserves matching, prompt, provider, accounting, cleanup, and events", async () => {
  const scenario = happyScenario();
  const { prepared, events } = await prepareAndRun(scenario);

  assert.equal(prepared.ok, true);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "done"]);
  assert.equal(events[0].text, `: ${" ".repeat(2048)}\n\n`);
  assert.equal(events[1].data.t, "MRI FINDINGS:\n- Provider second.\n- Provider first.\n\nOPINION:\n- Normal study.\n");

  assert.equal(scenario.calls.rateLimit, 1);
  assert.deepEqual(scenario.calls.sequence, [
    "rate-limit",
    "plan",
    "usage",
    "abbreviations",
    "reserve",
    "match",
    "prompt",
    "provider",
    "usage-log",
    "review-log",
  ]);
  assert.deepEqual(scenario.calls.reserve, [{ userId: USER.id, mode: "fast" }]);
  assert.deepEqual(scenario.calls.refund, []);
  assert.equal(scenario.calls.matchInputs.length, 1);
  assert.deepEqual(scenario.calls.matchInputs[0], scenario.calls.buildPrompt[0].input);
  assert.equal(scenario.calls.matchInputs[0].report_header, BASE_INPUT.report_header);
  assert.equal(scenario.calls.matchInputs[0].preserve_findings_order, true);
  assert.equal(scenario.calls.buildPrompt[0].templates[0].id, "template-1");

  assert.equal(scenario.calls.provider.length, 1);
  assert.deepEqual(scenario.calls.provider[0], {
    params: {
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      temperature: 0.2,
      system: [
        { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
        { type: "text", text: "STATIC", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "USER" }],
    },
    options: { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
  });

  assert.equal(scenario.calls.usageRows.length, 1);
  assert.equal(scenario.calls.usageRows[0].mode, "checklist");
  assert.equal(scenario.calls.usageRows[0].templates_used, 1);
  assert.equal(scenario.calls.usageRows[0].report_chars, 0);
  assert.equal(scenario.calls.usageRows[0].cached_tokens, 50);
  assert.equal(scenario.calls.usageRows[0].estimated_cost_usd, 0.00340875);

  const done = events.at(-1).data;
  assert.equal(
    done.final_report,
    "MRI FINDINGS:\n\n- First input finding.\n- Second input finding.\n\nOPINION:\n- Normal study.",
  );
  assert.deepEqual(done, {
    final_report: "MRI FINDINGS:\n\n- First input finding.\n- Second input finding.\n\nOPINION:\n- Normal study.",
    review_id: "review-123",
    credits_remaining: 298,
    credits_limit: 300,
    confidence: "high",
    category: "Normal",
    template_names: ["Normal lumbosacral spine"],
    style_validation: null,
  });
  assert.equal(scenario.calls.reviewRows.length, 1);
  assert.equal(scenario.calls.reviewRows[0].original_report, done.final_report);
  assert.equal(scenario.calls.reviewRows[0].report_mode, "checklist");
  assert.equal(
    serializeEvents(events),
    `: ${" ".repeat(2048)}\n\n` +
      `event: delta\ndata: ${JSON.stringify({ t: events[1].data.t })}\n\n` +
      `event: delta\ndata: ${JSON.stringify({ t: events[2].data.t })}\n\n` +
      `event: done\ndata: ${JSON.stringify(done)}\n\n`,
  );
});

test("rate limiting happens before plan lookup, reservation, matching, and provider invocation", async () => {
  const scenario = happyScenario({
    checkReportRateLimit: async () => ({ limited: true, retryAfterSeconds: 37 }),
    getUserPlan: async () => {
      throw new Error("plan lookup must not run");
    },
  });
  const { prepared, events } = await prepareAndRun(scenario);

  assert.deepEqual(prepared, {
    ok: false,
    category: "rate-limited",
    retry_after_seconds: 37,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(scenario.calls.reserve, []);
  assert.deepEqual(scenario.calls.matchInputs, []);
  assert.deepEqual(scenario.calls.provider, []);
});

test("early insufficient credits does not reserve or call the provider", async () => {
  const scenario = happyScenario({
    getOrCreateUsage: async () => ({
      credits_used: 10,
      credits_limit: 10,
      credits_remaining: 0,
      plan: "free",
      period_end: "2026-09-01T00:00:00.000Z",
    }),
    getUserPlan: async () => ({ plan: "free", current_period_end: null }),
  });
  const { prepared, events } = await prepareAndRun(scenario);

  assert.deepEqual(prepared, {
    ok: false,
    category: "credits-exhausted",
    credits_remaining: 0,
    credits_limit: 10,
    plan: "free",
    upgrade_required: true,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(scenario.calls.reserve, []);
  assert.deepEqual(scenario.calls.provider, []);
  assert.deepEqual(scenario.calls.refund, []);
});

test("an atomic reservation miss returns exhausted without matching, provider use, or refund", async () => {
  const scenario = happyScenario({
    reserveCredits: async (_supabase, userId, mode) => {
      scenario.calls.reserve.push({ userId, mode });
      return false;
    },
  });
  const { prepared, events } = await prepareAndRun(scenario);

  assert.deepEqual(prepared, {
    ok: false,
    category: "credits-exhausted",
    credits_remaining: 0,
    credits_limit: 300,
    plan: "pro",
    upgrade_required: false,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(scenario.calls.reserve, [{ userId: USER.id, mode: "fast" }]);
  assert.deepEqual(scenario.calls.matchInputs, []);
  assert.deepEqual(scenario.calls.provider, []);
  assert.deepEqual(scenario.calls.refund, []);
});

test("opinion hints remain first and residual hints remain last in the cleaned final report", async () => {
  const scenario = happyScenario({
    anthropic: {
      messages: {
        stream(params, options) {
          scenario.calls.provider.push({ params, options });
          return fakeAnthropicStream([
            "MRI FINDINGS:\n- Provider finding.\n\nOPINION:\n- AI-only opinion.\n- Residual normal.",
          ]);
        },
      },
    },
  });
  const { prepared, events } = await prepareAndRun(scenario, {
    ...BASE_INPUT,
    preserve_findings_order: false,
    opinion_hints: "- **Selected pathology.**",
    residual_opinion_hints: "- **Residual normal.**",
  });

  assert.equal(prepared.ok, true);
  assert.equal(
    events.at(-1).data.final_report,
    "MRI FINDINGS:\n- Provider finding.\n\nOPINION:\n\n- **Selected pathology.**\n- **AI-only opinion.**\n- **Residual normal.**",
  );
  assert.deepEqual(scenario.calls.refund, []);
});

test("pathology entitlement denial occurs after one reservation and refunds exactly once", async () => {
  const pathology = normalMatch();
  pathology.matched_templates[0].is_normal = false;
  pathology.matched_templates[0].pathology_category = "Tumor";
  const scenario = happyScenario({
    matchTemplates: async (_supabase, input) => {
      scenario.calls.matchInputs.push(input);
      return pathology;
    },
    canUseFeature: async () => false,
  });

  const { prepared, events } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, {
    ok: false,
    category: "setup-error",
    message: "This template requires a plan upgrade.",
  });
  assert.deepEqual(events, []);
  assert.equal(scenario.calls.reserve.length, 1);
  assert.equal(scenario.calls.refund.length, 1);
  assert.deepEqual(scenario.calls.provider, []);
});

test("provider stream failure emits error, emits no done, and refunds exactly once", async () => {
  const scenario = happyScenario({
    anthropic: {
      messages: {
        stream() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
              throw new Error("provider stream failed");
            },
            async finalMessage() {
              throw new Error("unreachable");
            },
          };
        },
      },
    },
  });

  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "error"]);
  assert.equal(events.at(-1).data.error, "provider stream failed");
  assert.equal(scenario.calls.refund.length, 1);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.deepEqual(scenario.calls.usageRows, []);
  assert.deepEqual(scenario.calls.reviewRows, []);
});

test("an event sink failure refunds once without a duplicate refund", async () => {
  const scenario = happyScenario();
  const prepared = await prepareBrowserAutoMatchedReport(USER, BASE_INPUT, scenario.deps);
  assert.equal(prepared.ok, true);

  let writes = 0;
  await prepared.run(async () => {
    writes += 1;
    if (writes === 2) throw new Error("browser disconnected");
  });

  assert.equal(scenario.calls.refund.length, 1);
});

