import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  prepareMyTemplateReport,
} = await import("../src/lib/reporting/my-template-generation.ts");

const USER = { id: "my-template-user-123", email: "radiologist@example.com" };

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
  user_template_text: "Baseline findings text.",
  user_template_conclusion: "OPINION:\n- Normal study.",
  user_template_title: "My Knee Template",
  template_edits: "ACL sprain noted.",
  use_reporting_style_profile: true,
};

const TOKEN_USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 300,
  output_tokens: 400,
};
const EXPECTED_COST = 0.00714;

function fakeAnthropicStream(chunks = [
  "FINDINGS:\n- ACL sprain noted.\n\nOPINION:\n- ACL sprain.\n",
  "- ACL sprain.\n[PARTIAL NORMAL: remove this]",
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
    rateLimit: 0,
    reserve: [],
    refund: [],
    provider: [],
    usageRows: [],
    reviewRows: [],
    styleProfileFetch: 0,
    similarTemplates: [],
    qualityCheck: [],
    buildPromptCalls: [],
    abbreviations: [],
    skeleton: [],
  };

  const deps = {
    supabase: { __client: "service" },
    supabaseAuth: { __client: "authenticated" },
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
        credits_used: 1, credits_limit: 300, credits_remaining: 299,
        plan: "pro", period_end: "2026-09-01T00:00:00.000Z",
      };
    },
    loadDatabaseAbbreviations: async (supabase, modality, bodyRegion, studyType) => {
      calls.sequence.push("abbreviations");
      calls.abbreviations.push({ modality, bodyRegion, studyType });
      return [{ abbreviation: "unused", finding_text: "unused" }];
    },
    getSkeleton: (modality, bodyRegion, studyType) => {
      calls.sequence.push("skeleton");
      calls.skeleton.push({ modality, bodyRegion, studyType });
      return { title: "SKELETON TITLE", technique: ["Sagittal T1"], findings: ["Skeleton finding"], opinion: "Skeleton opinion." };
    },
    fetchStyleProfile: async (supabase, userId) => {
      calls.sequence.push("style-profile");
      calls.styleProfileFetch += 1;
      return { summary: "Formal, bulleted style.", conclusion_header: "OPINION:" };
    },
    retrieveSimilarUserTemplates: async (args) => {
      calls.sequence.push("similar-reports");
      calls.similarTemplates.push(args);
      return [
        { user_template_id: "t1", title: "Other template", findings_text: "Different findings text.", conclusion_text: "Conclusion.", similarity: 0.9 },
        { user_template_id: "t2", title: "Self", findings_text: "Baseline findings text.", conclusion_text: "Self conclusion.", similarity: 0.99 },
      ];
    },
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
    runMyTemplateQualityCheck: (qcInput) => {
      calls.sequence.push("quality-check");
      calls.qualityCheck.push(qcInput);
      return { cleanedText: `CLEANED(${qcInput.reportText})`, warnings: ["Detected a possible leftover normal phrase."] };
    },
    logReportUsage: async (_supabase, row) => {
      calls.sequence.push("usage-log");
      calls.usageRows.push(row);
    },
    insertReportReview: async (_supabase, row) => {
      calls.sequence.push("review-log");
      calls.reviewRows.push(row);
      return "review-my-template-123";
    },
    ...overrides,
  };

  return { calls, deps };
}

async function prepareAndRun(scenario, input = BASE_INPUT, emitOverride) {
  const prepared = await prepareMyTemplateReport(USER, input, scenario.deps);
  const events = [];
  if (prepared.ok) {
    await prepared.run(emitOverride ?? (async (event) => events.push(event)));
  }
  return { prepared, events };
}

const eventTypes = (events) => events.map((event) => event.type);

// ── 1/29. Canonical happy path — freezes the entire pipeline ────────────

