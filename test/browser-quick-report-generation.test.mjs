import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  matchQuickStyleReferences,
  prepareQuickReport,
} = await import("@/lib/reporting/quick-report-generation");

const USER = { id: "quick-user-123", email: "radiologist@example.com" };
const BASE_INPUT = {
  modality: "MRI",
  body_region: "MSK",
  indication: "Knee pain.",
  findings: "ACL sprain\nMedial meniscus tear",
  field_strength: "HIGH FIELD (3.0 TESLA)",
  study_type: "Knee",
  laterality: "Right",
  age: 47,
  sex: "Female",
  model: "claude-sonnet-4-6",
  opinion_hints: "",
  residual_opinion_hints: "",
  preserve_findings_order: false,
};

const TOKEN_USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 300,
  output_tokens: 400,
};

function template(id, overrides = {}) {
  return {
    id,
    file_name: `${id}.txt`,
    body_region: "MSK",
    modality: "MRI",
    pathology_category: "Ligament",
    pathology_name: id,
    findings_text: `FINDINGS ${id}`,
    opinion_text: `OPINION ${id}`,
    full_text: `FULL ${id}`,
    keywords: [],
    relevance_score: 10,
    ...overrides,
  };
}

function fakeAnthropicStream(chunks = [
  "MRI FINDINGS:\n- Meniscus output.\n- ACL output.\n\n\nOPINION:\n- ACL sprain.\n",
  "- acl sprain!\n- Meniscus tear.\n[PARTIAL NORMAL: remove this]",
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
    skeleton: [],
    matcher: [],
    entitlement: [],
    expand: [],
    segment: [],
    parse: [],
    prompt: [],
    provider: [],
    reserve: [],
    refund: [],
    usageRows: [],
    reviewRows: [],
    reorder: [],
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
    getSkeleton: (modality, bodyRegion, studyType) => {
      calls.sequence.push("skeleton");
      calls.skeleton.push({ modality, bodyRegion, studyType });
      return {
        title: "MRI RIGHT KNEE",
        technique: ["Sagittal T1", "Coronal PD fat-suppressed"],
        findings: ["Normal marrow signal.", "Intact collateral ligaments."],
        opinion: "No significant abnormality.",
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
    canUseFeature: async (userId, plan, feature) => {
      calls.sequence.push("entitlement");
      calls.entitlement.push({ userId, plan, feature });
      return true;
    },
    matchTemplates: async (_supabase, input, options) => {
      calls.matcher.push({ input, options });
      const index = calls.matcher.length;
      return {
        matched_templates: [template(`template-${index}`)],
        match_confidence: index === 1 ? "medium" : "high",
        pathology_category: "Ignored",
        query_terms: index === 1 ? ["acl", "knee"] : ["meniscus", "knee"],
      };
    },
    isNormalTemplateRow: (row) => row.is_normal === true,
    isRegionMismatch: () => false,
    cleanTemplateText: (text) => `clean(${text})`,
    expandForSegmentMatching: (finding, modality, region) => {
      calls.expand.push({ finding, modality, region });
      return `expanded(${finding})`;
    },
    selectSegmentForFinding: (finding, findingsText, opinionText, fullText) => {
      calls.segment.push({ finding, findingsText, opinionText, fullText });
      return { findings: `segment(${finding})`, opinion: `segment-opinion(${finding})` };
    },
    parseToPrompt: (text, modality, bodyRegion, abbreviations) => {
      calls.sequence.push("parse");
      calls.parse.push({ text, modality, bodyRegion, abbreviations });
      return `parsed(${text})`;
    },
    buildQuickReportPrompt: (input) => {
      calls.sequence.push("prompt");
      calls.prompt.push(input);
      return { system: "SYSTEM", user: "USER", staticInstructions: "STATIC" };
    },
    reorderQuickReportBullets: (text, findings, modality, region) => {
      calls.sequence.push("reorder");
      calls.reorder.push({ text, findings, modality, region });
      return { text: `REORDERED\n${text}`, reordered: true, ambiguous: false };
    },
    logReportUsage: async (_supabase, row) => {
      calls.sequence.push("usage-log");
      calls.usageRows.push(row);
    },
    insertReportReview: async (_supabase, row) => {
      calls.sequence.push("review-log");
      calls.reviewRows.push(row);
      return "review-quick-123";
    },
    ...overrides,
  };

  return { calls, deps };
}

async function prepareAndRun(scenario, input = BASE_INPUT, emitOverride) {
  const prepared = await prepareQuickReport(USER, input, scenario.deps);
  const events = [];
  if (prepared.ok) {
    await prepared.run(emitOverride ?? (async (event) => events.push(event)));
  }
  return { prepared, events };
}

const eventTypes = (events) => events.map((event) => event.type);

test("canonical Quick flow freezes normalization, matching, prompt, provider, accounting, persistence, cleanup, and events", async () => {
  const scenario = happyScenario();
  const { prepared, events } = await prepareAndRun(scenario);

  assert.equal(prepared.ok, true);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "done"]);
  assert.equal(events[0].text, `: ${" ".repeat(2048)}\n\n`);
  assert.deepEqual(scenario.calls.sequence, [
    "rate-limit", "plan", "usage", "skeleton", "reserve", "entitlement",
    "parse", "prompt", "provider", "usage-log", "reorder", "review-log",
  ]);
  assert.deepEqual(scenario.calls.skeleton, [{ modality: "MRI", bodyRegion: "MSK", studyType: "Knee" }]);
  assert.deepEqual(scenario.calls.reserve, [{ userId: USER.id, mode: "fast" }]);
  assert.deepEqual(scenario.calls.entitlement, [{ userId: USER.id, plan: "pro", feature: "pathology_reports" }]);
  assert.equal(scenario.calls.matcher.length, 2);
  assert.deepEqual(scenario.calls.matcher.map(({ input, options }) => ({ findings: input.findings, options })), [
    { findings: "ACL sprain", options: { limit: 20 } },
    { findings: "Medial meniscus tear", options: { limit: 20 } },
  ]);
  assert.deepEqual(scenario.calls.matcher[0].input, {
    modality: "MRI",
    body_region: "MSK",
    indication: "Knee pain.",
    findings: "ACL sprain",
    field_strength: "HIGH FIELD (3.0 TESLA)",
    study_type: "Knee",
    age: 47,
    sex: "Female",
    laterality: "Right",
    report_header: "MRI RIGHT KNEE",
    opinion_hints: "",
    preserve_findings_order: false,
    template_guided: false,
    my_template_mode: false,
    template_edits: undefined,
    mri_technique: ["Sagittal T1", "Coronal PD fat-suppressed"],
    normal_skeleton_findings: ["Normal marrow signal.", "Intact collateral ligaments."],
    style_profile: null,
    style_examples: [],
  });
  assert.deepEqual(scenario.calls.parse, [{
    text: "ACL sprain\nMedial meniscus tear",
    modality: "MRI",
    bodyRegion: "MSK",
    abbreviations: [],
  }]);
  assert.deepEqual(scenario.calls.prompt[0], {
    ...scenario.calls.matcher[0].input,
    findings: "parsed(ACL sprain\nMedial meniscus tear)",
    style_reference_templates: [
      { ...template("template-1"), matched_segment_findings: "segment(expanded(ACL sprain))", matched_segment_opinion: "segment-opinion(expanded(ACL sprain))" },
      { ...template("template-2"), matched_segment_findings: "segment(expanded(Medial meniscus tear))", matched_segment_opinion: "segment-opinion(expanded(Medial meniscus tear))" },
    ],
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
    mode: "quick_report",
    modality: "MRI",
    body_region: "MSK",
    study_type: "Knee",
    input_tokens: 100,
    output_tokens: 400,
    cached_tokens: 300,
    estimated_cost_usd: 0.00714,
    templates_used: 0,
    report_chars: 0,
  }]);

  const cleanedBeforeReorder = "MRI FINDINGS:\n- Meniscus output.\n- ACL output.\n\nOPINION:\n- ACL sprain.\n- Meniscus tear.";
  assert.deepEqual(scenario.calls.reorder, [{
    text: cleanedBeforeReorder,
    findings: ["ACL sprain", "Medial meniscus tear"],
    modality: "MRI",
    region: "Knee",
  }]);
  const done = events.at(-1).data;
  assert.deepEqual(done, {
    final_report: `REORDERED\n${cleanedBeforeReorder}`,
    review_id: "review-quick-123",
    credits_remaining: 298,
    credits_limit: 300,
    confidence: "high",
    category: "Quick Report",
    style_validation: null,
  });
  assert.equal(Object.hasOwn(done, "template_names"), false);
  assert.deepEqual(scenario.calls.reviewRows, [{
    user_id: USER.id,
    user_email: USER.email,
    modality: "MRI",
    body_region: "MSK",
    study_type: "Knee",
    report_mode: "quick",
    model: "claude-sonnet-4-6",
    category: "Quick Report",
    template_names: [],
    original_report: done.final_report,
    input_tokens: 100,
    output_tokens: 400,
    estimated_cost_usd: 0.00714,
  }]);
  assert.deepEqual(scenario.calls.refund, []);
});

