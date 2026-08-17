/**
 * Account-scoped template catalogue listing.
 *
 * This is the read path behind `GET /v1/templates`. It exists because RadWeave
 * Desktop's template rail is otherwise a frozen local snapshot whose entries
 * have no database identity — and a template with no real id cannot be named
 * as `selected_template_id` in a generation request. Returning the real ids
 * alongside the text is what makes explicit template selection possible at
 * all.
 *
 * It deliberately reuses the query shapes this service ALREADY uses rather
 * than inventing a third one:
 *   - shared catalogue -> the `templates` filters from lib/templates/matcher.ts
 *     (is_hidden = false, deleted_at is null, source null/curated) with the
 *     same `pathology_reports` plan gate the browser picker applies.
 *   - the account's own -> `user_report_templates` scoped to the caller.
 * A second, subtly different copy of these filters is exactly the drift that
 * caused the original reporting bug.
 *
 * SECURITY — READ BEFORE EDITING
 * ------------------------------
 * The two sources have deliberately DIFFERENT clients, because they have
 * different ownership semantics:
 *
 *   `templates`             global, admin-curated, no user_id column. Nothing
 *                           to scope by owner; the only gate is entitlement.
 *                           Service-role is correct here.
 *
 *   `user_report_templates` one account's private data. Read through an
 *                           RLS-scoped client built from the CALLER'S OWN
 *                           verified JWT, so the database resolves auth.uid()
 *                           itself — AND filtered by an explicit
 *                           .eq("user_id", …). Either boundary alone would be
 *                           sufficient; both are present so that a leak
 *                           requires two independent failures rather than one
 *                           deleted line.
 *
 * Identity comes ONLY from the verified principal. No user id is ever read
 * from the request body or query string.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { canUseFeature } from "../features/access.ts";
import { getUserPlan } from "../stripe/get-user-plan.ts";
import { isNormalTemplateRow } from "./normal-template.ts";

/**
 * Where a template came from, as Desktop's rail groups them.
 *
 * There is no "hospital" category. No hospital/institution template concept
 * exists anywhere in the backend; do not invent one here.
 *
 * NOTE for callers: ids are only unique WITHIN a category, and the two
 * categories live in different tables. `selected_template_id` on the
 * template-guided workflow resolves against `templates` only — a "user" id is
 * not resolvable there. Clients must not treat the two as interchangeable.
 */
export type TemplateCategory = "radweave" | "user";

export interface CatalogTemplate {
  /** Real database id, within the category's table. */
  id: string;
  category: TemplateCategory;
  name: string;
  /**
   * Never null or empty — see `hasModality`. RadWeave Desktop's response
   * validator rejects the WHOLE list on a null modality, so a row without one
   * is dropped here rather than being allowed to break the entire catalogue.
   */
  modality: string;
  body_region: string | null;
  study_type: string | null;
  is_normal: boolean;
  /** The template's literal report text, ready to load into an editor. */
  body: string;
}

export interface TemplateCatalogResult {
  templates: CatalogTemplate[];
  counts: { radweave: number; user: number };
}

const SHARED_COLUMNS =
  "id, file_name, modality, body_region, pathology_category, pathology_name, " +
  "findings_text, opinion_text, full_text, is_normal";

const USER_COLUMNS =
  "id, title, modality, body_region, study_type, findings_text, conclusion_text, " +
  "is_favorite, updated_at";

interface SharedTemplateRow {
  id: string;
  file_name: string | null;
  modality: string | null;
  body_region: string | null;
  pathology_category: string | null;
  pathology_name: string | null;
  findings_text: string | null;
  opinion_text: string | null;
  full_text: string | null;
  is_normal: boolean | null;
}

interface UserTemplateRow {
  id: string;
  title: string | null;
  modality: string | null;
  body_region: string | null;
  study_type: string | null;
  findings_text: string | null;
  conclusion_text: string | null;
  is_favorite: boolean | null;
  updated_at: string | null;
}

export interface TemplateCatalogDeps {
  getUserPlan?: typeof getUserPlan;
  canUseFeature?: typeof canUseFeature;
  /** Injected in tests; production reads the shared `templates` table. */
  fetchSharedTemplates?: (modality?: string) => Promise<SharedTemplateRow[]>;
  /** Injected in tests; production reads `user_report_templates` for this user. */
  fetchUserTemplates?: (userId: string, modality?: string) => Promise<UserTemplateRow[]>;
}

/** Normal templates are filed under a "Normal <modality>" modality value. */
function sharedModalityFilter(modality: string): string[] {
  return [modality, `Normal ${modality}`];
}

async function defaultFetchSharedTemplates(
  supabase: SupabaseClient,
  modality?: string,
): Promise<SharedTemplateRow[]> {
  let query = supabase
    .from("templates")
    .select(SHARED_COLUMNS)
    .eq("is_hidden", false)
    .is("deleted_at", null)
    .or("source.is.null,source.eq.curated")
    .limit(2000);
  if (modality) query = query.in("modality", sharedModalityFilter(modality));

  const { data, error } = await query;
  if (error) throw new Error(`Shared template lookup failed: ${error.message}`);
  return (data ?? []) as unknown as SharedTemplateRow[];
}