test("canonical My Template flow freezes prep, matching, prompt, provider, accounting, persistence, cleanup, and events", async () => {
  const scenario = happyScenario();
  const { prepared, events } = await prepareAndRun(scenario);

  assert.equal(prepared.ok, true);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "done"]);
  assert.equal(events[0].text, `: ${" ".repeat(2048)}\n\n`);

  assert.deepEqual(scenario.calls.sequence, [
    "rate-limit", "plan", "usage", "abbreviations", "skeleton",
    "style-profile", "similar-reports", "reserve", "prompt",
    "provider", "usage-log", "quality-check", "review-log",
  ]);

  assert.deepEqual(scenario.calls.reserve, [{ userId: USER.id, mode: "fast" }]);
  assert.deepEqual(scenario.calls.refund, []);
});

// ── 2. Exact user_template_text/title/conclusion handling ───────────────

test("exact user template text/title/conclusion feed the synthetic match and prompt", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  const { templates, promptInput } = scenario.calls.buildPromptCalls[0];

  assert.deepEqual(templates, [{
    id: "user-template",
    file_name: "My Knee Template",
    body_region: "MSK",
    modality: "MRI",
    pathology_category: "User Template",
    pathology_name: "My Knee Template",
    findings_text: "Baseline findings text.",
    opinion_text: "OPINION:\n- Normal study.",
    full_text: "Baseline findings text.\n\nOPINION:\nOPINION:\n- Normal study.",
    keywords: [],
    relevance_score: 999,
  }]);
  assert.equal(promptInput.my_template_mode, true);
  assert.equal(promptInput.template_guided, true);
});

test("missing user_template_title falls back to 'My Template'; missing conclusion omits the OPINION join", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, user_template_title: undefined, user_template_conclusion: undefined });
  const { templates } = scenario.calls.buildPromptCalls[0];
  assert.equal(templates[0].file_name, "My Template");
  assert.equal(templates[0].pathology_name, "My Template");
  assert.equal(templates[0].opinion_text, "");
  assert.equal(templates[0].full_text, "Baseline findings text.");
});

// ── 3/4. Style profile present/missing ───────────────────────────────────

test("style profile found is passed through to the prompt input", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.styleProfileFetch, 1);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.style_profile, {
    summary: "Formal, bulleted style.", conclusion_header: "OPINION:",
  });
});

test("style profile missing (null) degrades to no profile, generation still succeeds", async () => {
  const scenario = happyScenario({ fetchStyleProfile: async () => null });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.style_profile, null);
  assert.equal(eventTypes(events).at(-1), "done");
});

test("use_reporting_style_profile: false skips both style profile and similar-report retrieval", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, use_reporting_style_profile: false });
  assert.equal(scenario.calls.styleProfileFetch, 0);
  assert.equal(scenario.calls.similarTemplates.length, 0);
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.style_profile, null);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.style_examples, []);
});

// ── 5/6. Voyage retrieval success/failure ────────────────────────────────

test("similar-report retrieval success populates style_examples (minus self-exclusion)", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.style_examples, [
    { user_template_id: "t1", title: "Other template", findings_text: "Different findings text.", conclusion_text: "Conclusion.", similarity: 0.9 },
  ]);
});

test("Voyage/embedding failure inside retrieveSimilarUserTemplates degrades to no examples, non-fatal", async () => {
  // Matches retrieveSimilarUserTemplates's own real contract: it never
  // throws, it resolves to [] on any internal failure.
  const scenario = happyScenario({ retrieveSimilarUserTemplates: async () => [] });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.style_examples, []);
  assert.equal(eventTypes(events).at(-1), "done");
});

// ── 7/8. Similar reports present/absent ─────────────────────────────────

test("no similar reports found (empty array) still succeeds with empty style_examples", async () => {
  const scenario = happyScenario({ retrieveSimilarUserTemplates: async () => [] });
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.style_examples, []);
});

// ── 9. Content-based self-exclusion ──────────────────────────────────────

test("self-exclusion drops any retrieved row whose findings_text matches the current template verbatim", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  const examples = scenario.calls.buildPromptCalls[0].promptInput.style_examples;
  assert.ok(!examples.some((e) => e.findings_text.trim() === "Baseline findings text."));
});

// ── 10. Authenticated user scoping / client boundary ─────────────────────

test("retrieveSimilarUserTemplates is called with the AUTHENTICATED client, not the service client", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.similarTemplates[0].supabase, scenario.deps.supabaseAuth);
  assert.notEqual(scenario.calls.similarTemplates[0].supabase, scenario.deps.supabase);
});

