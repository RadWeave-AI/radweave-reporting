import type { SupabaseClient } from "@supabase/supabase-js";
import { getBodyRegionSearchAliases } from "./template-region-aliases.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MatchInput {
  modality:        string;   // "CT" | "MRI" | "PET CT"
  body_region:     string;   // "Abdomen and pelvis" | "CNS" | "MSK" | "Chest" | "Angio" | "PET CT"
  indication:      string;   // free text — clinical question from radiologist
  findings:        string;   // free text — described findings
  field_strength?:  string;   // MRI only: "3T" | "1T" | "1.5T"
  study_type?:      string;   // specific anatomy: "Cervical Spine" | "Right Knee" | etc.
  age?:             number;   // optional patient age in years
  sex?:             "Male" | "Female"; // optional patient sex
  laterality?:      string;   // "Right" | "Left" | "Bilateral" — for paired structures
  report_header?:   string;   // skeleton-provided header line (V2 page)
  opinion_hints?:   string;   // pre-selected opinion points from pathology picker (V3)
  template_guided?: boolean;  // selected consultant template; user edits are clinical truth
  template_edits?:  string;   // explicit changes that override the selected template
  mri_technique?:   string[]; // MRI only: standard technique lines from skeleton (auto-populated)
  // My Template Report only — user's extracted reporting style profile (style guidance only)
  style_profile?:   ReportingStyleProfile | null;
  // My Template Report only — top-N of the user's OWN past reports retrieved by
  // embedding similarity to the current case. STYLE reference only — never a
  // source of clinical findings (enforced in prompt_builder.ts).
  style_examples?:  Array<{
    title:           string;
    findings_text:   string;
    conclusion_text: string | null;
    similarity:      number;
  }>;
  // My Template Report only — true when the selected template is the user's own
  // personal template (not a shared consultant template / standard Template-guided
  // Report). Gates the stricter My Template preservation/no-duplication/contradiction
  // rules in prompt_builder.ts WITHOUT affecting standard template_guided behavior.
  my_template_mode?: boolean;
  // Quick Report only — curated normal skeleton findings for this modality/study type.
  // Provides the normal baseline; user's free-text abnormal findings override contradicting lines.
  normal_skeleton_findings?: string[];
}

/** Subset of user_reporting_style_profiles.profile used in prompt building. */
export interface ReportingStyleProfile {
  conclusion_header:             string;
  report_structure:              string;
  uses_bullets:                  boolean;
  uses_numbered_impression:      boolean;
  preferred_section_order:       string[];
  normal_phrase_style:           string[];
  common_stock_phrases:          string[];
  preferred_uncertainty_phrases: string[];
  measurement_style:             string;
  laterality_style:              string;
  comparison_style:              string;
  follow_up_style:               string;
  do_not_use:                    string[];
  summary:                       string;
}

export interface MatchedTemplate {
  id:                 string;
  file_name:          string;
  body_region:        string;
  modality:           string;
  pathology_category: string;
  pathology_name:     string;
  findings_text:      string;
  opinion_text:       string;
  full_text:          string;
  keywords:           string[];
  relevance_score:    number;
  matched_segment_findings?: string;
  matched_segment_opinion?:  string | null;
}

export interface MatchResult {
  matched_templates:  MatchedTemplate[];
  match_confidence:   "high" | "medium" | "low";
  pathology_category: string;   // best-guess category from top result
  query_terms:        string[]; // terms extracted from indication + findings
}

// ── Stop-words (excluded from query term extraction) ─────────────────────────
const STOP_WORDS = new Set([
  "the","a","an","and","or","in","on","at","to","for","of","is","are","was",
  "were","with","this","that","there","from","has","have","had","not","no",
  "be","been","by","as","its","it","but","if","can","may","show","shows",
  "showing","seen","noted","noted","demonstrated","demonstrates","appear",
  "appears","right","left","bilateral","upper","lower","middle","anterior",
  "posterior","medial","lateral","consistent","features","study","scan",
  "image","imaging","patient","history","clinical","question",
]);

// ── Extract meaningful query terms from free text ────────────────────────────
function extractQueryTerms(indication: string, findings: string): string[] {
  const combined = `${indication} ${findings}`.toLowerCase();

  // Tokenise on non-word chars, keep tokens ≥ 3 chars, drop stop-words
  const tokens = combined
    .split(/[\s,;:.!?()\[\]\/\\]+/)
    .map(t => t.replace(/[^a-z0-9-]/g, ""))
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));

  // De-duplicate while preserving first-occurrence order
  return Array.from(new Set(tokens));
}

