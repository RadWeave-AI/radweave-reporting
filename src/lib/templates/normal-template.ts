/**
 * Pure template classification helper.
 *
 * Deliberately dependency-free: no Supabase client, no next/headers, no
 * request context. It lived in lib/templates/access.ts, whose other exports
 * build a cookie-backed Supabase client and therefore can only run inside a
 * Next.js request — importing this predicate from there dragged next/headers
 * into the module graph of every reporting workflow that needed it.
 *
 * Keep it that way: anything added here must stay importable from a plain
 * Node process (the standalone RadWeave Reporting service), not just from a
 * Next.js server component or route handler.
 */

export function isNormalTemplateRow(row: {
  is_normal?: boolean | null;
  modality?: string | null;
  pathology_category?: string | null;
}) {
  return (
    row.is_normal === true ||
    row.modality?.toLowerCase().startsWith("normal") ||
    row.pathology_category?.toLowerCase() === "normal"
  );
}

