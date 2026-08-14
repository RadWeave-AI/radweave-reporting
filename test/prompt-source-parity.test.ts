import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSystemPrompt } from "../src/lib/ai/system_prompt.ts";
import {
  buildComparisonReportPrompt,
  buildPrompt,
  buildQuickReportPrompt,
} from "../src/lib/templates/prompt_builder.ts";

// SHA-256 of LF-normalized source copied from website commit e4c37cd.
// Whole-file hashes are intentionally stricter than prompt-only extraction:
// any future change to the prompt-bearing workflows must be explicit.
const SOURCE_HASHES = {
  "src/lib/ai/strict-style.ts": "cd923037c117036ca9a2094ab1ccf1cc13aec97d81dd1475c9d9da65bf7c3696",
  "src/lib/templates/my_template_quality_check.ts": "491c7be875b400ca64db81efbe6fd1627d449eaec25e89fc47150489e0c0c1bd",
  "src/lib/reporting/checklist-generation.ts": "78c87c2740d941d778839a06fe80a45a09b0ada4bc7dd303e32b55ffc72ab722",
  "src/lib/reporting/comparison-generation.ts": "16ab6446b234ea5e27ebe4cd205509b74b6c8376004e078dc9ea476862d6e35c",
  "src/lib/reporting/quick-report-generation.ts": "90c102eab10735b21e73a5bfe4752d17420992132d2a358774aef546bb7ff77f",
  "src/lib/reporting/my-template-generation.ts": "c83b03d175fb3cc8ba6ff92377d56cdef5b675ce0597ea2b129ca34d9ccb90eb",
  "src/lib/reporting/template-guided-generation.ts": "084659bf126c74d1c462bfc200c3acc99394d78b3d3d5c5a4931bbad72fffbcb",
} as const;

// These two files deliberately diverge from e4c37cd only for the service's
// standard-mode • marker customization. Keep both the website source pin and
// the approved service result pin visible; do not weaken this to a non-equality
// assertion. Comparison explicitly requests the legacy "-" marker and has a
// separate fully-assembled byte-parity test.
const DELIBERATE_DIVERGENCE_HASHES = {
  "src/lib/ai/system_prompt.ts": {
    website: "b3cc85cb4f8e29d260169c7bec7f47e5cb5e80f128bc192ff35397c7d9b5cd2c",
    service: "646f2acaae9861d112b076af406b46433368d973a754cfd3f32daa584cc8deb6",
  },
  "src/lib/templates/prompt_builder.ts": {
    website: "d9443b285f82549becc1ed900c4e97b922e39fa42865f306c00b9f45c938b7a6",
    service: "308d66c93579423eb5c063e56395320563b59051050803c71e351a86ab977c4e",
  },
} as const;

for (const [relativePath, expected] of Object.entries(SOURCE_HASHES)) {
  test(`${relativePath} remains byte-equivalent to e4c37cd after newline normalization`, async () => {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const normalized = source.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
    assert.equal(actual, expected);
  });
}

for (const [relativePath, hashes] of Object.entries(DELIBERATE_DIVERGENCE_HASHES)) {
  test(`${relativePath} remains pinned to its documented standard-bullet divergence`, async () => {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const normalized = source.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
    assert.notEqual(actual, hashes.website);
    assert.equal(actual, hashes.service);
  });
}

test("Comparison's fully assembled prompt remains byte-identical after bullet customization", () => {
  const prompt = buildComparisonReportPrompt({
    modality: "MRI",
    body_region: "Spine",
    study_type: "Lumbosacral Spine",
    indication: "Follow-up.",
    findings: "Baseline.",
    field_strength: "3T",
    report_header: "MRI LUMBOSACRAL SPINE",
    opinion_hints: "",
    prior_date: "03/08/2026",
    prior_opinion: "Prior disc protrusion.",
    comparison_blocks: [{
      type: "group",
      status: "stationary",
      header: "Rather stationary course regarding:",
      findings: [{ text: "Stable L4/5 protrusion" }],
    }],
  });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const combined = `${prompt.system}\n\0USER\0\n${prompt.user}\n\0STATIC\0\n${prompt.staticInstructions ?? ""}`;

  assert.equal(Buffer.byteLength(prompt.system), 12_295);
  assert.equal(Buffer.byteLength(prompt.user), 7_485);
  assert.equal(hash(prompt.system), "84f0a6a10b01c74cffc7a0c5c50ff927047ac020783fc4435b83388cb1f91d8a");
  assert.equal(hash(prompt.user), "bb88d125138111ac5b853455a8ef90e12333e019396461e9a687b429ee4c5a0f");
  assert.equal(hash(combined), "899a7907400276042a799cd47826a3ce09964da3d24348301f52b15fa3bf8627");
});

test("all four standard modes explicitly request • output bullets", () => {
  const base = {
    modality: "CT",
    body_region: "Abdomen and pelvis",
    indication: "Pain.",
    findings: "Focal liver lesion.",
  };
  const system = buildSystemPrompt(base.modality, base.body_region);
  assert.match(system, /• \*\*Finding one\.\*\*/);
  assert.match(system, /Always "• " prefix/);
  assert.doesNotMatch(system, /Always "- " prefix/);

  const quick = buildQuickReportPrompt(base);
  assert.match(quick.system, /• \*\*Finding one\.\*\*/);
  assert.match(
    `${quick.system}\n${quick.user}\n${quick.staticInstructions ?? ""}`,
    /• \*\*Liver cirrhosis with portal hypertension manifestations\.\*\*/,
  );

  const checklist = buildPrompt([], base);
  assert.match(checklist.system, /• \*\*Finding one\.\*\*/);

  const templateGuided = buildPrompt([], { ...base, template_guided: true });
  assert.match(templateGuided.system, /• \*\*Finding one\.\*\*/);

  const myTemplate = buildPrompt([], { ...base, template_guided: true, my_template_mode: true });
  assert.match(myTemplate.system, /Always bold bullet lines: • \*\*text\.\*\*/);
});