test("missing skeleton falls back without title, MRI technique, or normal baseline", async () => {
  const scenario = happyScenario({ getSkeleton: () => null });
  await prepareAndRun(scenario);
  const prompt = scenario.calls.prompt[0];
  assert.equal(prompt.report_header, undefined);
  assert.equal(prompt.mri_technique, undefined);
  assert.equal(prompt.normal_skeleton_findings, undefined);
});

test("non-MRI skeleton supplies title and normal baseline but no MRI technique", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, modality: "CT", field_strength: undefined });
  const prompt = scenario.calls.prompt[0];
  assert.equal(prompt.report_header, "MRI RIGHT KNEE");
  assert.equal(prompt.mri_technique, undefined);
  assert.deepEqual(prompt.normal_skeleton_findings, ["Normal marrow signal.", "Intact collateral ligaments."]);
});

test("resolvePartialNormals runs before splitting/matching while parseToPrompt keeps the raw current input and an empty abbreviation list", async () => {
  const scenario = happyScenario();
  const findings = "The spleen is enlarged.\n[PARTIAL NORMAL: Normal appearance of the spleen, pancreas and adrenal glands.]";
  await prepareAndRun(scenario, { ...BASE_INPUT, modality: "CT", body_region: "Abdomen", study_type: "Abdomen", findings });
  assert.equal(scenario.calls.parse[0].text, findings);
  const matchedLines = scenario.calls.matcher.map((call) => call.input.findings);
  assert.notDeepEqual(matchedLines, findings.split("\n"));
  assert.doesNotMatch(matchedLines[1], /spleen/i);
  assert.doesNotMatch(matchedLines.join("\n"), /PARTIAL NORMAL/i);
  assert.deepEqual(scenario.calls.parse[0].abbreviations, []);
});

