import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  normalizeComparisonBlocks,
  prepareComparisonReport,
} = await import("@/lib/reporting/comparison-generation");

const USER = { id: "comparison-user-123", email: "radiologist@example.com" };

const BASE_INPUT = {
  modality: "MRI",
  body_region: "Spine",
  indication: "Follow-up.",
  findings: "baseline finding",
  field_strength: "HIGH FIELD (3.0 TESLA)",
  study_type: "Lumbosacral Spine",
  model: "claude-sonnet-4-6",
  report_header: "MRI LUMBOSACRAL SPINE",
  opinion_hints: "",
  residual_opinion_hints: "",
  preserve_findings_order: false,
  prior_date: "2026-08-03",
  prior_opinion: "  Prior disc protrusion.  ",
  comparison_blocks: [
    {
      type: "group",
      status: "stationary",
      findings: [{ text: "  Stable L4/5 protrusion  " }],
    },
    {
      type: "group",
      status: "new",
      header: "  Bespoke new header:  ",
      findings: [{ text: "  New L5/S1 extrusion  ", is_new: true }],
    },
    { type: "loose", text: "  Correlate clinically.  " },
  ],
  stationary_phrasing: "  No significant interval change  ",
  new_phrasing: "  Interval development  ",
};

const TOKEN_USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 300,
  output_tokens: 400,
};

function fakeAnthropicStream(chunks = [
  "MRI FINDINGS:\n- Provider finding.\n\n\nOPINION:\n- Stable study.\n",
  "- stable study!\n[PARTIAL NORMAL: remove this]",
]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
    },
    async finalMessage() {
      return { usage: TOKEN_USAGE };
    },
  };
}

function happyScenario(overrides = {}) {
  const calls = {
    sequence: [],
    provider: [],
    reserve: [],
    refund: [],
    parse: [],
    prompt: [],
    usageRows: [],
    reviewRows: [],
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
    loadDatabaseAbbreviations: async () => {
      calls.sequence.push("abbreviations");
      return [{ abbreviation: "abbr", expansion: "expanded" }];
    },
    parseToPrompt: (text, modality, bodyRegion, abbreviations) => {
      calls.parse.push({ text, modality, bodyRegion, abbreviations });
      return `expanded(${text.trim()})`;
    },
    getMriTechnique: () => ["Sagittal T1", "Sagittal T2"],
    buildComparisonReportPrompt: (input) => {
      calls.sequence.push("prompt");
      calls.prompt.push(input);
      return { system: "SYSTEM", user: "USER", staticInstructions: "STATIC" };
    },
    logReportUsage: async (_supabase, row) => {
      calls.sequence.push("usage-log");
      calls.usageRows.push(row);
    },
    insertReportReview: async (_supabase, row) => {
      calls.sequence.push("review-log");
      calls.reviewRows.push(row);
      return "review-comparison-123";
    },
    ...overrides,
  };

  return { calls, deps };
}

async function prepareAndRun(scenario, input = BASE_INPUT, emitOverride) {
  const prepared = await prepareComparisonReport(USER, input, scenario.deps);
  const events = [];
  if (prepared.ok) {
    await prepared.run(emitOverride ?? (async (event) => {
      events.push(event);
    }));
  }
  return { prepared, events };
}

function eventTypes(events) {
  return events.map((event) => event.type);
}

test("canonical Comparison blocks are trimmed, validated, and kept in client order", () => {
  assert.deepEqual(normalizeComparisonBlocks([
    { type: "group", status: " STATIONARY ", header: "  Custom:  ", findings: [
      { text: "  Finding one  ", is_new: false },
      { text: "   " },
    ] },
    { type: "group", status: "invalid", findings: [{ text: "drop" }] },
    { type: "loose", text: "  Loose sentence.  " },
    { type: "loose", text: "   " },
  ]), [
    {
      type: "group",
      status: "stationary",
      header: "Custom:",
      findings: [{ text: "Finding one", is_new: false }],
    },
    { type: "loose", text: "Loose sentence." },
  ]);
});

