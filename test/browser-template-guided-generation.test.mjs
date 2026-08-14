import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  prepareTemplateGuidedReport,
} = await import("@/lib/reporting/template-guided-generation");

const USER = { id: "tg-user-123", email: "radiologist@example.com" };

const TEMPLATE_EDITS_NO_TRIGGER = [
  "STRUCTURED FINDINGS:",
  "- ACL sprain confirmed",
  "OPINION POINTS:",
  "- Correlate clinically",
].join("\n");

const BASE_INPUT = {
  modality: "MRI",
  body_region: "MSK",
  indication: "Knee pain.",
  findings: "ACL sprain",
  field_strength: "HIGH FIELD (3.0 TESLA)",
  study_type: "Knee",
  laterality: "Right",
  model: "claude-sonnet-4-6",
  report_header: "",
  opinion_hints: "",
  residual_opinion_hints: "",
  preserve_findings_order: false,
  selected_template_id: "template-1",
  template_edits: TEMPLATE_EDITS_NO_TRIGGER,
};

const TEMPLATE_ROW = {
  id: "template-1",
  file_name: "Knee MSK template.docx",
  body_region: "MSK",
  modality: "MRI",
  pathology_category: "Ligament",
  pathology_name: "ACL sprain",
  findings_text: "MRI FINDINGS:\n- Baseline.",
  opinion_text: "- Baseline opinion.",
  full_text: "MRI FINDINGS:\n- Baseline.\n\nOPINION:\n- Baseline opinion.",
  keywords: ["acl"],
  is_hidden: false,
  deleted_at: null,
  is_normal: false,
};

const FIRST_USAGE = { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 400 };
const CORRECTION_USAGE = { input_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 80 };
const NO_CORRECTION_COST = 0.00714;
const TWO_CALL_COST = 0.0085335;

function fakeAnthropicStream(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
    },
    async finalMessage() {
      return { usage: FIRST_USAGE };
    },
  };
}

