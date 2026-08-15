import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { createApp } from "../src/app.ts";
import { formatReport, resolveStyle } from "../src/formatting/index.ts";

const STYLE_CASES = [
  { id: "tahoma-style", font: "Tahoma" },
  { id: "times-new-roman-style", font: "Times New Roman" },
] as const;

async function docxXml(buffer: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(path);
  assert.ok(file, `${path} must exist in the DOCX package`);
  return file.async("string");
}

function docxParagraphContaining(xml: string, text: string): string {
  const paragraph = (xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [])
    .find((candidate) => candidate.includes(text));
  assert.ok(paragraph, `DOCX paragraph containing "${text}" must exist`);
  return paragraph;
}

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
  for (const style of STYLE_CASES) {
    const result = await formatReport({
      report_text: CT_PROSE,
      report_mode: "quick",
      style_id: style.id,
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
    assert.match(result.html ?? "", new RegExp(`font-family:${style.font}`));
    assert.match(result.html ?? "", /text-align:justify/);
    assert.match(result.plain_text ?? "", /• The liver is normal in size\./);
    assert.equal(result.docx?.subarray(0, 2).toString(), "PK");
  }
});

test("F2 MRI: title alignment/case, left body, justified bullets, markdown bold", async () => {
  for (const style of STYLE_CASES) {
    const result = await formatReport({
      report_text: MRI_REPORT,
      report_mode: "checklist",
      style_id: style.id,
      outputs: ["html", "plain_text", "docx"],
    });
    const titles = result.outline.filter((block) => block.kind === "title");
    assert.deepEqual(titles.map((block) => block.alignment), ["center", "center", "left"]);
    assert.ok(titles.every((block) => block.text === block.text.toUpperCase()));
    const techniqueBody = result.outline.find((block) => block.text.startsWith("Multiplanar"));
    assert.equal(techniqueBody?.alignment, "left");
    assert.equal(techniqueBody?.bold, true);
    assert.equal(techniqueBody?.fontSizePt, 12);
    const bullets = result.outline.filter((block) => block.kind === "bullet");
    assert.ok(bullets.every((block) => block.alignment === "justify"));
    assert.match(result.html ?? "", /font-size:12pt[^\"]*font-weight:700[^>]*>Multiplanar/);
    assert.match(result.html ?? "", /<strong>Small knee joint effusion\.<\/strong>/);
    assert.doesNotMatch(result.plain_text ?? "", /\*\*/);
    assert.equal(result.docx?.subarray(0, 2).toString(), "PK");
  }
});

test("F3 Comparison: preserves explicit three-level hierarchy and markdown bold", async () => {
  for (const style of STYLE_CASES) {
    const result = await formatReport({
      report_text: COMPARISON_HIERARCHY,
      report_mode: "comparison",
      style_id: style.id,
      outputs: ["html", "plain_text", "docx"],
    });
    const bullets = result.outline.filter((block) => block.kind === "bullet");
    assert.deepEqual(bullets.map((block) => block.level), [0, 1, 2, 0, 1, 2]);
    assert.deepEqual(bullets.map((block) => block.marker), ["•", "-", "o", "•", "-", "o"]);
    assert.match(result.html ?? "", /data-level="2"/);
    assert.doesNotMatch(result.plain_text ?? "", /\*\*/);
    assert.equal(result.docx?.subarray(0, 2).toString(), "PK");
  }
});

test("F4 critical: identical markers are flat in standard and hierarchical only in Comparison", async () => {
  const report = `FINDINGS:
• Group-looking standard bullet.
- Stray dash bullet.
o Stray o bullet.`;
  for (const style of STYLE_CASES) {
    const standard = await formatReport({ report_text: report, report_mode: "my-template", style_id: style.id });
    const comparison = await formatReport({ report_text: report, report_mode: "comparison", style_id: style.id });
    const standardBullets = standard.outline.filter((block) => block.kind === "bullet");
    const comparisonBullets = comparison.outline.filter((block) => block.kind === "bullet");
    assert.deepEqual(standardBullets.map((block) => block.level), [0, 0, 0]);
    assert.deepEqual(standardBullets.map((block) => block.marker), ["•", "•", "•"]);
    assert.deepEqual(comparisonBullets.map((block) => block.level), [0, 1, 2]);
    assert.deepEqual(comparisonBullets.map((block) => block.marker), ["•", "-", "o"]);
    assert.equal(standard.style_path, "standard");
    assert.equal(comparison.style_path, "comparison");
  }
});

test("F5 Comparison: section prose splits while existing hierarchy bullets remain untouched", async () => {
  const report = `FINDINGS:
Pulmonary nodules are stable. No new nodule is seen.
• Stationary group:
- Existing nodule.
o Stable measurement.
OPINION:
The examination is stable. No progression is seen.`;
  for (const style of STYLE_CASES) {
    const result = await formatReport({ report_text: report, report_mode: "comparison", style_id: style.id });
    const bullets = result.outline.filter((block) => block.kind === "bullet");
    assert.deepEqual(bullets.map((block) => [block.sourceKind, block.level]), [
      ["paragraph", 0], ["paragraph", 0],
      ["bullet0", 0], ["bullet1", 1], ["bullet2", 2],
      ["paragraph", 0], ["paragraph", 0],
    ]);
  }
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
  for (const style of STYLE_CASES) {
    for (const report_mode of ["template-guided", "comparison"] as const) {
      const result = await formatReport({ report_text: report, report_mode, style_id: style.id });
      assert.equal(result.outline.some((block) => block.sourceKind === "blank" || block.sourceKind === "separator"), false);
      assert.doesNotMatch(result.html ?? "", /---|———|───/);
      assert.doesNotMatch(result.plain_text ?? "", /---|———|───/);
    }
  }
});

test("F7 MRI technique synonyms all apply bold 12pt content under both styles", async () => {
  for (const style of STYLE_CASES) {
    for (const heading of ["TECHNIQUE", "MR TECHNIQUE", "MRI TECHNIQUE"]) {
      const report = `HIGH FIELD (3.0 TESLA)\nMRI OF THE BRAIN\n${heading}:\nTechnique content for ${heading}.\n• Technique bullet for ${heading}.\nFINDINGS:\nNo focal lesion is seen.`;
      const result = await formatReport({
        report_text: report,
        report_mode: "quick",
        style_id: style.id,
        outputs: ["html", "docx"],
      });
      const technique = result.outline.find((block) => block.text === `Technique content for ${heading}.`);
      assert.equal(technique?.alignment, "left");
      assert.equal(technique?.bold, true);
      assert.equal(technique?.fontSizePt, 12);
      const techniqueBullet = result.outline.find((block) => block.text === `Technique bullet for ${heading}.`);
      assert.equal(techniqueBullet?.bold, true);
      assert.equal(techniqueBullet?.fontSizePt, 12);
      assert.match(result.html ?? "", new RegExp(`font-family:${style.font}[^\"]*font-size:12pt[^\"]*font-weight:700[^>]*>Technique content for ${heading}`));
      const xml = await docxXml(result.docx!, "word/document.xml");
      assert.match(xml, /w:sz w:val="24"/);
      assert.match(xml, new RegExp(`Technique content for ${heading}`));
    }

    const ctResult = await formatReport({
      report_text: "CT scan of chest revealed:\nTECHNIQUE:\nRoutine acquisition was performed.",
      report_mode: "quick",
      style_id: style.id,
    });
    const ctTechnique = ctResult.outline.find((block) => block.text === "Routine acquisition was performed.");
    assert.equal(ctTechnique?.bold, false);
    assert.equal(ctTechnique?.fontSizePt, undefined);
  }
});

test("F8 standard FINDINGS never bold while OPINION defaults bold; MRI content is justified", async () => {
  const report = `HIGH FIELD (3.0 TESLA)
MRI OF THE RIGHT KNEE
MRI RIGHT KNEE FOLLOW-UP
FINDINGS:
• Unmarked finding bullet.
• **Explicitly bold finding bullet.**
Finding prose sentence. Second finding prose sentence.
OPINION:
• Unmarked opinion bullet.
Opinion prose sentence. Second opinion prose sentence.`;

  for (const style of STYLE_CASES) {
    const result = await formatReport({
      report_text: report,
      report_mode: "quick",
      style_id: style.id,
      outputs: ["html", "plain_text", "docx"],
    });
    const titles = result.outline.filter((block) => block.kind === "title");
    assert.deepEqual(titles.map((block) => block.alignment), ["center", "center", "left"]);

    const unmarkedFinding = result.outline.find((block) => block.text === "Unmarked finding bullet.");
    const markedFinding = result.outline.find((block) => block.text === "**Explicitly bold finding bullet.**");
    const unmarkedOpinion = result.outline.find((block) => block.text === "Unmarked opinion bullet.");
    const findingProse = result.outline.find((block) => block.text === "Finding prose sentence.");
    const opinionProse = result.outline.find((block) => block.text === "Opinion prose sentence.");
    assert.deepEqual(
      [unmarkedFinding?.bold, markedFinding?.bold, findingProse?.bold, unmarkedOpinion?.bold, opinionProse?.bold],
      [false, false, false, true, true],
    );
    assert.equal(markedFinding?.allowInlineBold, false);
    assert.equal(unmarkedOpinion?.allowInlineBold, true);

    const findingsAndOpinion = result.outline.filter((block) =>
      block.kind === "bullet" && !block.text.includes("Explicitly bold"),
    );
    assert.ok(findingsAndOpinion.every((block) => block.alignment === "justify"));
    assert.match(result.html ?? "", /style="[^\"]*text-align:justify[^\"]*">• Unmarked finding bullet\.<\/div>/);
    assert.match(result.html ?? "", />• Explicitly bold finding bullet\.<\/div>/);
    assert.doesNotMatch(result.html ?? "", /<strong>Explicitly bold finding bullet\.<\/strong>/);
    assert.doesNotMatch(result.html ?? "", /\*\*/);
    assert.match(result.html ?? "", /style="[^\"]*text-align:justify[^\"]*font-weight:700[^\"]*">• Unmarked opinion bullet\.<\/div>/);
    assert.doesNotMatch(result.plain_text ?? "", /\*\*/);

    const documentXml = await docxXml(result.docx!, "word/document.xml");
    const findingsParagraph = docxParagraphContaining(documentXml, "Explicitly bold finding bullet.");
    const opinionParagraph = docxParagraphContaining(documentXml, "Unmarked opinion bullet.");
    assert.doesNotMatch(findingsParagraph, /<w:b\/>/);
    assert.doesNotMatch(findingsParagraph, /\*\*/);
    assert.match(opinionParagraph, /<w:b\/>/);
  }
});

test("F9 standard FINDINGS strips markdown bold while Comparison FINDINGS preserves it", async () => {
  const report = `FINDINGS:
• **Grouped finding heading.**
- **Nested finding.**
OPINION:
• Unmarked opinion.`;

  for (const style of STYLE_CASES) {
    const [standard, comparison] = await Promise.all([
      formatReport({
        report_text: report,
        report_mode: "quick",
        style_id: style.id,
        outputs: ["html", "plain_text", "docx"],
      }),
      formatReport({
        report_text: report,
        report_mode: "comparison",
        style_id: style.id,
        outputs: ["html", "plain_text", "docx"],
      }),
    ]);

    const standardFinding = standard.outline.find((block) => block.text === "**Grouped finding heading.**");
    const comparisonFinding = comparison.outline.find((block) => block.text === "**Grouped finding heading.**");
    const standardOpinion = standard.outline.find((block) => block.text === "Unmarked opinion.");
    const comparisonOpinion = comparison.outline.find((block) => block.text === "Unmarked opinion.");
    assert.equal(standardFinding?.allowInlineBold, false);
    assert.equal(comparisonFinding?.allowInlineBold, true);
    assert.equal(standardOpinion?.bold, true);
    assert.equal(comparisonOpinion?.bold, true);

    assert.doesNotMatch(standard.html!, /<strong>Grouped finding heading\.<\/strong>/);
    assert.match(comparison.html!, /<strong>Grouped finding heading\.<\/strong>/);
    assert.doesNotMatch(standard.html!, /\*\*/);
    assert.doesNotMatch(comparison.html!, /\*\*/);
    assert.doesNotMatch(standard.plain_text!, /\*\*/);
    assert.doesNotMatch(comparison.plain_text!, /\*\*/);

    const [standardXml, comparisonXml] = await Promise.all([
      docxXml(standard.docx!, "word/document.xml"),
      docxXml(comparison.docx!, "word/document.xml"),
    ]);
    const standardFindingParagraph = docxParagraphContaining(standardXml, "Grouped finding heading.");
    const comparisonFindingParagraph = docxParagraphContaining(comparisonXml, "Grouped finding heading.");
    assert.doesNotMatch(standardFindingParagraph, /<w:b\/>/);
    assert.match(comparisonFindingParagraph, /<w:b\/>/);
    assert.doesNotMatch(standardFindingParagraph, /\*\*/);
    assert.doesNotMatch(comparisonFindingParagraph, /\*\*/);
  }
});

test("F10 named styles are behavior-identical and differ only by ID/font family", async () => {
  const tahomaStyle = resolveStyle("tahoma-style");
  const timesStyle = resolveStyle("times-new-roman-style");
  assert.deepEqual(
    { ...tahomaStyle, id: "STYLE", fontFamily: "FONT" },
    { ...timesStyle, id: "STYLE", fontFamily: "FONT" },
  );

  const results = await Promise.all(STYLE_CASES.map((style) => formatReport({
    report_text: MRI_REPORT,
    report_mode: "checklist",
    style_id: style.id,
    outputs: ["html", "plain_text", "docx"],
  })));
  assert.deepEqual(results[0].outline, results[1].outline);
  assert.equal(results[0].plain_text, results[1].plain_text);

  const normalizeHtml = (html: string) => html
    .replaceAll("tahoma-style", "STYLE")
    .replaceAll("times-new-roman-style", "STYLE")
    .replaceAll("Tahoma", "FONT")
    .replaceAll("Times New Roman", "FONT");
  assert.equal(normalizeHtml(results[0].html!), normalizeHtml(results[1].html!));

  const [tahomaDocument, timesDocument, tahomaStyles, timesStyles] = await Promise.all([
    docxXml(results[0].docx!, "word/document.xml"),
    docxXml(results[1].docx!, "word/document.xml"),
    docxXml(results[0].docx!, "word/styles.xml"),
    docxXml(results[1].docx!, "word/styles.xml"),
  ]);
  assert.match(`${tahomaDocument}${tahomaStyles}`, /Tahoma/);
  assert.match(`${timesDocument}${timesStyles}`, /Times New Roman/);
  assert.equal(tahomaDocument.replaceAll("Tahoma", "FONT"), timesDocument.replaceAll("Times New Roman", "FONT"));
  assert.equal(tahomaStyles.replaceAll("Tahoma", "FONT"), timesStyles.replaceAll("Times New Roman", "FONT"));
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
      style_id: "tahoma-style",
      outputs: ["html", "plain_text", "docx"],
    }),
  };
  const response = await app.request("/v1/format", request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.style_id, "tahoma-style");
  assert.equal(body.style_path, "standard");
  assert.equal(typeof body.html, "string");
  assert.equal(typeof body.plain_text, "string");
  assert.equal(Buffer.from(body.docx_base64, "base64").subarray(0, 2).toString(), "PK");

  const timesResponse = await app.request("/v1/format", {
    ...request,
    body: JSON.stringify({
      report_text: CT_PROSE,
      report_mode: "quick",
      style_id: "times-new-roman-style",
      outputs: ["html"],
    }),
  });
  const timesBody = await timesResponse.json();
  assert.equal(timesResponse.status, 200);
  assert.equal(timesBody.style_id, "times-new-roman-style");
  assert.match(timesBody.html, /font-family:Times New Roman/);

  const legacyDefault = await app.request("/v1/format", {
    ...request,
    body: JSON.stringify({ report_text: CT_PROSE, report_mode: "quick", style_id: "default" }),
  });
  assert.equal(legacyDefault.status, 400);

  const unauthorized = await app.request("/v1/format", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ report_text: "FINDINGS:\nNormal.", report_mode: "quick", style_id: "tahoma-style" }),
  });
  assert.equal(unauthorized.status, 401);
});