test("canonical flow preserves prompt, provider, accounting, cleanup, persistence, and events", async () => {
  const scenario = happyScenario();
  const { prepared, events } = await prepareAndRun(scenario);

  assert.equal(prepared.ok, true);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "done"]);
  assert.equal(events[0].text, `: ${" ".repeat(2048)}\n\n`);
  assert.deepEqual(scenario.calls.sequence, [
    "rate-limit", "plan", "usage", "abbreviations", "reserve", "prompt",
    "provider", "usage-log", "review-log",
  ]);
  assert.deepEqual(scenario.calls.reserve, [{ userId: USER.id, mode: "fast" }]);
  assert.deepEqual(scenario.calls.refund, []);

  assert.equal(scenario.calls.prompt.length, 1);
  assert.deepEqual(scenario.calls.prompt[0], {
    modality: "MRI",
    body_region: "Spine",
    indication: "Follow-up.",
    findings: "expanded(baseline finding)",
    field_strength: "HIGH FIELD (3.0 TESLA)",
    study_type: "Lumbosacral Spine",
    age: undefined,
    sex: undefined,
    laterality: undefined,
    report_header: "MRI LUMBOSACRAL SPINE",
    opinion_hints: "",
    preserve_findings_order: false,
    template_guided: false,
    my_template_mode: false,
    template_edits: undefined,
    mri_technique: ["Sagittal T1", "Sagittal T2"],
    normal_skeleton_findings: undefined,
    style_profile: null,
    style_examples: [],
    prior_date: "03/08/2026",
    prior_opinion: "Prior disc protrusion.",
    comparison_blocks: [
      {
        type: "group",
        status: "stationary",
        header: "No significant interval change regarding:",
        findings: [{ text: "Stable L4/5 protrusion", is_new: false }],
      },
      {
        type: "group",
        status: "new",
        header: "Bespoke new header:",
        findings: [{ text: "New L5/S1 extrusion", is_new: true }],
      },
      { type: "loose", text: "Correlate clinically." },
    ],
    stationary_phrasing: "No significant interval change",
    new_phrasing: "Interval development",
  });

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

  assert.deepEqual(scenario.calls.usageRows, [{
    user_id: USER.id,
    model: "claude-sonnet-4-6",
    mode: "comparison",
    modality: "MRI",
    body_region: "Spine",
    study_type: "Lumbosacral Spine",
    input_tokens: 100,
    output_tokens: 400,
    cached_tokens: 300,
    estimated_cost_usd: 0.00714,
    templates_used: 0,
    report_chars: 0,
  }]);

  const done = events.at(-1).data;
  assert.deepEqual(done, {
    final_report: "MRI FINDINGS:\n- Provider finding.\n\nOPINION:\n- Stable study.",
    review_id: "review-comparison-123",
    credits_remaining: 298,
    credits_limit: 300,
    confidence: "high",
    category: "Comparison Report",
    template_names: [],
    style_validation: null,
  });
  assert.deepEqual(scenario.calls.reviewRows, [{
    user_id: USER.id,
    user_email: USER.email,
    modality: "MRI",
    body_region: "Spine",
    study_type: "Lumbosacral Spine",
    report_mode: "comparison",
    model: "claude-sonnet-4-6",
    category: "Comparison Report",
    template_names: [],
    original_report: done.final_report,
    input_tokens: 100,
    output_tokens: 400,
    estimated_cost_usd: 0.00714,
  }]);
});

test("final cleanup keeps selected opinion hints first and residual hints last", async () => {
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
  const { events } = await prepareAndRun(scenario, {
    ...BASE_INPUT,
    opinion_hints: "- **Selected pathology.**",
    residual_opinion_hints: "- **Residual normal.**",
  });

  assert.equal(
    events.at(-1).data.final_report,
    "MRI FINDINGS:\n- Provider finding.\n\nOPINION:\n\n- **Selected pathology.**\n- **AI-only opinion.**\n- **Residual normal.**",
  );
});

test("legacy annotated/new inputs expand text and comments and group statuses in fixed order", async () => {
  const scenario = happyScenario();
  const prepared = await prepareComparisonReport(USER, {
    ...BASE_INPUT,
    comparison_blocks: [],
    prior_opinion: "   ",
    annotated_findings: [
      { text: "progressive abbr", status: "PROGRESSIVE", comment: "worse abbr" },
      { text: "stationary abbr", status: "stationary" },
      { text: "regressive abbr", status: "regressive" },
      { text: "resolved abbr", status: "resolved", comment: "gone abbr" },
    ],
    new_findings: [{ text: "new abbr", comment: "fresh abbr" }],
    stationary_phrasing: undefined,
    new_phrasing: undefined,
  }, scenario.deps);

  assert.equal(prepared.ok, true);
  assert.equal(scenario.calls.prompt[0].prior_opinion, undefined);
  assert.deepEqual(scenario.calls.prompt[0].comparison_blocks, [
    {
      type: "group", status: "stationary", header: "Rather stationary course regarding:",
      findings: [{ text: "expanded(stationary abbr)" }],
    },
    {
      type: "group", status: "regressive", header: "Regressive course regarding:",
      findings: [{ text: "expanded(regressive abbr)" }],
    },
    {
      type: "group", status: "progressive", header: "Progressive course regarding:",
      findings: [{ text: "expanded(progressive abbr). expanded(worse abbr)" }],
    },
    {
      type: "group", status: "resolved", header: "Resolution of:",
      findings: [{ text: "expanded(resolved abbr). expanded(gone abbr)" }],
    },
    {
      type: "group", status: "new", header: "Newly developed:",
      findings: [{ text: "expanded(new abbr). expanded(fresh abbr)", is_new: true }],
    },
  ]);
});