function happyScenario(overrides = {}) {
  const calls = {
    sequence: [],
    reserve: [],
    refund: [],
    streamCalls: [],
    createCalls: [],
    usageRows: [],
    reviewRows: [],
    buildPromptCalls: [],
    abbreviations: [],
    skeleton: [],
    fetchTemplate: [],
    entitlement: [],
  };

  // Streamed first-pass text: contains "ACL sprain confirmed" but NOT
  // "Correlate clinically" — this is intentionally missing the opinion
  // phrase so most correction-path tests can reuse it; no-correction tests
  // override the streamed text to include both phrases.
  const streamChunks = [
    "MRI FINDINGS:\n- ACL sprain confirmed.\n\n",
    "OPINION:\n- Normal study otherwise.\n[PARTIAL NORMAL: drop this]",
  ];

  const deps = {
    supabase: { __client: "service" },
    anthropic: {
      messages: {
        stream(params, options) {
          calls.sequence.push("provider-stream");
          calls.streamCalls.push({ params, options });
          return fakeAnthropicStream(deps.__streamChunks ?? streamChunks);
        },
        create: async (params, options) => {
          calls.sequence.push("provider-create");
          calls.createCalls.push({ params, options });
          return {
            content: [{ type: "text", text: deps.__correctionText ?? "MRI FINDINGS:\n- ACL sprain confirmed.\n\nOPINION:\n- Correlate clinically.\n- Normal study otherwise." }],
            usage: CORRECTION_USAGE,
          };
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
      return { credits_used: 1, credits_limit: 300, credits_remaining: 299, plan: "pro", period_end: "2026-09-01T00:00:00.000Z" };
    },
    loadDatabaseAbbreviations: async (supabase, modality, bodyRegion, studyType) => {
      calls.sequence.push("abbreviations");
      calls.abbreviations.push({ modality, bodyRegion, studyType });
      return [{ abbreviation: "acl", finding_text: "anterior cruciate ligament" }];
    },
    getSkeleton: (modality, bodyRegion, studyType) => {
      calls.sequence.push("skeleton");
      calls.skeleton.push({ modality, bodyRegion, studyType });
      return { title: "SKELETON TITLE", technique: ["Sagittal T1"], findings: ["Skeleton finding"], opinion: "Skeleton opinion." };
    },
    fetchSelectedTemplate: async (supabase, id, modality) => {
      calls.sequence.push("fetch-template");
      calls.fetchTemplate.push({ id, modality });
      return TEMPLATE_ROW;
    },
    canUseFeature: async (userId, plan, feature) => {
      calls.sequence.push("entitlement");
      calls.entitlement.push({ userId, plan, feature });
      return true;
    },
    isNormalTemplateRow: (row) => row.is_normal === true,
    parseToPrompt: (text) => text,
    reserveCredits: async (_supabase, userId, mode) => {
      calls.sequence.push("reserve");
      calls.reserve.push({ userId, mode });
      return true;
    },
    refundCredits: async (_supabase, userId, mode) => {
      calls.refund.push({ userId, mode });
    },
    buildPrompt: (templates, promptInput) => {
      calls.sequence.push("prompt");
      calls.buildPromptCalls.push({ templates, promptInput });
      return { system: "SYSTEM", user: "USER", staticInstructions: "STATIC" };
    },
    logReportUsage: async (_supabase, row) => {
      calls.sequence.push("usage-log");
      calls.usageRows.push(row);
    },
    insertReportReview: async (_supabase, row) => {
      calls.sequence.push("review-log");
      calls.reviewRows.push(row);
      return "review-tg-123";
    },
    ...overrides,
  };

  return { calls, deps };
}

async function prepareAndRun(scenario, input = BASE_INPUT) {
  const prepared = await prepareTemplateGuidedReport(USER, input, scenario.deps);
  const events = [];
  if (prepared.ok) {
    await prepared.run(async (event) => events.push(event));
  }
  return { prepared, events };
}

const eventTypes = (events) => events.map((event) => event.type);

// ── 1. Normal success (no-correction path: both phrases present) ────────

function noCorrectionScenario(overrides = {}) {
  const scenario = happyScenario(overrides);
  scenario.deps.__streamChunks = [
    "MRI FINDINGS:\n- ACL sprain confirmed.\n\n",
    "OPINION:\n- Correlate clinically.\n- Normal study otherwise.\n[PARTIAL NORMAL: drop this]",
  ];
  return scenario;
}

test("1/17-20. normal success, no correction: exact SSE, no second call, exact final report", async () => {
  const scenario = noCorrectionScenario();
  const { prepared, events } = await prepareAndRun(scenario);

  assert.equal(prepared.ok, true);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "done"]);
  assert.equal(scenario.calls.createCalls.length, 0, "no second (correction) call when validation passes");
  const done = events.at(-1).data;
  assert.equal(done.final_report, "MRI FINDINGS:\n- ACL sprain confirmed.\n\nOPINION:\n- Correlate clinically.\n- Normal study otherwise.");
  assert.deepEqual(scenario.calls.refund, []);
});

// ── 2/3. Selected-template resolution: real DB row vs. skeleton-normal ──

test("2. real DB selected-template resolution feeds buildPrompt and templates_used=1", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.fetchTemplate, [{ id: "template-1", modality: "MRI" }]);
  const { templates } = scenario.calls.buildPromptCalls[0];
  assert.deepEqual(templates, [{ ...TEMPLATE_ROW, relevance_score: 999 }]);
  assert.equal(scenario.calls.usageRows[0].templates_used, 1);
});

test("3. skeleton-normal template resolution bypasses the DB fetch entirely", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, selected_template_id: "skeleton-normal:mri-knee" });
  assert.equal(scenario.calls.fetchTemplate.length, 0);
  // Two independent getSkeleton calls for an MRI skeleton-normal request —
  // preserved, current behavior: one for the MRI-technique lookup (always
  // runs when modality is MRI), one inside skeletonFullText's own resolution.
  assert.equal(scenario.calls.skeleton.length, 2);
  const { templates } = scenario.calls.buildPromptCalls[0];
  assert.equal(templates[0].id, "skeleton-normal:mri-knee");
  assert.equal(templates[0].pathology_category, "Normal");
  assert.match(templates[0].full_text, /SKELETON TITLE/);
});