test("style profile fetch, usage persistence, and review insert all use the SERVICE client", async () => {
  const scenario = happyScenario({
    fetchStyleProfile: async (supabase) => {
      assert.equal(supabase, scenario.deps.supabase);
      return null;
    },
    logReportUsage: async (supabase, row) => {
      assert.equal(supabase, scenario.deps.supabase);
      scenario.calls.usageRows.push(row);
    },
    insertReportReview: async (supabase, row) => {
      assert.equal(supabase, scenario.deps.supabase);
      scenario.calls.reviewRows.push(row);
      return "id";
    },
  });
  const { prepared } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
});

// ── 11. Exact buildPrompt inputs ─────────────────────────────────────────

test("buildPrompt receives raw findings (parseToPrompt bypassed), overriding the resolvePartialNormals'd value", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, findings: "raw ACL finding" });
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.findings, "raw ACL finding");
});

test("template_edits is passed through raw (trimmed), never parsed via parseToPrompt", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, template_edits: "  Free-text edits.  " });
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.template_edits, "Free-text edits.");
});

// ── 12/13. Exact model/settings, exactly one Anthropic call ─────────────

test("exactly one Anthropic call with model/temperature/max_tokens/cache headers preserved", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.provider.length, 1);
  assert.deepEqual(scenario.calls.provider[0], {
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

test("an unsupported model falls back to claude-sonnet-4-6", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, model: "not-a-real-model" });
  assert.equal(scenario.calls.provider[0].params.model, "claude-sonnet-4-6");
});

// ── 14/15. SSE prelude/delta/done; error without done ────────────────────

test("SSE sequence is prelude, delta*, done on success", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "delta", "done"]);
});

test("a stream pump error emits error and never emits done", async () => {
  const scenario = happyScenario({
    anthropic: { messages: { stream: () => { throw new Error("Anthropic unavailable"); } } },
  });
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "error"]);
  assert.equal(events[1].data.error, "Anthropic unavailable");
});

// ── 16/17/18. Insufficient credits / reservation miss / reservation failure ──

test("early insufficient credits returns credits-exhausted without reserving or calling the provider", async () => {
  const scenario = happyScenario({
    getOrCreateUsage: async () => ({ credits_used: 300, credits_limit: 300, credits_remaining: 0, plan: "free", period_end: "2026-09-01T00:00:00.000Z" }),
    getUserPlan: async () => ({ plan: "free", current_period_end: null }),
  });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, {
    ok: false, category: "credits-exhausted",
    credits_remaining: 0, credits_limit: 300, plan: "free", upgrade_required: true,
  });
  assert.deepEqual(scenario.calls.reserve, []);
  assert.equal(scenario.calls.provider.length, 0);
});

test("reservation returns false (race lost) returns credits-exhausted, no provider call", async () => {
  const scenario = happyScenario({ reserveCredits: async () => false });
  const { prepared } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.category, "credits-exhausted");
  assert.equal(scenario.calls.provider.length, 0);
});

test("reservation throws returns credit-reservation-failed, no provider call, no refund attempt", async () => {
  const scenario = happyScenario({ reserveCredits: async () => { throw new Error("db down"); } });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "credit-reservation-failed" });
  assert.equal(scenario.calls.provider.length, 0);
  assert.deepEqual(scenario.calls.refund, []);
});

// ── 19. Setup failure after reservation ──────────────────────────────────

test("a setup failure after reservation (buildPrompt throws) refunds and returns setup-error, no report", async () => {
  const scenario = happyScenario({ buildPrompt: () => { throw new Error("prompt builder exploded"); } });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "setup-error", message: "prompt builder exploded" });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
  assert.equal(scenario.calls.provider.length, 0);
});

// ── 20. Provider failure (mid-stream) ────────────────────────────────────

test("provider failure mid-stream refunds exactly once and emits error, not done", async () => {
  const scenario = happyScenario({
    anthropic: {
      messages: {
        stream() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
              throw new Error("stream dropped");
            },
          };
        },
      },
    },
  });
  const { events } = await prepareAndRun(scenario);
  assert.deepEqual(eventTypes(events), ["prelude", "delta", "error"]);
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