test("per-finding matching starts concurrently and preserves input order when completion order differs", async () => {
  const gates = [];
  const started = [];
  const scenario = happyScenario({
    matchTemplates: async (_supabase, input, options) => {
      started.push(input.findings);
      const gate = Promise.withResolvers();
      gates.push({ finding: input.findings, options, ...gate });
      return gate.promise;
    },
  });
  const preparing = prepareQuickReport(USER, { ...BASE_INPUT, findings: "first\nsecond\nthird" }, scenario.deps);
  while (gates.length < 3) await Promise.resolve();
  assert.deepEqual(started, ["first", "second", "third"]);
  for (const index of [2, 0, 1]) {
    gates[index].resolve({
      matched_templates: [template(gates[index].finding)],
      match_confidence: "low",
      pathology_category: "ignored",
      query_terms: [gates[index].finding],
    });
  }
  const prepared = await preparing;
  assert.equal(prepared.ok, true);
  assert.deepEqual(gates.map((gate) => gate.options), [{ limit: 20 }, { limit: 20 }, { limit: 20 }]);
  assert.deepEqual(scenario.calls.prompt[0].style_reference_templates.map((row) => row.id), ["first", "second", "third"]);
});

test("free users filter pathology references instead of receiving an upgrade rejection", async () => {
  const scenario = happyScenario({
    getUserPlan: async () => ({ plan: "free", current_period_end: null }),
    canUseFeature: async () => false,
    matchTemplates: async () => ({
      matched_templates: [
        template("pathology"),
        template("normal", { is_normal: true, pathology_category: "Normal" }),
      ],
      match_confidence: "medium",
      pathology_category: "ignored",
      query_terms: ["safe"],
    }),
  });
  const { prepared } = await prepareAndRun(scenario, { ...BASE_INPUT, findings: "single finding" });
  assert.equal(prepared.ok, true);
  assert.deepEqual(scenario.calls.prompt[0].style_reference_templates.map((row) => row.id), ["normal"]);
});