test("skeleton-normal resolution throws setup-error when no skeleton exists for the study", async () => {
  const scenario = noCorrectionScenario({ getSkeleton: () => null });
  const { prepared } = await prepareAndRun(scenario, { ...BASE_INPUT, selected_template_id: "skeleton-normal:none" });
  assert.deepEqual(prepared, { ok: false, category: "setup-error", message: "Normal skeleton was not found for this study." });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

// ── 4. Hidden/deleted template rejection ─────────────────────────────────

test("4. hidden or deleted template is rejected with the current error text (fetch dep enforces it)", async () => {
  const scenario = noCorrectionScenario({
    fetchSelectedTemplate: async () => { throw new Error("Selected template was not found for this study."); },
  });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "setup-error", message: "Selected template was not found for this study." });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

// ── 5. Pathology entitlement rejection ────────────────────────────────────

test("5. a non-normal template without the pathology_reports feature is rejected", async () => {
  const scenario = noCorrectionScenario({ canUseFeature: async () => false });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "setup-error", message: "This template requires a plan upgrade." });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

test("a normal template never triggers the entitlement check", async () => {
  const scenario = noCorrectionScenario({
    fetchSelectedTemplate: async () => ({ ...TEMPLATE_ROW, is_normal: true }),
    canUseFeature: async () => { throw new Error("must not be called for normal templates"); },
  });
  const { prepared } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
});

// ── 6. Exact template_edits parsing ──────────────────────────────────────

test("6. template_edits is parsed via parseToPrompt with databaseAbbreviations before extractStrictStyleRequirements sees it", async () => {
  const scenario = noCorrectionScenario({
    parseToPrompt: (text, modality, region, abbreviations) => {
      scenario.calls.parseCalls = scenario.calls.parseCalls ?? [];
      scenario.calls.parseCalls.push({ text, modality, region, abbreviations });
      return `PARSED(${text})`;
    },
  });
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.parseCalls[0].text, TEMPLATE_EDITS_NO_TRIGGER);
  assert.equal(scenario.calls.parseCalls[0].modality, "MRI");
  assert.deepEqual(scenario.calls.parseCalls[0].abbreviations, [{ abbreviation: "acl", finding_text: "anterior cruciate ligament" }]);
});

test("empty/whitespace-only template_edits results in no strict requirements at all", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, template_edits: "   " });
  const promptInput = scenario.calls.buildPromptCalls[0].promptInput;
  assert.equal(promptInput.template_edits, undefined);
});

// ── 7/8. Database abbreviation + MRI technique behavior ─────────────────

test("7. loadDatabaseAbbreviations is called and genuinely feeds template_edits parsing (unlike My Template's dead call)", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.abbreviations, [{ modality: "MRI", bodyRegion: "MSK", studyType: "Knee" }]);
});

test("8. MRI technique lines are pulled from the skeleton and passed into the prompt input", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.mri_technique, ["Sagittal T1"]);
});

test("non-MRI modality never calls getSkeleton for technique and mri_technique is undefined", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, modality: "CT", selected_template_id: "skeleton-normal:x" });
  // getSkeleton is still called once for the skeleton-normal resolution itself,
  // but never for the (CT, so gated-off) MRI technique lookup.
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.mri_technique, undefined);
});

// ── 9. Raw-findings override behavior ────────────────────────────────────

test("9. buildPrompt receives raw findings, overriding the resolvePartialNormals'd inputPayload.findings", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, findings: "raw ACL finding" });
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.findings, "raw ACL finding");
});

// ── 10. Exact buildPrompt inputs ─────────────────────────────────────────

test("10. buildPrompt receives template_guided=true, my_template_mode=false, style_profile=null", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  const p = scenario.calls.buildPromptCalls[0].promptInput;
  assert.equal(p.template_guided, true);
  assert.equal(p.my_template_mode, false);
  assert.equal(p.style_profile, null);
  assert.deepEqual(p.style_examples, []);
});

// ── 11-16. First Anthropic call ──────────────────────────────────────────

test("11-16. exactly one streaming first call with exact model/settings/cache/header", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.streamCalls.length, 1);
  assert.deepEqual(scenario.calls.streamCalls[0], {
    params: {
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      temperature: 0,
      system: [
        { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
        { type: "text", text: "STATIC", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "USER" }],
    },
    options: { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } },
  });
});

// ── 17-20. No-correction path (see test 1 above for the core assertion) ──

test("18. zero second-call reservations of any kind when strict validation passes", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.createCalls.length, 0);
  assert.equal(scenario.calls.sequence.includes("provider-create"), false);
});

// ── 21-33. Correction path ───────────────────────────────────────────────

test("21. a missing structured finding phrase triggers correction", async () => {
  const scenario = happyScenario();
  scenario.deps.__streamChunks = ["MRI FINDINGS:\n- Something else entirely.\n\nOPINION:\n- Correlate clinically."];
  const { events } = await prepareAndRun(scenario);
  assert.equal(scenario.calls.createCalls.length, 1);
  assert.equal(eventTypes(events).includes("status"), true);
});