// ── 21. Event-sink failure ────────────────────────────────────────────────

test("an emit() failure on the done event is caught, refunds exactly once, and never throws into the caller", async () => {
  // Matches the exact pre-extraction behavior (identical in Checklist/
  // Comparison/Quick Report): streamSucceeded is only set true AFTER the
  // done emit resolves, so a broken final write is indistinguishable from a
  // generation failure to the refund guard — it refunds once, not zero and
  // not twice, and the failed error-emit retry is itself swallowed.
  const scenario = happyScenario();
  const prepared = await prepareMyTemplateReport(USER, BASE_INPUT, scenario.deps);
  assert.equal(prepared.ok, true);
  await assert.doesNotReject(async () => {
    await prepared.run(async (event) => {
      if (event.type === "done") throw new Error("client disconnected");
    });
  });
  assert.deepEqual(scenario.calls.refund, [{ userId: USER.id, mode: "fast" }]);
});

// ── 22. Exactly-once refund (already covered per-branch above; consolidated) ─

test("refund never fires more than once across the setup-error path", async () => {
  const scenario = happyScenario({ buildPrompt: () => { throw new Error("boom"); } });
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.refund.length, 1);
});

// ── 23. Usage persistence failure remains non-fatal ──────────────────────

test("usage persistence failure (resolved, not thrown) does not change the response", async () => {
  const scenario = happyScenario({
    logReportUsage: async () => { /* simulates persistReportUsageWithRetry's real contract: silent, non-throwing failure */ },
  });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  assert.equal(eventTypes(events).at(-1), "done");
  assert.deepEqual(scenario.calls.refund, []);
});

test("a thrown usage-log error is caught locally and does not fail generation or trigger a refund", async () => {
  const scenario = happyScenario({
    logReportUsage: async () => { throw new Error("insert exploded"); },
  });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  assert.equal(eventTypes(events).at(-1), "done");
  assert.deepEqual(scenario.calls.refund, []);
});

// ── 24. Exact four-category cost accounting / mode = my_template ─────────

test("four-category cost accounting and mode=my_template are recorded exactly", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.usageRows, [{
    user_id: USER.id,
    model: "claude-sonnet-4-6",
    mode: "my_template",
    modality: "MRI",
    body_region: "MSK",
    study_type: "Knee",
    input_tokens: 100,
    output_tokens: 400,
    cached_tokens: 300,
    estimated_cost_usd: EXPECTED_COST,
    templates_used: 0,
    report_chars: 0,
  }]);
});

// ── 25. report_chars current behavior (always 0 for the usage row) ───────

test("report_chars in the usage-log row is 0 regardless of final report length (current behavior)", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.equal(scenario.calls.usageRows[0].report_chars, 0);
});

// ── 26. Exact report_reviews payload ─────────────────────────────────────

test("report_reviews row matches current shape exactly, including the quality-checked final text", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.deepEqual(scenario.calls.reviewRows, [{
    user_id: USER.id,
    user_email: USER.email,
    modality: "MRI",
    body_region: "MSK",
    study_type: "Knee",
    report_mode: "my_template",
    model: "claude-sonnet-4-6",
    category: "User Template",
    template_names: ["My Knee Template"],
    original_report: done.final_report,
    input_tokens: 100,
    output_tokens: 400,
    estimated_cost_usd: EXPECTED_COST,
  }]);
});

test("a report_reviews insert error is non-fatal — done still fires with review_id null", async () => {
  const scenario = happyScenario({ insertReportReview: async () => null });
  const { prepared, events } = await prepareAndRun(scenario);
  assert.equal(prepared.ok, true);
  const done = events.at(-1).data;
  assert.equal(done.review_id, null);
});

// ── 27/28. Quality check behavior / quality_warnings in done ─────────────

test("runMyTemplateQualityCheck receives the exact {reportText, hadOpinionInOriginal, templateEdits} triple", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  const qc = scenario.calls.qualityCheck[0];
  assert.equal(qc.hadOpinionInOriginal, true); // user_template_conclusion contains "OPINION:"
  assert.equal(qc.templateEdits, "ACL sprain noted.");
  assert.match(qc.reportText, /ACL sprain/);
});

