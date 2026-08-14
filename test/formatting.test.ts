import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { formatReport } from "../src/formatting/index.ts";

const CT_PROSE = `CT scan of abdomen and pelvis revealed:
FINDINGS:
The liver is normal in size. No focal lesion is seen.
OPINION:
No acute abdominopelvic abnormality.`;

const MRI_REPORT = `HIGH FIELD (3.0 TESLA)
MRI OF THE RIGHT KNEE
MRI RIGHT KNEE FOLLOW-UP
TECHNIQUE:
Multiplanar multisequential images were obtained.
FINDINGS:
Small joint effusion is seen. The cruciate ligaments are intact.
OPINION:
• **Small knee joint effusion.**`;

const COMPARISON_HIERARCHY = `CT scan of chest revealed:
FINDINGS:
• Rather stationary course regarding:
- Pulmonary nodule.
o No interval change in size.
OPINION:
• **Rather stationary course regarding:**
- **Pulmonary nodule.**
o **No interval change.**`;

test("F1 CT: original-case justified title/body and sentence bullets", async () => {
  const result = await formatReport({
    report_text: CT_PROSE,
    report_mode: "quick",
    style_id: "default",
    outputs: ["html", "plain_text", "docx"],
  });
  const title = result.outline[0];
  assert.equal(title.text, "CT scan of abdomen and pelvis revealed:");
  assert.equal(title.alignment, "justify");
  assert.equal(title.uppercase, false);
  const findingBullets = result.outline.filter((block) => block.sourceKind === "paragraph" && block.kind === "bullet");
  assert.deepEqual(findingBullets.map((block) => block.text), [
    "The liver is normal in size.",
    "No focal lesion is seen.",
    "No acute abdominopelvic abnormality.",
  ]);
  assert.match(result.html ?? "", /text-align:justify/);
  assert.match(result.plain_text ?? "", /• The liver is normal in size\./);
  assert.equal(result.docx?.subarray(0, 2).toString(), "PK");
});

test("F2 MRI: title alignment/case, left body, justified bullets, markdown bold", async () => {
  const result = await formatReport({
    report_text: MRI_REPORT,
    report_mode: "checklist",
    style_id: "default",
    outputs: ["html", "plain_text", "docx"],
  });
  const titles = result.outline.filter((block) => block.kind === "title");
  assert.deepEqual(titles.map((block) => block.alignment), ["center", "center", "left"]);
  assert.ok(titles.every((block) => block.text === block.text.toUpperCase()));
  const techniqueBody = result.outline.find((block) => block.text.startsWith("Multiplanar"));
  assert.equal(techniqueBody?.alignment, "left");
  const bullets = result.outline.filter((block) => block.kind === "bullet");
  assert.ok(bullets.every((block) => block.alignment === "justify"));
  assert.match(result.html ?? "", /<strong>Small knee joint effusion\.<\/strong>/);
  assert.doesNotMatch(result.plain_text ?? "", /\*\*/);
  assert.equal(result.docx?.subarray(0, 2).toString(), "PK");
});

test("F3 Comparison: preserves explicit three-level hierarchy and markdown bold", async () => {
  const result = await formatReport({
    report_text: COMPARISON_HIERARCHY,
    report_mode: "comparison",
    style_id: "default",
    outputs: ["html", "plain_text", "docx"],
  });
  const bullets = result.outline.filter((block) => block.kind === "bullet");
  assert.deepEqual(bullets.map((block) => block.level), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(bullets.map((block) => block.marker), ["•", "-", "o", "•", "-", "o"]);
  assert.match(result.html ?? "", /data-level="2"/);
  assert.doesNotMatch(result.plain_text ?? "", /\*\*/);
  assert.equal(result.docx?.subarray(0, 2).toString(), "PK");
});

test("F4 critical: identical markers are flat in standard and hierarchical only in Comparison", async () => {
  const report = `FINDINGS:
• Group-looking standard bullet.
- Stray dash bullet.
o Stray o bullet.`;
  const standard = await formatReport({ report_text: report, report_mode: "my-template", style_id: "default" });
  const comparison = await formatReport({ report_text: report, report_mode: "comparison", style_id: "default" });
  const standardBullets = standard.outline.filter((block) => block.kind === "bullet");
  const comparisonBullets = comparison.outline.filter((block) => block.kind === "bullet");
  assert.deepEqual(standardBullets.map((block) => block.level), [0, 0, 0]);
  assert.deepEqual(standardBullets.map((block) => block.marker), ["•", "•", "•"]);
  assert.deepEqual(comparisonBullets.map((block) => block.level), [0, 1, 2]);
  assert.deepEqual(comparisonBullets.map((block) => block.marker), ["•", "-", "o"]);
  assert.equal(standard.style_path, "standard");
  assert.equal(comparison.style_path, "comparison");
});

test("F5 Comparison: section prose splits while existing hierarchy bullets remain untouched", async () => {
  const report = `FINDINGS:
Pulmonary nodules are stable. No new nodule is seen.
• Stationary group:
- Existing nodule.
o Stable measurement.
OPINION:
The examination is stable. No progression is seen.`;
  const result = await formatReport({ report_text: report, report_mode: "comparison", style_id: "default" });
  const bullets = result.outline.filter((block) => block.kind === "bullet");
  assert.deepEqual(bullets.map((block) => [block.sourceKind, block.level]), [
    ["paragraph", 0], ["paragraph", 0],
    ["bullet0", 0], ["bullet1", 1], ["bullet2", 2],
    ["paragraph", 0], ["paragraph", 0],
  ]);
});

test("F6 blanks and all separator variants are suppressed in both style paths", async () => {
  const report = `FINDINGS:

---
First sentence.
———
Second sentence.
───
OPINION:
Final sentence.`;
  for (const report_mode of ["template-guided", "comparison"] as const) {
    const result = await formatReport({ report_text: report, report_mode, style_id: "default" });
    assert.equal(result.outline.some((block) => block.sourceKind === "blank" || block.sourceKind === "separator"), false);
    assert.doesNotMatch(result.html ?? "", /---|———|───/);
    assert.doesNotMatch(result.plain_text ?? "", /---|———|───/);
  }
});

test("POST /v1/format is authenticated and returns requested outputs", async () => {
  const app = createApp({
    verifyToken: async (token) => token === "format-token" ? { id: "formatter-user", email: null } : null,
    resolvePlan: async () => "pro",
  });
  const request = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer format-token" },
    body: JSON.stringify({
      report_text: CT_PROSE,
      report_mode: "quick",
      style_id: "default",
      outputs: ["html", "plain_text", "docx"],
    }),
  };
  const response = await app.request("/v1/format", request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.style_path, "standard");
  assert.equal(typeof body.html, "string");
  assert.equal(typeof body.plain_text, "string");
  assert.equal(Buffer.from(body.docx_base64, "base64").subarray(0, 2).toString(), "PK");

  const unauthorized = await app.request("/v1/format", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ report_text: "FINDINGS:\nNormal.", report_mode: "quick", style_id: "default" }),
  });
  assert.equal(unauthorized.status, 401);
});