// ── Score a single template against query terms ──────────────────────────────
function scoreTemplate(template: MatchedTemplate, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  let score = 0;
  const lcTerms = queryTerms.map(t => t.toLowerCase());

  // 1. Keyword overlap (keywords are pre-indexed tags)
  const lcKeywords = (template.keywords ?? []).map(k => k.toLowerCase());
  for (const kw of lcKeywords) {
    for (const qt of lcTerms) {
      if (kw === qt)          { score += 3; break; }   // exact keyword match
      if (kw.includes(qt) || qt.includes(kw)) { score += 1; break; }  // partial
    }
  }

  // 2. Pathology category / file_name match (high signal)
  const catText = `${template.pathology_category} ${template.file_name}`.toLowerCase();
  for (const qt of lcTerms) {
    if (catText.includes(qt)) score += 2;
  }

  // 3. Findings + opinion text match (presence of clinical terms)
  const bodyText = `${template.findings_text} ${template.opinion_text}`.toLowerCase();
  for (const qt of lcTerms) {
    if (bodyText.includes(qt)) score += 1;
  }

  return score;
}

// ── Determine match confidence from top score ────────────────────────────────
function confidence(topScore: number, structuralMatchCount: number): MatchResult["match_confidence"] {
  if (topScore >= 6 && structuralMatchCount >= 3) return "high";
  if (topScore >= 3 || structuralMatchCount >= 3) return "medium";
  return "low";
}

// ── Main matcher ──────────────────────────────────────────────────────────────
export async function matchTemplates(
  supabase: SupabaseClient,
  input: MatchInput,
  options?: { limit?: number },
): Promise<MatchResult> {
  const queryTerms = extractQueryTerms(input.indication, input.findings);
  // Step 22B: known body_region casing/vocabulary mismatches (e.g. "Head and
  // Neck" UI value vs "Head and neck" / "CNS" stored rows) made many CT/MRI
  // templates unreachable via the old exact .eq() match. Search all known
  // aliases instead — read-only, no DB rows are touched.
  const bodyRegionAliases = getBodyRegionSearchAliases(input.body_region);

  type RawRow = Omit<MatchedTemplate, "relevance_score">;

  // ── Phase 1: exact modality + body_region (alias-aware) ──────────────────
  const COLUMNS =
    "id, file_name, body_region, modality, pathology_category, " +
    "pathology_name, findings_text, opinion_text, full_text, keywords";

  const q1 = await supabase
    .from("templates")
    .select(COLUMNS)
    .eq("modality", input.modality)
    .in("body_region", bodyRegionAliases.length ? bodyRegionAliases : [input.body_region])
    .eq("is_hidden", false)
    .is("deleted_at", null)
    .or("source.is.null,source.eq.curated")
    .limit(200);

  if (q1.error) throw new Error(`Supabase query failed: ${q1.error.message}`);

  let candidates: RawRow[] = (q1.data ?? []) as unknown as RawRow[];

  // ── Phase 2: fall back to body_region (alias-aware) only if < 3 candidates ─
  if (candidates.length < 3) {
    const q2 = await supabase
      .from("templates")
      .select(COLUMNS)
      .in("body_region", bodyRegionAliases.length ? bodyRegionAliases : [input.body_region])
      .eq("is_hidden", false)
      .is("deleted_at", null)
      .or("source.is.null,source.eq.curated")
      .limit(200);

    const wider = (q2.data ?? []) as unknown as RawRow[];
    const seen  = new Set(candidates.map((r) => r.id));
    for (const row of wider) {
      if (!seen.has(row.id)) { candidates = [...candidates, row]; seen.add(row.id); }
    }
  }

  // ── Phase 3: fall back to modality only if still < 3 ─────────────────────
  if (candidates.length < 3) {
    const q3 = await supabase
      .from("templates")
      .select(COLUMNS)
      .eq("modality", input.modality)
      .eq("is_hidden", false)
      .is("deleted_at", null)
      .or("source.is.null,source.eq.curated")
      .limit(200);

    const byModality = (q3.data ?? []) as unknown as RawRow[];
    const seen       = new Set(candidates.map((r) => r.id));
    for (const row of byModality) {
      if (!seen.has(row.id)) { candidates = [...candidates, row]; seen.add(row.id); }
    }
  }

  if (candidates.length === 0) {
    return {
      matched_templates:  [],
      match_confidence:   "low",
      pathology_category: "Unknown",
      query_terms:        queryTerms,
    };
  }

  // ── Score and sort candidates ─────────────────────────────────────────────
  const scored: MatchedTemplate[] = candidates.map(t => ({
    ...t,
    relevance_score: scoreTemplate(t as MatchedTemplate, queryTerms),
  }));

  scored.sort((a, b) => b.relevance_score - a.relevance_score);

  const top3 = scored.slice(0, 3);
  const topScore = top3[0]?.relevance_score ?? 0;

  // Structural match = template shares modality with input and its body_region
  // is a known alias of the input's body_region (not just an exact string match —
  // see Step 22B body_region alias normalization).
  const bodyRegionAliasSet = new Set(bodyRegionAliases.map(r => r.toLowerCase()));
  const structuralCount = top3.filter(
    t => t.modality === input.modality && bodyRegionAliasSet.has((t.body_region ?? "").toLowerCase())
  ).length;

  const resultLimit = options?.limit ?? 3;
  return {
    matched_templates:  scored.slice(0, resultLimit),
    match_confidence:   confidence(topScore, structuralCount),
    pathology_category: top3[0]?.pathology_category ?? "Unknown",
    query_terms:        queryTerms,
  };
}