test("hadOpinionInOriginal is false when the user's saved template had no opinion section", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, user_template_conclusion: "Just plain text, no heading." });
  assert.equal(scenario.calls.qualityCheck[0].hadOpinionInOriginal, false);
});

test("quality_warnings in the done payload matches the quality check's returned warnings exactly", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.deepEqual(done.quality_warnings, ["Detected a possible leftover normal phrase."]);
});

test("the quality check's cleanedText becomes the final_report and the stored original_report", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.match(done.final_report, /^CLEANED\(/);
  assert.equal(scenario.calls.reviewRows[0].original_report, done.final_report);
});

// ── 29. Exact final-report cleanup parity (PARTIAL NORMAL strip + dedup) ──

test("PARTIAL NORMAL lines are stripped and duplicate opinion bullets are deduplicated before the quality check runs", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  const reportTextIntoQualityCheck = scenario.calls.qualityCheck[0].reportText;
  assert.doesNotMatch(reportTextIntoQualityCheck, /PARTIAL NORMAL/);
  const opinionBulletCount = (reportTextIntoQualityCheck.match(/- ACL sprain\./g) ?? []).length;
  assert.equal(opinionBulletCount, 1, "duplicate '- ACL sprain.' opinion bullets must be deduplicated");
});

// ── 30. No personal-template DB re-fetch ─────────────────────────────────

test("no personal-template DB re-fetch: the module never queries the user_report_templates table", async () => {
  const source = await readFile(
    new URL("../src/lib/reporting/my-template-generation.ts", import.meta.url), "utf8"
  );
  // Documenting the absence of a re-fetch (in a comment) is fine and expected;
  // what must never appear is an actual query against the table.
  assert.doesNotMatch(source, /\.from\(\s*["']user_report_templates["']\s*\)/);
});

// ── 31. No new ownership/provenance validation ───────────────────────────

test("no ownership/provenance change: user_template_text is trusted as-supplied, no ID requirement added", async () => {
  const scenario = happyScenario();
  const { prepared } = await prepareAndRun(scenario, { ...BASE_INPUT, user_template_text: "Anything the client sends." });
  assert.equal(prepared.ok, true, "the module must not reject template text for lack of an ownership check");
});

// ── loadDatabaseAbbreviations preserved (called, result unused) ──────────

test("loadDatabaseAbbreviations is still called unconditionally, matching pre-extraction behavior (result unused)", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.abbreviations, [{ modality: "MRI", bodyRegion: "MSK", studyType: "Knee" }]);
});

// ── mri_technique / skeleton behavior ─────────────────────────────────────

test("MRI technique lines are pulled from the skeleton and passed into the prompt input", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario);
  assert.deepEqual(scenario.calls.buildPromptCalls[0].promptInput.mri_technique, ["Sagittal T1"]);
});

test("non-MRI modality never calls getSkeleton and mri_technique is undefined", async () => {
  const scenario = happyScenario();
  await prepareAndRun(scenario, { ...BASE_INPUT, modality: "CT" });
  assert.equal(scenario.calls.skeleton.length, 0);
  assert.equal(scenario.calls.buildPromptCalls[0].promptInput.mri_technique, undefined);
});

// ── Rate limit ─────────────────────────────────────────────────────────

test("rate limiting happens first, before plan/usage/reservation/provider", async () => {
  const scenario = happyScenario({
    checkReportRateLimit: async () => ({ limited: true, retryAfterSeconds: 42 }),
    getUserPlan: async () => { throw new Error("must not run"); },
  });
  const { prepared } = await prepareAndRun(scenario);
  assert.deepEqual(prepared, { ok: false, category: "rate-limited", retry_after_seconds: 42 });
  assert.deepEqual(scenario.calls.reserve, []);
});

// ── credits_remaining math in done payload ────────────────────────────────

test("credits_remaining in done is the pre-generation balance minus the 1.0 credit cost", async () => {
  const scenario = happyScenario();
  const { events } = await prepareAndRun(scenario);
  const done = events.at(-1).data;
  assert.equal(done.credits_remaining, 298); // 299 - 1.0
  assert.equal(done.credits_limit, 300);
});
