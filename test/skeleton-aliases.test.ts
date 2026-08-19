/**
 * Case-insensitivity, positioning-word stripping, reversed word order, and
 * clinical abbreviation aliases for skeleton matching — against the REAL
 * findSkeleton()/SKELETONS, no fixtures. Confirms the fix for the
 * previously-measured 15/15 real-world-casing match failure, plus every
 * alias Eslam confirmed, plus that the deliberately-unresolved ones
 * (CTA/MRA/MRV with no territory, US KUB) correctly stay unmatched rather
 * than guessing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { findSkeleton, listSkeletons } from "../src/lib/skeletons/skeleton-list.ts";
import { normalizeMatchKey, normalizeModality } from "../src/lib/skeletons/skeleton-aliases.ts";

// ── The exact 15-case realistic-DICOM smoke matrix from the prior mission ───
// All 15 previously failed (case-sensitive exact match only). All must pass now.

const REALISTIC_SMOKE_MATRIX: Array<[string, string, string]> = [
  ["CT", "KNEE", "Knee"],
  ["CT", "FOOT", "Foot"],
  ["CT", "CHEST", "Chest"],
  ["CT", "PARANASAL SINUSES", "Paranasal"],
  ["CT", "BRAIN", "Brain"],
  ["MRI", "KNEE", "Knee"],
  ["MRI", "LUMBOSACRAL SPINE", "Lumbar Spine"],
  ["MRI", "LUMBAR SPINE", "Lumbar Spine"],
  ["MRI", "BRAIN", "Brain"],
  ["X-ray", "CHEST PA", "Chest"],
  ["X-ray", "CHEST", "Chest"],
  ["X-ray", "FOOT AP LAT", "Foot"],
  ["Ultrasound", "ABDOMEN", "Abdomen"],
  ["Ultrasound", "PELVIS FEMALE", "Pelvis Female"],
  ["Ultrasound", "THYROID", "Thyroid"],
];

for (const [modality, input, expectedKey] of REALISTIC_SMOKE_MATRIX) {
  test(`realistic ALL-CAPS DICOM input "${input}" (${modality}) now matches "${expectedKey}"`, () => {
    const result = findSkeleton(modality, input);
    assert.ok(result, `expected a match for ${modality} / ${input}`);
    assert.equal(result.study_type, expectedKey);
  });
}

// ── Case-insensitivity across all four Desktop-relevant modalities ──────────

test("modality itself is matched case-insensitively", () => {
  assert.ok(findSkeleton("ct", "Knee"));
  assert.ok(findSkeleton("Ct", "Knee"));
  assert.ok(findSkeleton("CT", "Knee"));
  assert.ok(findSkeleton("mri", "Knee"));
  assert.ok(findSkeleton("x-ray", "Chest"));
  assert.ok(findSkeleton("X-RAY", "Chest"));
  assert.ok(findSkeleton("ultrasound", "Thyroid"));
});

test("an unrecognised modality string matches nothing rather than guessing", () => {
  assert.equal(findSkeleton("Xray", "Chest"), null); // not the real spelling "X-ray"
  assert.equal(findSkeleton("Nuclear Medicine", "Anything"), null);
});

test("listSkeletons(modality) is also case-insensitive", () => {
  const lower = listSkeletons("ct");
  const canonical = listSkeletons("CT");
  assert.equal(lower.length, canonical.length);
  assert.ok(lower.length > 0);
});

test("listSkeletons with an unrecognised modality returns an empty list, not an error", () => {
  assert.deepEqual(listSkeletons("Xray"), []);
});

// ── Positioning-word stripping ────────────────────────────────────────────

test("positioning words are stripped entirely, never aliased to anything", () => {
  for (const input of ["KNEE AP", "KNEE PA", "KNEE LAT", "KNEE LATERAL", "KNEE OBLIQUE", "AP KNEE"]) {
    const result = findSkeleton("X-ray", input);
    assert.ok(result, `expected a match for X-ray / ${input}`);
    assert.equal(result.study_type, "Knee");
  }
});

// ── Reversed modality-word order ────────────────────────────────────────────

test("a trailing modality token matches the same as a leading one", () => {
  const leading = findSkeleton("Ultrasound", "US Abdomen");
  const trailing = findSkeleton("Ultrasound", "Abdomen US");
  assert.ok(leading);
  assert.ok(trailing);
  assert.equal(leading.study_type, trailing.study_type);
});

// ── Confirmed aliases, one test per mission item ────────────────────────────

test("PNS / CT PNS -> CT's Paranasal", () => {
  assert.equal(findSkeleton("CT", "PNS")?.study_type, "Paranasal");
  assert.equal(findSkeleton("CT", "CT PNS")?.study_type, "Paranasal");
});

test("KUB / CT UT / CT Urinary Tract -> CT's Urinary tract", () => {
  assert.equal(findSkeleton("CT", "KUB")?.study_type, "Urinary tract");
  assert.equal(findSkeleton("CT", "CT UT")?.study_type, "Urinary tract");
  assert.equal(findSkeleton("CT", "CT Urinary Tract")?.study_type, "Urinary tract");
});

test("CTU / CT Urogram -> CT's Urography", () => {
  assert.equal(findSkeleton("CT", "CTU")?.study_type, "Urography");
  assert.equal(findSkeleton("CT", "CT Urogram")?.study_type, "Urography");
});

test("Lumbar Spine / Lumbosacral / Lumbosacral Spine / LSS resolve per-modality, no content merged or dropped", () => {
  // CT and MRI have SEPARATE real keys ("Lumbosacral" vs "Lumbar Spine") in
  // separate namespaces -- confirms no cross-modality merge was needed or
  // performed; each modality's own existing entry is reached via its own
  // family of synonyms.
  for (const input of ["Lumbar Spine", "Lumbosacral Spine", "LSS"]) {
    assert.equal(findSkeleton("CT", input)?.study_type, "Lumbosacral", input);
  }
  for (const input of ["Lumbosacral", "Lumbosacral Spine", "LSS"]) {
    assert.equal(findSkeleton("MRI", input)?.study_type, "Lumbar Spine", input);
  }
  for (const input of ["Lumbosacral", "Lumbosacral Spine", "LSS"]) {
    assert.equal(findSkeleton("X-ray", input)?.study_type, "Lumbar spine", input);
  }
});

test("CT and MRI's lumbar-region entries keep their own distinct content", () => {
  const ct = findSkeleton("CT", "Lumbosacral");
  const mri = findSkeleton("MRI", "Lumbar Spine");
  assert.ok(ct && mri);
  assert.notEqual(ct.findings, mri.findings, "CT and MRI must not have been collapsed into shared text");
});

test("NCCT / CT Brain plain -> CT's Brain", () => {
  assert.equal(findSkeleton("CT", "NCCT")?.study_type, "Brain");
  assert.equal(findSkeleton("CT", "CT Brain plain")?.study_type, "Brain");
});

test("C-spine and T-spine resolve per-modality (Dorsal = this dataset's Thoracic)", () => {
  assert.equal(findSkeleton("CT", "C-spine")?.study_type, "Cervical");
  assert.equal(findSkeleton("CT", "T-spine")?.study_type, "Dorsal");
  assert.equal(findSkeleton("MRI", "C-spine")?.study_type, "Cervical Spine");
  assert.equal(findSkeleton("MRI", "T-spine")?.study_type, "Dorsal Spine");
  assert.equal(findSkeleton("X-ray", "C-spine")?.study_type, "Cervical spine");
  assert.equal(findSkeleton("X-ray", "T-spine")?.study_type, "Dorsal spine");
});

test("MRCP -> MRI's real MRCP key (the key IS the abbreviation)", () => {
  assert.equal(findSkeleton("MRI", "MRCP")?.study_type, "MRCP");
  assert.equal(findSkeleton("MRI", "MR Cholangiopancreatography")?.study_type, "MRCP");
});

test("CXR -> X-ray's Chest", () => {
  assert.equal(findSkeleton("X-ray", "CXR")?.study_type, "Chest");
});

test("HRCT / HRCT Chest -> CT's plain Chest (Eslam-confirmed starting-point suggestion)", () => {
  assert.equal(findSkeleton("CT", "HRCT")?.study_type, "Chest");
  assert.equal(findSkeleton("CT", "HRCT Chest")?.study_type, "Chest");
});

test("TVS -> Ultrasound's Pelvis Female (Eslam-confirmed starting-point suggestion)", () => {
  assert.equal(findSkeleton("Ultrasound", "TVS")?.study_type, "Pelvis Female");
  assert.equal(findSkeleton("Ultrasound", "Transvaginal")?.study_type, "Pelvis Female");
});

// ── Deliberately NOT aliased — must stay unmatched (fail-closed, not a guess) ──

test("CTA / MRA / MRV with no vascular territory stay unmatched", () => {
  assert.equal(findSkeleton("CT", "CTA"), null);
  assert.equal(findSkeleton("MRI", "MRA"), null);
  assert.equal(findSkeleton("MRI", "MRV"), null);
});

test("US KUB stays unmatched -- no renal/urinary ultrasound entry exists to alias to", () => {
  assert.equal(findSkeleton("Ultrasound", "US KUB"), null);
  assert.equal(findSkeleton("Ultrasound", "KUB"), null);
});

// ── The bug this mission's own alias table would have shipped with ─────────

test("an alias key must be written already-stripped of its modality token", () => {
  // Regression pin: "CT Urogram" -> normalizeMatchKey strips "CT" BEFORE the
  // alias table is consulted, leaving "urogram". A table keyed on the
  // pre-strip form ("ct urogram") would never match. This function-level
  // check is the actual mechanism; the findSkeleton test above is the
  // behavioural pin.
  assert.equal(normalizeMatchKey("CT Urogram"), "urogram");
  assert.equal(normalizeMatchKey("Abdomen US"), "abdomen");
  assert.equal(normalizeMatchKey("KNEE AP"), "knee");
});

test("normalizeModality resolves the five real modality spellings only", () => {
  assert.equal(normalizeModality("ct"), "CT");
  assert.equal(normalizeModality("PET CT"), "PET CT");
  assert.equal(normalizeModality("x-ray"), "X-ray");
  assert.equal(normalizeModality("Xray"), null);
});