test("region mismatch is skipped, segments are selected, duplicate segments are removed, and references cap at eight", async () => {
  let index = 0;
  const scenario = happyScenario({
    matchTemplates: async () => {
      index += 1;
      return {
        matched_templates: [template(`wrong-${index}`), template(`right-${index}`)],
        match_confidence: index === 2 ? "high" : index === 3 ? "medium" : "low",
        pathology_category: "ignored",
        query_terms: ["shared", `q${index}`],
      };
    },
    isRegionMismatch: (haystack) => haystack.includes("wrong"),
    selectSegmentForFinding: (finding) => ({
      findings: finding.includes("duplicate") ? "duplicate-segment" : `segment-${finding}`,
      opinion: null,
    }),
  });
  const findings = ["duplicate-one", "duplicate-two", ...Array.from({ length: 9 }, (_, i) => `finding-${i}`)].join("\n");
  const { events } = await prepareAndRun(scenario, { ...BASE_INPUT, findings });
  const refs = scenario.calls.prompt[0].style_reference_templates;
  assert.equal(refs.length, 8);
  assert.equal(refs.filter((row) => row.matched_segment_findings === "duplicate-segment").length, 1);
  assert.equal(events.at(-1).data.confidence, "high");
  assert.deepEqual(scenario.calls.prompt[0].style_reference_templates.map((row) => row.id).slice(0, 2), ["right-1", "right-3"]);
});

test("confidence and query terms aggregate from successful matcher results in current order", async () => {
  let index = 0;
  const result = await matchQuickStyleReferences(USER, "pro", {
    modality: "CT", body_region: "Chest", indication: "", findings: "one\ntwo\nthree",
  }, {
    supabase: {},
    canUseFeature: async () => true,
    matchTemplates: async () => {
      index += 1;
      return {
        matched_templates: [],
        match_confidence: index === 2 ? "medium" : "low",
        pathology_category: "ignored",
        query_terms: index === 1 ? ["shared", "one"] : index === 2 ? ["two", "shared"] : ["three"],
      };
    },
    isNormalTemplateRow: () => true,
    isRegionMismatch: () => false,
    cleanTemplateText: (text) => text,
    expandForSegmentMatching: (text) => text,
    selectSegmentForFinding: () => null,
  });
  assert.equal(result.match_confidence, "medium");
  assert.deepEqual(result.query_terms, ["shared", "one", "two", "three"]);
  assert.deepEqual(result.matched_templates, []);
});

test("individual matcher failure is skipped; whole matching failure degrades to skeleton-only with high confidence", async () => {
  let call = 0;
  const individual = happyScenario({
    matchTemplates: async () => {
      call += 1;
      if (call === 1) throw new Error("one matcher failed");
      return { matched_templates: [template("survivor")], match_confidence: "medium", pathology_category: "ignored", query_terms: ["survivor"] };
    },
  });
  const individualResult = await prepareAndRun(individual);
  assert.deepEqual(individual.calls.prompt[0].style_reference_templates.map((row) => row.id), ["survivor"]);
  assert.equal(individualResult.events.at(-1).data.confidence, "medium");

  const whole = happyScenario({ canUseFeature: async () => { throw new Error("entitlement unavailable"); } });
  const wholeResult = await prepareAndRun(whole);
  assert.deepEqual(whole.calls.prompt[0].style_reference_templates, []);
  assert.equal(wholeResult.events.at(-1).data.confidence, "high");
  assert.equal(wholeResult.events.at(-1).data.category, "Quick Report");
});

test("rate limit and early insufficient credits stop before skeleton, reservation, matching, and provider use", async () => {
  const limited = happyScenario({ checkReportRateLimit: async () => ({ limited: true, retryAfterSeconds: 31 }) });
  const limitedResult = await prepareAndRun(limited);
  assert.deepEqual(limitedResult.prepared, { ok: false, category: "rate-limited", retry_after_seconds: 31 });
  assert.equal(limited.calls.skeleton.length, 0);
  assert.equal(limited.calls.reserve.length, 0);

  const exhausted = happyScenario({
    getUserPlan: async () => ({ plan: "free", current_period_end: null }),
    getOrCreateUsage: async () => ({ credits_used: 10, credits_limit: 10, credits_remaining: 0, plan: "free", period_end: null }),
  });
  const exhaustedResult = await prepareAndRun(exhausted);
  assert.deepEqual(exhaustedResult.prepared, {
    ok: false, category: "credits-exhausted", credits_remaining: 0,
    credits_limit: 10, plan: "free", upgrade_required: true,
  });
  assert.equal(exhausted.calls.skeleton.length, 0);
  assert.equal(exhausted.calls.reserve.length, 0);
});