test("22. a missing opinion phrase triggers correction (default happyScenario fixture)", async () => {
  const scenario = happyScenario(); // default stream text omits "Correlate clinically"
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.createCalls.length, 1);
});

test("23. the status event carries msg: finalizing_style", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  const status = events.find((e) => e.type === "status");
  assert.deepEqual(status.data, { msg: "finalizing_style" });
});

test("24. exactly one second provider call", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.createCalls.length, 1);
});

test("25. the second call is blocking (messages.create), not streamed", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.sequence.filter((s) => s === "provider-create").length, 1);
  assert.equal(scenario.calls.sequence.filter((s) => s === "provider-stream").length, 1);
});

test("26-30. correction call configuration: same model, max_tokens 2048, temperature 0, hardcoded strict-editor system, no staticInstructions", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  const { params, options } = scenario.calls.createCalls[0];
  assert.equal(params.model, "claude-sonnet-4-6");
  assert.equal(params.max_tokens, 2048);
  assert.equal(params.temperature, 0);
  assert.deepEqual(params.system, [
    { type: "text", text: "You are a strict radiology report editor. Obey protected wording exactly.", cache_control: { type: "ephemeral" } },
  ]);
  assert.equal(options.headers["anthropic-beta"], "prompt-caching-2024-07-31");
});

test("31. exact strict-correction user prompt is built from buildStrictCorrectionPrompt with the first-pass report and requirements", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  const content = scenario.calls.createCalls[0].params.messages[0].content;
  assert.match(content, /Correct the radiology report below/);
  assert.match(content, /PROTECTED FINDING PHRASES:/);
  assert.match(content, /ACL sprain confirmed/);
  assert.match(content, /PROTECTED OPINION PHRASES:/);
  assert.match(content, /Correlate clinically/);
  assert.match(content, /REPORT TO CORRECT:/);
});

test("32. correction text is never emitted as a delta event", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  const deltaTexts = events.filter((e) => e.type === "delta").map((e) => e.data.t);
  assert.ok(!deltaTexts.some((t) => t.includes("Correlate clinically") && !t.includes("Normal study otherwise")),
    "the corrected opinion phrase must only appear via done.final_report, never as a delta");
});

test("33. exact SSE sequence when correction runs: prelude, delta*, status, done", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "status", "done"]);
});

// ── 34-37. Strict deterministic fallback ─────────────────────────────────

test("34/35. correction still missing a protected phrase triggers the deterministic enforceStrictStyle fallback", async () => {
  const scenario = happyScenario({ });
  scenario.deps.__correctionText = "MRI FINDINGS:\n- ACL sprain confirmed.\n\nOPINION:\n- Still no mention of the required phrase.";
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.match(done.final_report, /Correlate clinically/, "enforceStrictStyle must have deterministically inserted the missing phrase");
  assert.equal(done.style_validation.corrected, true);
});

test("36. final report parity: the fallback-inserted text is what's stored in report_reviews too", async () => {
  const scenario = happyScenario();
  scenario.deps.__correctionText = "MRI FINDINGS:\n- ACL sprain confirmed.\n\nOPINION:\n- Still missing it.";
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.equal(scenario.calls.reviewRows[0].original_report, done.final_report);
});

test("37. unknown-token-only requirements do not trigger correction (missingFindings/missingOpinions both empty)", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario, {
    ...BASE_INPUT,
    template_edits: "Some notes.\n[Unrecognised tokens: FooBar]",
  });
  assert.equal(scenario.calls.createCalls.length, 0, "unknown-tokens-only must not trigger the correction call");
});

// ── 38-44. Accounting ─────────────────────────────────────────────────────

test("38. first-call-only usage accounting when no correction runs", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.usageRows[0].input_tokens, 100);
  assert.equal(scenario.calls.usageRows[0].output_tokens, 400);
  assert.equal(scenario.calls.usageRows[0].cached_tokens, 300);
  assert.equal(scenario.calls.usageRows[0].estimated_cost_usd, NO_CORRECTION_COST);
});

