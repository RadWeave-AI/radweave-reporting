/**
 * Bullet-marker recognition in the post-generation cleanup layer.
 *
 * Background: the four standard modes were changed to ask the model for "• "
 * bullets, but the code that reads the model's output back still matched "- "
 * only. Nothing crashed and nothing was corrupted — `parseReport` simply failed
 * to find a bullet run and returned the report untouched — which is precisely
 * why it went unnoticed: bullet reordering and OPINION de-duplication silently
 * stopped happening.
 *
 * These tests exercise the REAL functions (no stubs) so a regression here is a
 * behavioural failure, not a mock drifting out of date.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { enforceOpinionOrder } from "../src/lib/reporting/opinion-order.ts";
import { reorderQuickReportBullets } from "../src/lib/templates/reorder.ts";

const TYPED_FINDINGS = ["ACL sprain", "Meniscus tear"];

/** OPINION deliberately in the opposite order to the typed findings. */
function report(marker: string): string {
  return [
    "MRI FINDINGS:",
    `${marker} The anterior cruciate ligament shows increased intrasubstance signal.`,
    `${marker} Horizontal cleavage tear at the posterior horn medial meniscus.`,
    "",
    "OPINION:",
    `${marker} **Meniscus tear.**`,
    `${marker} **ACL sprain.**`,
  ].join("\n");
}

// ── reorder: both markers must be recognised ─────────────────────────────────

test("• bullets are reordered to follow the typed finding order", () => {
  const result = reorderQuickReportBullets(report("•"), TYPED_FINDINGS, "MRI", "Knee");

  assert.equal(result.ambiguous, false, "a • report must parse, not bail as ambiguous");
  assert.equal(result.reordered, true);

  const opinion = result.text.split("OPINION:")[1];
  assert.ok(
    opinion.indexOf("ACL sprain") < opinion.indexOf("Meniscus tear"),
    "OPINION must follow the order the radiologist typed the findings",
  );
});

test("- bullets are still reordered exactly as before", () => {
  const result = reorderQuickReportBullets(report("-"), TYPED_FINDINGS, "MRI", "Knee");

  assert.equal(result.ambiguous, false);
  assert.equal(result.reordered, true);

  const opinion = result.text.split("OPINION:")[1];
  assert.ok(opinion.indexOf("ACL sprain") < opinion.indexOf("Meniscus tear"));
});

test("reordering a • report preserves every bullet and its marker", () => {
  // Reordering must move lines, never rewrite, drop, or re-mark them.
  const source = report("•");
  const result = reorderQuickReportBullets(source, TYPED_FINDINGS, "MRI", "Knee");

  const bulletsOf = (text: string) =>
    text.split("\n").filter((line) => line.trim().startsWith("•")).sort();
  assert.deepEqual(bulletsOf(result.text), bulletsOf(source));
  assert.doesNotMatch(result.text, /^- /m, "no bullet may be converted to a dash");
});

test("a report whose bullets use neither marker is left untouched", () => {
  // Fail closed: an unrecognised structure is passed through unchanged rather
  // than guessed at.
  const odd = "MRI FINDINGS:\n* One.\n* Two.\n\nOPINION:\n* Three.";
  const result = reorderQuickReportBullets(odd, TYPED_FINDINGS, "MRI", "Knee");

  assert.equal(result.text, odd);
  assert.equal(result.reordered, false);
});

// ── enforceOpinionOrder: marker is chosen by the caller ──────────────────────

test("enforceOpinionOrder defaults to - so existing workflows are unchanged", () => {
  // Checklist, Comparison, My Template and Template-guided all rely on this
  // default. Changing it would silently restyle four workflows at once.
  const out = enforceOpinionOrder(
    "OPINION:\n- **AI only.**",
    "- **Selected pathology.**",
  );

  assert.equal(out, "OPINION:\n\n- **Selected pathology.**\n- **AI only.**");
});

test("enforceOpinionOrder re-emits • when the caller asks for it", () => {
  const out = enforceOpinionOrder(
    "OPINION:\n• **AI only.**",
    "• **Selected pathology.**",
    "",
    "•",
  );

  assert.equal(out, "OPINION:\n\n• **Selected pathology.**\n• **AI only.**");
});

test("enforceOpinionOrder reads either marker regardless of which it writes", () => {
  // The reader already accepted both; this pins that it stays that way, so a
  // hint written with one marker still matches an opinion written with the
  // other instead of being duplicated.
  const out = enforceOpinionOrder(
    "OPINION:\n- **Selected pathology.**\n- **AI only.**",
    "• **Selected pathology.**",
    "",
    "•",
  );

  assert.equal(out, "OPINION:\n\n• **Selected pathology.**\n• **AI only.**");
  assert.equal(out.match(/Selected pathology/g)?.length, 1, "must not duplicate");
});

test("enforceOpinionOrder places residual normals last under either marker", () => {
  const out = enforceOpinionOrder(
    "OPINION:\n• **AI only.**",
    "• **Selected pathology.**",
    "• **Residual normal.**",
    "•",
  );

  assert.equal(
    out,
    "OPINION:\n\n• **Selected pathology.**\n• **AI only.**\n• **Residual normal.**",
  );
});
