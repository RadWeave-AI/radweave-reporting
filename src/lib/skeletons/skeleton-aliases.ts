/**
 * Case-insensitivity, wording normalization, and clinical abbreviation
 * aliases for skeleton matching (skeleton-list.ts's findSkeleton/listSkeletons).
 *
 * Confirmed against a real audit of SKELETONS' actual keys (not assumed) —
 * every alias target below is a real, existing key. Where no equivalent
 * entry exists (CTA/MRA/MRV with no vascular territory named, US KUB), no
 * alias was added; that input simply falls through to no-match, exactly the
 * same fail-closed behavior an unrecognised study type already has.
 *
 * ADD MORE ALIASES HERE. Each entry maps a normalized (lowercase, trimmed,
 * modality-token- and positioning-word-stripped) input string to the REAL
 * study_type key it should resolve to for that modality. Scoped per
 * modality because the same abbreviation can mean a different thing, or the
 * same anatomy can be spelled differently, in different modalities (e.g.
 * CT's "Lumbosacral" vs MRI's "Lumbar Spine" vs X-ray's "Lumbar spine" are
 * three separate real keys, not a merge target).
 */

/**
 * Whole-word modality tokens stripped from ANYWHERE in the input, not just
 * a leading position — Desktop's own stripping only anchors to the start
 * (report.py's _generation_body_region), so reversed phrasing like
 * "Abdomen US" (modality token trailing) reaches here unstripped otherwise.
 */
const MODALITY_TOKEN_RE = /\b(?:CT|MRI|MR|US|XR|CR|DX|X-RAY|X RAY)\b/gi;

/**
 * Positioning/view words carry no anatomy information and were never part
 * of any skeleton key — stripped entirely, never aliased to anything.
 */
const POSITIONING_WORD_RE = /\b(?:AP|PA|LAT|LATERAL|OBLIQUE|FRONTAL)\b/gi;

/**
 * Normalizes a caller-supplied modality or study_type string for matching:
 * lowercase, hyphens/underscores folded to spaces, modality tokens and
 * positioning words stripped as whole words, whitespace collapsed and
 * trimmed. Applied identically to caller input AND to real SKELETONS key
 * text during the case-insensitive fallback scan, so both sides compare on
 * the same footing.
 */
export function normalizeMatchKey(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(MODALITY_TOKEN_RE, " ")
    .replace(POSITIONING_WORD_RE, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * modality -> normalized study_type input -> the REAL study_type key.
 *
 * IMPORTANT when adding a new line: write the alias KEY in its already-
 * normalized form — lowercase, and with any modality token (ct/mr/mri/us/
 * xr/cr/dx) and positioning word (ap/pa/lat/oblique/frontal) removed,
 * because normalizeMatchKey() strips those BEFORE this table is consulted.
 * A key like "ct urogram" will never match anything: the input "CT Urogram"
 * is stripped to "urogram" first. Write "urogram", not "ct urogram".
 */
export const STUDY_TYPE_ALIASES: Record<string, Record<string, string>> = {
  CT: {
    "pns": "Paranasal",
    "paranasal sinuses": "Paranasal",
    "kub": "Urinary tract",
    "ut": "Urinary tract",
    "ctu": "Urography",
    "urogram": "Urography",
    "lumbar spine": "Lumbosacral",
    "lumbosacral spine": "Lumbosacral",
    "lss": "Lumbosacral",
    "ncct": "Brain",
    "brain plain": "Brain",
    "c spine": "Cervical",
    "cspine": "Cervical",
    "t spine": "Dorsal",
    "tspine": "Dorsal",
    // No dedicated HRCT entry exists; a normal HRCT chest and a normal
    // routine CT chest are close enough to share as a labelled-suggestion
    // starting point (Eslam's call — see mission record, not a diagnosis-
    // grade equivalence claim).
    "hrct": "Chest",
    "hrct chest": "Chest",
  },
  MRI: {
    "lumbosacral": "Lumbar Spine",
    "lumbosacral spine": "Lumbar Spine",
    "lss": "Lumbar Spine",
    "cholangiopancreatography": "MRCP",
    "c spine": "Cervical Spine",
    "cspine": "Cervical Spine",
    "t spine": "Dorsal Spine",
    "tspine": "Dorsal Spine",
  },
  "X-ray": {
    "lumbosacral": "Lumbar spine",
    "lumbosacral spine": "Lumbar spine",
    "lss": "Lumbar spine",
    "cxr": "Chest",
    "c spine": "Cervical spine",
    "cspine": "Cervical spine",
    "t spine": "Dorsal spine",
    "tspine": "Dorsal spine",
  },
  Ultrasound: {
    // TVS (transvaginal) has no dedicated entry; Pelvis Female is the same
    // anatomy imaged with a different probe — close enough for a labelled
    // starting suggestion (Eslam's call). US KUB has no close equivalent
    // among Ultrasound's entries (none describe kidneys/bladder) and is
    // deliberately NOT aliased — falls through to the manual picker.
    "tvs": "Pelvis Female",
    "transvaginal": "Pelvis Female",
    "transvaginal ultrasound": "Pelvis Female",
  },
};

/** Real top-level SKELETONS modality keys, for case-insensitive lookup. */
export const KNOWN_MODALITIES = ["CT", "MRI", "PET CT", "X-ray", "Ultrasound"] as const;

/** Resolve a caller-supplied modality string to its real, canonical spelling
 * (case-insensitive), or null if it names no known modality. */
export function normalizeModality(modality: string): string | null {
  const target = modality.trim().toLowerCase();
  return KNOWN_MODALITIES.find((known) => known.toLowerCase() === target) ?? null;
}