test("39-44. two-call aggregation sums all four token categories exactly once each, cost computed on the final aggregate", async () => {
  const scenario = happyScenario();
  scenario.deps.__correctionText = "MRI FINDINGS:\n- ACL sprain confirmed.\n\nOPINION:\n- Correlate clinically.\n- Normal study otherwise.";
  const { events } = await prepareAndRun(scenario);
  assert.equal(scenario.calls.usageRows[0].input_tokens, 150); // 100 + 50, once each
  assert.equal(scenario.calls.usageRows[0].output_tokens, 480); // 400 + 80
  assert.equal(scenario.calls.usageRows[0].cached_tokens, 320); // 300 + 20 (cache_read)
  assert.equal(scenario.calls.usageRows[0].estimated_cost_usd, TWO_CALL_COST); // includes cache_creation 200+10=210
  const done = events.at(-1).data;
  assert.equal(done.credits_remaining, 298); // unaffected by two-call accounting — still 1 credit
});

test("45. mode = template_guided", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.usageRows[0].mode, "template_guided");
});

test("46. templates_used = 1", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.usageRows[0].templates_used, 1);
});

test("47. report_chars = finalReportText.length (current behavior, differs from My Template's hardcoded 0)", async () => {
  const scenario = noCorrectionScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.equal(scenario.calls.usageRows[0].report_chars, done.final_report.length);
  assert.ok(scenario.calls.usageRows[0].report_chars > 0);
});

test("48. report_reviews.report_mode = 'template' (preserved naming inconsistency vs. usage-log's 'template_guided')", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.reviewRows[0].report_mode, "template");
});

// ── 49-62. Credits / refunds ──────────────────────────────────────────────

test("49/50. fast bucket, one-credit cost", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.reserve, [{ userId: USER.id, mode: "fast" }]);
});

test("51. early insufficient balance returns credits-exhausted before any reservation/provider call", async () => {
  const scenario = happyScenario({
    getOrCreateUsage: async () => ({ credits_used: 300, credits_limit: 300, credits_remaining: 0, plan: "free", period_end: "2026-09-01T00:00:00.000Z" }),
    getUserPlan: async () => ({ plan: "free", current_period_end: null }),
  });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "credits-exhausted", credits_remaining: 0, credits_limit: 300, plan: "free", upgrade_required: true });
  assert.deepEqual(scenario.calls.reserve, []);
  assert.equal(scenario.calls.streamCalls.length, 0);
});

test("52. atomic reservation miss (race lost) returns credits-exhausted, no provider call", async () => {
  const scenario = happyScenario({ reserveCredits: async () => false });
  const { prepared } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.category, "credits-exhausted");
  assert.equal(scenario.calls.streamCalls.length, 0);
});

test("53. reservation throws returns credit-reservation-failed, no refund attempt", async () => {
  const scenario = happyScenario({ reserveCredits: async () => { throw new Error("db down"); } });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "credit-reservation-failed" });
  assert.deepEqual(scenario.calls.refund, []);
});

test("54. setup failure after reservation (buildPrompt throws) refunds via the outer path and returns setup-error", async () => {
  const scenario = noCorrectionScenario({ buildPrompt: () => { throw new Error("prompt builder exploded"); } });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "setup-error", message: "prompt builder exploded" });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

test("55. first provider (stream) failure refunds exactly once and emits error, no done", async () => {
  const scenario = noCorrectionScenario({
    anthropic: {
      messages: {
        stream() {
          return { async *[Symbol.asyncIterator]() { throw new Error("stream dropped"); } };
        },
        create: async () => { throw new Error("must not be called"); },
      },
    },
  });
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "error"]);
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

test("56. correction provider-call failure refunds exactly once, entire generation fails, no partial success", async () => {
  const scenario = happyScenario({
    anthropic: {
      messages: {
        stream(params, options) {
          scenario.calls.streamCalls.push({ params, options });
          return fakeAnthropicStream(["MRI FINDINGS:\n- Something else.\n\nOPINION:\n- Nothing matching."]);
        },
        create: async () => { throw new Error("correction call failed"); },
      },
    },
  });
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "status", "error"]);
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
  assert.equal(scenario.calls.usageRows.length, 0, "no usage-log write when the whole generation fails");
});

test("57. an emit() failure on the done event refunds exactly once (streamSucceeded only flips after done resolves)", async () => {
  const scenario = noCorrectionScenario();
  const prepared = await prepareTemplateGuidedReport(USER, BASE_INPUT, scenario.deps);
  assert.equal(prepared.ok, true);
  await assert.doesNotReject(async () => {
    await prepared.run(async (event) => {
      if (event.type === "done") throw new Error("client disconnected");
    });
  });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

test("58/59. exactly-once refund, never double, across the setup-error path", async () => {
  const scenario = noCorrectionScenario({ buildPrompt: () => { throw new Error("boom"); } });
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.refund.length, 1);
});

test("60. a fully successful generation is never refunded", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.refund, []);
});