test("rate limiting and early insufficient credits stop before reservation and provider use", async () => {
  const limited = happyScenario({
    checkReportRateLimit: async () => ({ limited: true, retryAfterSeconds: 31 }),
  });
  const limitedResult = await prepareAndRun(limited);
  assert.deepEqual(limitedResult.prepared, {
    ok: false, category: "rate-limited", retry_after_seconds: 31,
  });
  assert.deepEqual(limited.calls.reserve, []);
  assert.deepEqual(limited.calls.provider, []);

  const exhausted = happyScenario({
    getUserPlan: async () => ({ plan: "free", current_period_end: null }),
    getOrCreateUsage: async () => ({
      credits_used: 10, credits_limit: 10, credits_remaining: 0,
      plan: "free", period_end: "2026-09-01T00:00:00.000Z",
    }),
  });
  const exhaustedResult = await prepareAndRun(exhausted);
  assert.deepEqual(exhaustedResult.prepared, {
    ok: false,
    category: "credits-exhausted",
    credits_remaining: 0,
    credits_limit: 10,
    plan: "free",
    upgrade_required: true,
  });
  assert.deepEqual(exhausted.calls.reserve, []);
  assert.deepEqual(exhausted.calls.provider, []);
  assert.deepEqual(exhausted.calls.refund, []);
});

test("atomic reservation misses and errors preserve current HTTP-mappable outcomes", async () => {
  const missed = happyScenario({
    reserveCredits: async (_supabase, userId, mode) => {
      missed.calls.reserve.push({ userId, mode });
      return false;
    },
  });
  const missedResult = await prepareAndRun(missed);
  assert.deepEqual(missedResult.prepared, {
    ok: false,
    category: "credits-exhausted",
    credits_remaining: 0,
    credits_limit: 300,
    plan: "pro",
    upgrade_required: false,
  });
  assert.deepEqual(missed.calls.refund, []);
  assert.deepEqual(missed.calls.provider, []);

  const errored = happyScenario({
    reserveCredits: async () => { throw new Error("reservation unavailable"); },
  });
  const erroredResult = await prepareAndRun(errored);
  assert.deepEqual(erroredResult.prepared, {
    ok: false, category: "credit-reservation-failed",
  });
  assert.deepEqual(errored.calls.refund, []);
});

test("provider failure emits error, emits no done, and refunds exactly once", async () => {
  const scenario = happyScenario({
    anthropic: {
      messages: {
        stream() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
              throw new Error("provider stream failed");
            },
            async finalMessage() { throw new Error("unreachable"); },
          };
        },
      },
    },
  });
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "error"]);
  assert.equal(events.at(-1).data.error, "provider stream failed");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(scenario.calls.refund.length, 1);
  assert.deepEqual(scenario.calls.usageRows, []);
  assert.deepEqual(scenario.calls.reviewRows, []);
});

test("event-sink failure refunds exactly once and cannot double-refund", async () => {
  const scenario = happyScenario();
  const prepared = await prepareComparisonReport(USER, BASE_INPUT, scenario.deps);
  assert.equal(prepared.ok, true);
  let writes = 0;
  await prepared.run(async () => {
    writes += 1;
    if (writes >= 2) throw new Error("browser disconnected");
  });
  assert.equal(scenario.calls.refund.length, 1);
});

test("usage persistence failure is best-effort and still produces the current done event", async () => {
  const scenario = happyScenario({
    logReportUsage: async () => { throw new Error("usage insert failed"); },
  });
  const { events } = await prepareAndRun(scenario);
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(scenario.calls.refund, []);
  assert.equal(scenario.calls.reviewRows.length, 1);
});

test("review database errors remain non-fatal, while a thrown review failure follows stream failure parity", async () => {
  const nonFatal = happyScenario({ insertReportReview: async () => null });
  const nonFatalResult = await prepareAndRun(nonFatal);
  assert.equal(nonFatalResult.events.at(-1).type, "done");
  assert.equal(nonFatalResult.events.at(-1).data.review_id, null);
  assert.deepEqual(nonFatal.calls.refund, []);

  const thrown = happyScenario({
    insertReportReview: async () => { throw new Error("review transport failed"); },
  });
  const thrownResult = await prepareAndRun(thrown);
  assert.deepEqual(eventTypes(thrownResult.events), ["prelude", "delta", "delta", "error"]);
  assert.equal(thrownResult.events.at(-1).data.error, "review transport failed");
  assert.equal(thrown.calls.refund.length, 1);
});

test("a setup failure after reservation refunds once and returns no runnable stream", async () => {
  const scenario = happyScenario({
    buildComparisonReportPrompt: () => { throw new Error("prompt setup failed"); },
  });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, {
    ok: false, category: "setup-error", message: "prompt setup failed",
  });
  assert.deepEqual(events, []);
  assert.equal(scenario.calls.refund.length, 1);
  assert.deepEqual(scenario.calls.provider, []);
});

test("Comparison orchestration has no template matching or user-template retrieval dependency", async () => {
  const source = await readFile(
    new URL("../src/lib/reporting/comparison-generation.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /matchTemplates|retrieveSimilarUserTemplates/);
});
