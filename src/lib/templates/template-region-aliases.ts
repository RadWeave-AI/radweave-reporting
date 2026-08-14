/**
 * lib/templates/template-region-aliases.ts
 *
 * Step 22A found that the global `templates` table and the Template-guided
 * Report UI use inconsistent body_region values for the same anatomy
 * ("Head and Neck" vs "Head and neck" vs "CNS"), and matcher.ts's exact,
 * case-sensitive `.eq("body_region", ...)` made most of those rows
 * unreachable. This module is a conservative, read-only alias lookup —
 * it does not touch any database row.
 *
 * Only one alias group is defined: the one confirmed by the Step 22A audit.
 * Anything outside that group returns just the (trimmed) original value —
 * no guessing at other possible mismatches.
 */

// Canonical alias group, in a fixed order. Order matters: callers may use the
// first matching element as the "primary" display value.
const HEAD_NECK_CNS_GROUP = ["Head and Neck", "Head and neck", "CNS"];

const ALIAS_GROUPS: string[][] = [
  HEAD_NECK_CNS_GROUP,
];

/**
 * Returns the set of body_region values that should be searched together for
 * a given input value, with the original (trimmed) input always first.
 *
 * - Known group member (case-insensitive match) -> input first, then the rest
 *   of that group in canonical order.
 * - Anything else -> just the trimmed input, unchanged.
 */
export function getBodyRegionSearchAliases(input: string): string[] {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return [];

  const group = ALIAS_GROUPS.find((g) =>
    g.some((member) => member.toLowerCase() === trimmed.toLowerCase())
  );
  if (!group) return [trimmed];

  const rest = group.filter((member) => member !== trimmed);
  return [trimmed, ...rest];
}

/** Alias of getBodyRegionSearchAliases — same behavior, alternate name. */
export function normalizeBodyRegionForTemplateSearch(input: string): string[] {
  return getBodyRegionSearchAliases(input);
}