test("61. usage persistence failure (resolved or thrown) remains non-fatal and does not refund", async () => {
  const resolvedScenario = noCorrectionScenario({ logReportUsage: async () => {} });
  const { prepared: p1, events: e1 } = await prepareAndRun(resolvedScenario);
  assert.equal(p1.ok, true);
  assert.equal(eventTypes(e1).at(-1), "done");
  assert.deepEqual(resolvedScenario.calls.refund, []);

  const throwingScenario = noCorrectionScenario({ logReportUsage: async () => { throw new Error("insert exploded"); } });
  const { prepared: p2, events: e2 } = await prepareAndRun(throwingScenario);
  assert.equal(p2.ok, true);
  assert.equal(eventTypes(e2).at(-1), "done");
  assert.deepEqual(throwingScenario.calls.refund, []);
});

test("62. a report_reviews insert failure (null id) is non-fatal — done still fires with review_id null", async () => {
  const scenario = noCorrectionScenario({ insertReportReview: async () => null });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  const done = events.at(-1).data;
  assert.equal(done.review_id, null);
});

// ── 63-68. Output / cleanup / SSE payload ────────────────────────────────

test("63/64/65. PARTIAL NORMAL is stripped and opinion bullets deduplicated before persistence", async () => {
  const scenario = happyScenario();
  scenario.deps.__streamChunks = [
    "MRI FINDINGS:\n- ACL sprain confirmed.\n\n",
    "OPINION:\n- Correlate clinically.\n- Correlate clinically.\n[PARTIAL NORMAL: drop this]",
  ];
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.doesNotMatch(done.final_report, /PARTIAL NORMAL/);
  const bulletCount = (done.final_report.match(/- Correlate clinically\./g) ?? []).length;
  assert.equal(bulletCount, 1);
});

test("66. exact final formatting: opinion-order enforcement runs before cleanup", async () => {
  const scenario = noCorrectionScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.equal(done.final_report, "MRI FINDINGS:\n- ACL sprain confirmed.\n\nOPINION:\n- Correlate clinically.\n- Normal study otherwise.");
});

test("67. exact done payload field set", async () => {
  const scenario = noCorrectionScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.deepEqual(Object.keys(done).sort(), [
    "category", "confidence", "credits_limit", "credits_remaining",
    "final_report", "review_id", "style_validation", "template_names",
  ].sort());
});

test("68. exact style_validation payload shape for both the passing and corrected cases", async () => {
  const passing = noCorrectionScenario();
  const { events: e1 } = await prepareAndRun(passing);
  assert.deepEqual(e1.at(-1).data.style_validation, { passed: true, corrected: false, issues: [], unknown_tokens: [] });

  const corrected = happyScenario();
  const { events: e2 } = await prepareAndRun(corrected);
  const sv = e2.at(-1).data.style_validation;
  assert.equal(sv.passed, true);
  assert.equal(sv.corrected, true);
});

// ── 69-74. Trust boundary ──────────────────────────────────────────────────

test("69-73. selected_template_id stays client-supplied, content stays server-fetched, hidden/deleted + plan gate preserved, no ownership filter", async () => {
  const source = await readFile(
    new URL("../src/lib/reporting/template-guided-generation.ts", import.meta.url), "utf8"
  );
  assert.match(source, /selected_template_id: string/, "selected_template_id remains the only client-supplied template identifier");
  assert.match(source, /is_hidden/);
  assert.match(source, /deleted_at/);
  assert.match(source, /pathology_reports/);
  assert.doesNotMatch(source, /\.eq\(\s*["']user_id["']/, "no user_id ownership filter must be added to the template fetch");
  assert.doesNotMatch(source, /user_template_id/);
});

test("74. no provenance/security redesign: the module still trusts the server-fetched row's content directly", async () => {
  const scenario = noCorrectionScenario();
  await prepareAndRun(scenario);
  // The synthetic matched_templates entry is built straight from the fetched
  // row with no additional verification step inserted.
  const { templates } = scenario.calls.buildPromptCalls[0];
  assert.deepEqual(templates[0].findings_text, TEMPLATE_ROW.findings_text);
});