test("atomic reservation miss and exception are HTTP-mappable and never refunded", async () => {
  const missed = happyScenario({ reserveCredits: async () => false });
  const missedResult = await prepareAndRun(missed);
  assert.deepEqual(missedResult.prepared, {
    ok: false, category: "credits-exhausted", credits_remaining: 0,
    credits_limit: 300, plan: "pro", upgrade_required: false,
  });
  assert.deepEqual(missed.calls.refund, []);

  const errored = happyScenario({ reserveCredits: async () => { throw new Error("reservation unavailable"); } });
  const erroredResult = await prepareAndRun(errored);
  assert.deepEqual(erroredResult.prepared, { ok: false, category: "credit-reservation-failed" });
  assert.deepEqual(errored.calls.refund, []);
});

test("setup failure after reservation refunds exactly once", async () => {
  const scenario = happyScenario({ buildQuickReportPrompt: () => { throw new Error("prompt setup failed"); } });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "setup-error", message: "prompt setup failed" });
  assert.deepEqual(events, []);
  assert.equal(scenario.calls.refund.length, 1);
  assert.equal(scenario.calls.provider.length, 0);
});

test("provider and event-sink failure emit no done and refund exactly once", async () => {
  const provider = happyScenario({
    anthropic: { messages: { stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
          throw new Error("provider stream failed");
        },
        async finalMessage() { throw new Error("unreachable"); },
      };
    } } },
  });
  const providerResult = await prepareAndRun(provider);
  assert.deepEqual(eventTypes(providerResult.events), ["prelude", "delta", "error"]);
  assert.equal(providerResult.events.some((event) => event.type === "done"), false);
  assert.equal(provider.calls.refund.length, 1);

  const sink = happyScenario();
  const prepared = await prepareQuickReport(USER, BASE_INPUT, sink.deps);
  let writes = 0;
  await prepared.run(async () => {
    writes += 1;
    if (writes >= 2) throw new Error("browser disconnected");
  });
  assert.equal(sink.calls.refund.length, 1);
});

test("usage persistence failure and returned review DB error remain non-fatal; thrown review transport failure refunds", async () => {
  const usage = happyScenario({ logReportUsage: async () => { throw new Error("usage insert failed"); } });
  const usageResult = await prepareAndRun(usage);
  assert.equal(usageResult.events.at(-1).type, "done");
  assert.deepEqual(usage.calls.refund, []);

  const returned = happyScenario({ insertReportReview: async () => null });
  const returnedResult = await prepareAndRun(returned);
  assert.equal(returnedResult.events.at(-1).data.review_id, null);
  assert.deepEqual(returned.calls.refund, []);

  const thrown = happyScenario({ insertReportReview: async () => { throw new Error("review transport failed"); } });
  const thrownResult = await prepareAndRun(thrown);
  assert.deepEqual(eventTypes(thrownResult.events), ["prelude", "delta", "delta", "error"]);
  assert.equal(thrown.calls.refund.length, 1);
});

test("opinion hints run before marker removal/deduplication/whitespace cleanup and bullet reorder", async () => {
  const scenario = happyScenario({
    anthropic: { messages: { stream() { return fakeAnthropicStream([
      "MRI FINDINGS:\n- Finding.\n\n\nOPINION:\n- AI only.\n- Residual normal.\n[PARTIAL NORMAL: remove]",
    ]); } } },
  });
  await prepareAndRun(scenario, {
    ...BASE_INPUT,
    opinion_hints: "- **Selected pathology.**",
    residual_opinion_hints: "- **Residual normal.**",
  });
  assert.equal(scenario.calls.reorder[0].text,
    "MRI FINDINGS:\n- Finding.\n\nOPINION:\n\n- **Selected pathology.**\n- **AI only.**\n- **Residual normal.**");
});

test("ambiguous reorder output is preserved exactly", async () => {
  const scenario = happyScenario({
    reorderQuickReportBullets: (text) => ({ text, reordered: false, ambiguous: true }),
  });
  const { events } = await prepareAndRun(scenario);
  assert.equal(events.at(-1).data.final_report.startsWith("MRI FINDINGS:"), true);
});

test("Quick orchestration has no style-profile, personal-template, similar-report, or database-abbreviation retrieval dependency", async () => {
  const source = await readFile(new URL("../src/lib/reporting/quick-report-generation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /retrieveSimilarUserTemplates|user_reporting_style_profiles|loadDatabaseAbbreviations/);
  assert.match(source, /parseToPromptFn\([\s\S]*?\[\]/);
});
