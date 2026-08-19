/**
 * skeleton-list.ts against the REAL SKELETONS object — no fixtures, no
 * mocking. These exist to catch drift between this projection and the data
 * getSkeleton actually reads, which a hand-maintained fixture could not.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { findSkeleton, listSkeletons } from "../src/lib/skeletons/skeleton-list.ts";
import { getSkeleton, SKELETONS } from "../src/lib/skeletons/skeletons.ts";

test("listSkeletons() with no filter returns every leaf entry in SKELETONS", () => {
  let expectedCount = 0;
  for (const bodyRegions of Object.values(SKELETONS)) {
    for (const studyTypes of Object.values(bodyRegions)) {
      expectedCount += Object.keys(studyTypes).length;
    }
  }

  const entries = listSkeletons();
  assert.equal(entries.length, expectedCount);
});

test("listSkeletons(modality) returns only that modality's entries", () => {
  const ctEntries = listSkeletons("CT");
  assert.ok(ctEntries.length > 0);
  for (const entry of ctEntries) {
    assert.equal(entry.modality, "CT");
  }

  const expectedCtCount = Object.values(SKELETONS.CT ?? {})
    .reduce((sum, studyTypes) => sum + Object.keys(studyTypes).length, 0);
  assert.equal(ctEntries.length, expectedCtCount);
});

test("all four Desktop-relevant modalities have at least one entry", () => {
  // Confirms the endpoint can genuinely cover CT, MRI, X-ray AND Ultrasound —
  // Desktop's PRE-EXISTING local-catalog auto-match could only ever cover
  // CT/MRI, which is exactly the gap this endpoint exists to close.
  for (const modality of ["CT", "MRI", "X-ray", "Ultrasound"]) {
    const entries = listSkeletons(modality);
    assert.ok(entries.length > 0, `expected at least one ${modality} entry`);
  }
});

test("an unknown modality returns an empty list, not an error", () => {
  assert.deepEqual(listSkeletons("Nuclear Medicine"), []);
});

test("every entry carries the full contract shape", () => {
  const entry = listSkeletons("CT")[0];
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["body_region", "findings", "modality", "opinion", "study_type", "technique", "title"],
  );
  assert.equal(typeof entry.findings, "string", "findings must be joined into one string");
  assert.ok(Array.isArray(entry.technique));
});

test("findSkeleton matches getSkeleton's own result exactly, for a known combo", () => {
  const modality = "CT";
  const [bodyRegion, studyTypes] = Object.entries(SKELETONS.CT)[0];
  const [studyType, skeleton] = Object.entries(studyTypes)[0];

  const found = findSkeleton(modality, studyType);
  assert.ok(found);
  assert.equal(found.body_region, bodyRegion);
  assert.equal(found.study_type, studyType);
  assert.equal(found.title, skeleton.title);
  assert.equal(found.opinion, skeleton.opinion);
  assert.equal(found.findings, skeleton.findings.join("\n"));

  // Cross-check against the real lookup function itself, not just the raw store.
  const viaGetSkeleton = getSkeleton(modality, bodyRegion, studyType);
  assert.equal(found.opinion, viaGetSkeleton?.opinion);
});

test("findSkeleton searches every body_region bucket, not just the first", () => {
  // Pick a study type that exists somewhere other than the first body_region
  // under its modality, to prove the search isn't accidentally scoped to one
  // bucket.
  let modality = "";
  let targetStudyType = "";
  outer: for (const [m, bodyRegions] of Object.entries(SKELETONS)) {
    const buckets = Object.entries(bodyRegions);
    if (buckets.length < 2) continue;
    for (const studyType of Object.keys(buckets[1][1])) {
      modality = m;
      targetStudyType = studyType;
      break outer;
    }
  }
  assert.ok(modality, "test setup: expected a modality with 2+ body_region buckets");

  const found = findSkeleton(modality, targetStudyType);
  assert.ok(found);
  assert.equal(found.study_type, targetStudyType);
});

test("findSkeleton returns null, cleanly, for a combo with no match", () => {
  assert.equal(findSkeleton("CT", "Definitely Not A Real Study Type"), null);
  assert.equal(findSkeleton("Nuclear Medicine", "Anything"), null);
});
