/**
 * Read-only projection of the SKELETONS store for HTTP exposure.
 *
 * Backs `GET /v1/skeletons`. This module does not modify skeletons.ts, add a
 * second copy of its data, or reimplement any matching logic — it flattens
 * and searches the SAME `SKELETONS` object `getSkeleton` reads, so a client
 * calling this endpoint sees exactly what Quick Report's real normal
 * baseline actually is, not an approximation of it.
 *
 * Pure and side-effect free: no Supabase, no network, no async. Callers do
 * not need dependency injection to test this — it is deterministic given
 * its one static input.
 */

import { normalizeMatchKey, normalizeModality, STUDY_TYPE_ALIASES } from "./skeleton-aliases.ts";
import { SKELETONS, type Skeleton } from "./skeletons.ts";

export interface SkeletonEntry {
  modality: string;
  body_region: string;
  study_type: string;
  title: string;
  technique: string[];
  /** Joined with "\n", the same way prompt_builder.ts assembles the normal
   * baseline for the model — a client rendering this string sees the same
   * text Quick Report's system prompt actually receives. */
  findings: string;
  opinion: string;
}

function toEntry(modality: string, bodyRegion: string, studyType: string, skeleton: Skeleton): SkeletonEntry {
  return {
    modality,
    body_region: bodyRegion,
    study_type: studyType,
    title: skeleton.title,
    technique: skeleton.technique,
    findings: skeleton.findings.join("\n"),
    opinion: skeleton.opinion,
  };
}

/**
 * Every skeleton entry, optionally filtered to one modality.
 *
 * Order is stable (object key insertion order) but not otherwise
 * significant — callers needing a specific entry should filter or search,
 * not rely on position.
 */
export function listSkeletons(modality?: string): SkeletonEntry[] {
  const wantedModality = modality ? normalizeModality(modality) : undefined;
  if (modality && !wantedModality) return []; // an unknown modality name -> nothing, not an error
  const entries: SkeletonEntry[] = [];
  for (const [entryModality, bodyRegions] of Object.entries(SKELETONS)) {
    if (wantedModality && entryModality !== wantedModality) continue;
    for (const [bodyRegion, studyTypes] of Object.entries(bodyRegions)) {
      for (const [studyType, skeleton] of Object.entries(studyTypes)) {
        entries.push(toEntry(entryModality, bodyRegion, studyType, skeleton));
      }
    }
  }
  return entries;
}

/**
 * Find one entry by modality and study type, searching every body-region
 * bucket under that modality rather than requiring the caller to also name
 * one.
 *
 * Why: SKELETONS nests modality -> body_region -> study_type, but the only
 * anatomy string most callers can reliably derive from a DICOM exam
 * description sits at the study_type level (e.g. "Knee"), not the
 * intermediate body_region grouping (e.g. "MSK") — nothing upstream of this
 * endpoint reliably knows that grouping name. This mirrors the exact
 * `studyType || bodyRegion` collapse quick-report-generation.ts already does
 * server-side when a caller's body_region and study_type are the same
 * string, so a client's preview lookup and the real generation's skeleton
 * lookup stay consistent with each other.
 *
 * Returns null on no match — a missing skeleton is an expected, common
 * outcome (Quick Report itself falls back to general knowledge when this
 * happens), never an error.
 */
export function findSkeleton(modality: string, studyType: string): SkeletonEntry | null {
  const realModality = normalizeModality(modality);
  if (!realModality) return null;
  const bodyRegions = SKELETONS[realModality];
  if (!bodyRegions) return null;

  const normalizedInput = normalizeMatchKey(studyType);

  // 1. Alias table: an abbreviation/synonym mapped to a real key for this
  // modality (e.g. "PNS" -> CT's "Paranasal"; "Lumbosacral" -> MRI's
  // "Lumbar Spine"). Checked first so an alias always wins over a
  // coincidental partial match in the fallback scan below.
  const aliasTarget = STUDY_TYPE_ALIASES[realModality]?.[normalizedInput];
  if (aliasTarget) {
    for (const [bodyRegion, studyTypes] of Object.entries(bodyRegions)) {
      const skeleton = studyTypes[aliasTarget];
      if (skeleton) return toEntry(realModality, bodyRegion, aliasTarget, skeleton);
    }
  }

  // 2. Case-insensitive, wording-normalized direct match against every real
  // key for this modality — covers plain casing differences ("KNEE" ==
  // "Knee") and reversed/positioning-word noise without needing an alias
  // table entry for every trivial variant.
  for (const [bodyRegion, studyTypes] of Object.entries(bodyRegions)) {
    for (const [key, skeleton] of Object.entries(studyTypes)) {
      if (normalizeMatchKey(key) === normalizedInput) {
        return toEntry(realModality, bodyRegion, key, skeleton);
      }
    }
  }
  return null;
}