async function defaultFetchUserTemplates(
  supabase: SupabaseClient,
  userId: string,
  modality?: string,
): Promise<UserTemplateRow[]> {
  let query = supabase
    .from("user_report_templates")
    .select(USER_COLUMNS)
    // See the SECURITY note at the top of this file. This runs on an
    // RLS-scoped client AND filters by owner; do not remove either.
    .eq("user_id", userId)
    .order("is_favorite", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(2000);
  if (modality) query = query.eq("modality", modality);

  const { data, error } = await query;
  if (error) throw new Error(`User template lookup failed: ${error.message}`);
  return (data ?? []) as unknown as UserTemplateRow[];
}

/**
 * Mirrors the website's `normalTemplateBody`: prefer the stored full text,
 * otherwise compose findings + opinion.
 */
function sharedTemplateBody(row: SharedTemplateRow): string {
  const full = (row.full_text ?? "").trim();
  if (full) return full;
  const findings = (row.findings_text ?? "").trim();
  const opinion = (row.opinion_text ?? "").trim();
  return [findings, opinion ? `OPINION:\n${opinion}` : ""].filter(Boolean).join("\n\n");
}

function userTemplateBody(row: UserTemplateRow): string {
  const findings = (row.findings_text ?? "").trim();
  const conclusion = (row.conclusion_text ?? "").trim();
  return [findings, conclusion ? `OPINION:\n${conclusion}` : ""].filter(Boolean).join("\n\n");
}

/** A template with no usable text is worse than no template — drop it. */
function hasBody(body: string): boolean {
  return body.trim().length > 20;
}

/**
 * Drop rows with no modality.
 *
 * Not cosmetic: Desktop's list validator rejects the entire response when any
 * item's modality is null, so one unlabelled row would silently strand the
 * client on its stale offline catalogue. Dropping the row loses one template;
 * emitting it loses all of them.
 */
function hasModality(row: { modality: string | null }): boolean {
  return typeof row.modality === "string" && row.modality.trim().length > 0;
}

/**
 * List every template this account may load.
 *
 * @param sharedClient   service-role client for the global `templates` table.
 * @param userClient     RLS-scoped client carrying the caller's own JWT.
 * @param user           identity from the verified credential — never the body.
 * @param options.modality optional filter in the website vocabulary ("CT", "MRI").
 */
export async function listTemplateCatalog(
  sharedClient: SupabaseClient,
  userClient: SupabaseClient,
  user: { id: string },
  options: { modality?: string } = {},
  deps: TemplateCatalogDeps = {},
): Promise<TemplateCatalogResult> {
  const getUserPlanFn = deps.getUserPlan ?? getUserPlan;
  const canUseFeatureFn = deps.canUseFeature ?? canUseFeature;
  const fetchShared =
    deps.fetchSharedTemplates ?? ((m?: string) => defaultFetchSharedTemplates(sharedClient, m));
  const fetchUser =
    deps.fetchUserTemplates ?? ((id: string, m?: string) => defaultFetchUserTemplates(userClient, id, m));

  const modality = options.modality?.trim() || undefined;

  const [sharedRows, userRows] = await Promise.all([
    fetchShared(modality),
    fetchUser(user.id, modality),
  ]);

  // The same entitlement rule the browser picker applies: without the
  // pathology feature, only normal templates are visible from the SHARED
  // catalogue. An account's OWN templates are never gated — it is its own
  // data, and gating it would hide work the user created and paid for.
  const plan = await getUserPlanFn(user.id);
  const canAccessPathology = await canUseFeatureFn(user.id, plan.plan, "pathology_reports");

  const radweave: CatalogTemplate[] = sharedRows
    .filter((row) => canAccessPathology || isNormalTemplateRow(row))
    .filter(hasModality)
    .map((row) => ({
      id: row.id,
      category: "radweave" as const,
      name: row.pathology_name?.trim() || row.file_name?.trim() || row.id,
      modality: (row.modality as string).trim(),
      body_region: row.body_region ?? null,
      study_type: null,
      is_normal: Boolean(isNormalTemplateRow(row)),
      body: sharedTemplateBody(row),
    }))
    .filter((template) => hasBody(template.body));

  const own: CatalogTemplate[] = userRows
    .filter(hasModality)
    .map((row) => ({
      id: row.id,
      category: "user" as const,
      name: row.title?.trim() || "Untitled template",
      modality: (row.modality as string).trim(),
      body_region: row.body_region ?? null,
      study_type: row.study_type ?? null,
      // user_report_templates has no normal/pathology flag. Claiming "normal"
      // would misrepresent an uploaded template, so this stays false until
      // such a column exists.
      is_normal: false,
      body: userTemplateBody(row),
    }))
    .filter((template) => hasBody(template.body));

  return {
    templates: [...radweave, ...own],
    counts: { radweave: radweave.length, user: own.length },
  };
}
