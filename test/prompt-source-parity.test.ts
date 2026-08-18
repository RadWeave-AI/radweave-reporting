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

// SHA-256 of LF-normalized service source. These started as the website's
// e4c37cd bytes. Whole-file hashes are intentionally stricter than prompt-only
// extraction: any future change to the prompt-bearing workflows must be
// explicit.
//
// Re-pinned once, for the "@/*" path-alias removal. Vercel's Node runtime does
// not support tsconfig path mappings, so every "@/x" specifier was rewritten to
// a relative "./x.ts" one and production stopped crashing at import time. That
// rewrite touched ONLY module specifiers — verified by masking every specifier
// string in each file and confirming the masked content hashed identically
// before and after. Clinical and prompt logic is unchanged; only these pins
// moved.
//
// Re-pinned a second time, for quick-report-generation.ts ONLY, to complete the
// standard-mode • marker work already recorded in DELIBERATE_DIVERGENCE_HASHES
// below. That change made the four standard modes ASK for "•" bullets, but the
// code that reads the model's output back was left matching "- " only, so for
// Quick Report the OPINION de-duplication silently stopped firing and the
// re-emitted OPINION section was rewritten back to dashes. This re-pin covers
// two post-processing edits — cleanQuickReport now accepts either marker, and
// enforceOpinionOrder is asked to re-emit "•". No prompt text, no clinical
// rule, and no other workflow's behavior changed.
const SOURCE_HASHES = {
  "src/lib/ai/strict-style.ts": "cd923037c117036ca9a2094ab1ccf1cc13aec97d81dd1475c9d9da65bf7c3696",
  "src/lib/templates/my_template_quality_check.ts": "491c7be875b400ca64db81efbe6fd1627d449eaec25e89fc47150489e0c0c1bd",
  "src/lib/reporting/checklist-generation.ts": "4f3590f76ad1e8aca2636a7f9584507f41fab834ca237ffeff616f88b8630239",
  "src/lib/reporting/comparison-generation.ts": "cf64f0edf8d124d296e1252d65ee44557ce8e3ca941ed834cbaf407730aaebcb",
  "src/lib/reporting/quick-report-generation.ts": "282c0fe0e82ee709dfb640fda60e6873a442079435f428d576417f264427e5b3",
  "src/lib/reporting/my-template-generation.ts": "7ebdc6b1f3dad682102db9dd24b4ee581c41e741d6b8e5bcfb77045dc49f6e34",
  "src/lib/reporting/template-guided-generation.ts": "521ec0ee8cf3542170bfbafa1da4caf7dd0d40928b5d05f7dd859e1f47ad1583",
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
    service: "9d60c66e6fb4aef287065c9d73be2f4ec3d241d523e6446852f8aae5714d5398",
  },
} as const;

for (const [relativePath, expected] of Object.entries(SOURCE_HASHES)) {
  test(`${relativePath} remains byte-equivalent to its pinned service source`, async () => {
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
