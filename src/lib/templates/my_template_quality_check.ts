/**
 * lib/templates/my_template_quality_check.ts
 *
 * Lightweight deterministic post-check for My Template Report mode ONLY.
 * Pure, side-effect-free functions — zero AI calls.
 *
 * Auto-cleans SAFE formatting issues only:
 *   - markdown code fences
 *   - duplicated blank lines
 *   - consecutive duplicate heading lines
 *   - exact duplicate lines inside the OPINION/IMPRESSION/CONCLUSION/DIAGNOSIS section
 *
 * Everything else is detection-only (returned as warnings). This module never
 * rewrites, removes, or invents clinical content — only obvious redundancy
 * and formatting noise.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MyTemplateQualityInput {
  reportText:           string;
  /** True when the user's saved template had a conclusion/opinion section. */
  hadOpinionInOriginal: boolean;
  /** The radiologist's free-text abnormal findings / edits for this case. */
  templateEdits:        string;
}

export interface MyTemplateQualityResult {
  cleanedText: string;
  warnings:    string[];
}

// ── Heading detection ──────────────────────────────────────────────────────────

const HEADING_RE = /^(FINDINGS|OPINION|IMPRESSION|CONCLUSION|DIAGNOSIS|TECHNIQUE|MRI FINDINGS|MRI TECHNIQUE)\s*:?\s*$/i;
const OPINION_HEADING_RE = /^(OPINION|IMPRESSION|CONCLUSION|DIAGNOSIS)\s*:?\s*$/i;
// Anchored prefixes (classic consultant-template phrasing) OR common mid-sentence
// normal/negative markers (e.g. "Both kidneys ARE NORMAL...", "...with NO FOCAL LESIONS.")
const NORMAL_LINE_RE =
  /^-?\s*(normal|intact|no\s|patent|clear|regular|unremarkable|preserved)/i;
const NORMAL_LINE_MIDSENTENCE_RE =
  /\b(?:is|are)\s+normal\b|\bwithin\s+normal\s+limits\b|\bno\s+(?:stones?|hydronephrosis|focal\s+lesions?|wall\s+thickening|abnormality)\b/i;

// Pathology nouns that, when ASSERTED (not negated), mean the line is already
// describing an abnormality rather than contradicting one — e.g. "Gallbladder
// calculus with no wall thickening." is a correctly-edited finding, not a
// leftover normal sentence, even though it contains "no wall thickening".
const PATHOLOGY_WORDS =
  "calculus|calculi|stones?|cysts?|masses?|tumou?rs?|fractures?|infarcts?|" +
  "hemorrhages?|haemorrhages?|nodules?|lesions?|stenosis|aneurysms?|" +
  "thromboses?|thrombus|abscesses?|effusions?|hydronephrosis|hydroureter|" +
  "splenomegaly|hepatomegaly|cardiomegaly";
const ASSERTED_PATHOLOGY_RE = new RegExp(`\\b(?:${PATHOLOGY_WORDS})\\b`, "i");
const NEGATED_PATHOLOGY_RE  = new RegExp(`\\bno\\s+(?:\\w+\\s+){0,2}(?:${PATHOLOGY_WORDS})\\b`, "i");

function hasAssertedPathology(line: string): boolean {
  if (!ASSERTED_PATHOLOGY_RE.test(line)) return false;
  return !NEGATED_PATHOLOGY_RE.test(line);
}

function isNormalLine(trimmed: string): boolean {
  if (NORMAL_LINE_RE.test(trimmed)) return true;
  if (hasAssertedPathology(trimmed)) return false; // already describes an abnormality, not a contradiction
  return NORMAL_LINE_MIDSENTENCE_RE.test(trimmed);
}

// ── Normalization helper ────────────────────────────────────────────────────────

function normalizeLine(line: string): string {
  return line
    .replace(/^\s*[-•*]\s*/, "")
    .replace(/\*\*/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 1. Strip markdown code fences (auto-clean) ─────────────────────────────────

function stripMarkdownFences(text: string): string {
  return text.replace(/```[a-z]*\n?/gi, "").replace(/~~~[a-z]*\n?/gi, "");
}

// ── 2. Collapse duplicate adjacent lines + repeated headings (auto-clean) ──────

function collapseDuplicateAdjacentLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const prev = out[out.length - 1];
    const normTrimmed = normalizeLine(trimmed);
    if (trimmed && prev !== undefined && normTrimmed !== "" && normalizeLine(prev) === normTrimmed) {
      continue; // skip exact repeat of the immediately preceding line (incl. repeated headings)
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ── 3. Dedupe lines within the OPINION-type section (auto-clean) ───────────────

function dedupeOpinionSection(text: string): string {
  const lines = text.split("\n");
  let inOpinion = false;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (HEADING_RE.test(trimmed)) {
      inOpinion = OPINION_HEADING_RE.test(trimmed);
      seen.clear();
      out.push(line);
      continue;
    }
    if (inOpinion && trimmed) {
      const key = normalizeLine(trimmed);
      if (key) {
        if (seen.has(key)) continue; // drop exact duplicate opinion line
        seen.add(key);
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// ── Detection: missing OPINION heading ──────────────────────────────────────────

function hasOpinionHeading(text: string): boolean {
  return text.split("\n").some(l => OPINION_HEADING_RE.test(l.trim()));
}

// ── Detection: duplicate sentences within FINDINGS (self-referential) ──────────

function findDuplicateFindingsSentences(reportText: string): string[] {
  const warnings: string[] = [];
  const lines = reportText.split("\n");
  const counts = new Map<string, { count: number; sample: string }>();
  let inOpinion = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (HEADING_RE.test(trimmed)) {
      inOpinion = OPINION_HEADING_RE.test(trimmed);
      continue;
    }
    if (inOpinion) continue; // OPINION duplicates are handled separately (auto-cleaned)

    const key = normalizeLine(trimmed);
    if (!key || key.length < 8) continue; // skip trivial/short fragments

    const entry = counts.get(key) ?? { count: 0, sample: trimmed };
    entry.count += 1;
    counts.set(key, entry);
  }

  for (const entry of Array.from(counts.values())) {
    if (entry.count > 1) {
      warnings.push(
        `Possible duplicate sentence in FINDINGS (appears ${entry.count} times): "${entry.sample.slice(0, 80)}"`
      );
    }
  }
  return warnings;
}

// ── Detection: unresolved organ contradiction ───────────────────────────────────
// Deliberately narrow and conservative — anatomy-noun allowlist only, never
// pathology vocabulary, to keep false positives low. Warning-only, never
// rewrites the report.

const ANATOMY_KEYWORDS = new Set([
  "liver", "spleen", "pancreas", "kidney", "kidneys", "aorta", "ivc",
  "gallbladder", "ureter", "ureters", "bladder", "prostate", "uterus",
  "ovary", "ovaries", "adrenal", "adrenals", "brain", "cerebellum",
  "ventricle", "ventricles", "heart", "lung", "lungs", "pleura",
  "pericardium", "thyroid", "appendix", "stomach", "bowel", "colon",
  "rectum", "meniscus", "menisci", "ligament", "ligaments", "tendon",
  "tendons", "cartilage", "disc", "discs", "cord", "vertebrae", "facet",
  "marrow", "sinus", "sinuses", "mastoid",
]);

// Medical compound-term roots that do not share a plain substring with the
// English organ noun (e.g. "spleen" vs "splenomegaly" — note the spelling
// difference: spleen has a double "e", splen- root does not).
const ORGAN_ROOT_ALIASES: Record<string, string[]> = {
  spleen:      ["splen"],
  liver:       ["hepat"],
  kidney:      ["renal", "nephro"],
  kidneys:     ["renal", "nephro"],
  heart:       ["cardiac", "cardi"],
  gallbladder: ["cholecyst", "biliary"],
  bladder:     ["vesical", "cystitis", "cystic"],
  uterus:      ["uterine"],
  brain:       ["cerebr", "intracranial", "cranial"],
  thyroid:     ["thyroid"],
};

function extractAnatomyKeywords(line: string): string[] {
  const tokens = line.toLowerCase().split(/[\s,;.()[\]/]+/).filter(Boolean);
  return tokens.filter(t => ANATOMY_KEYWORDS.has(t));
}

function organMentionedInEdits(organWord: string, abnormalContext: string): boolean {
  if (abnormalContext.includes(organWord)) return true;
  const aliases = ORGAN_ROOT_ALIASES[organWord];
  return aliases ? aliases.some(a => abnormalContext.includes(a)) : false;
}

function findUnresolvedContradictions(reportText: string, templateEdits: string): string[] {
  const edits = templateEdits.trim();
  if (!edits) return [];

  const abnormalContext = edits.toLowerCase();
  const warnings: string[] = [];

  const findingsSection = reportText
    .split(/\n\s*(?:OPINION|IMPRESSION|CONCLUSION|DIAGNOSIS)\s*:/i)[0] ?? reportText;

  for (const line of findingsSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !isNormalLine(trimmed)) continue;

    const keywords = extractAnatomyKeywords(trimmed);
    for (const kw of keywords) {
      if (organMentionedInEdits(kw, abnormalContext)) {
        warnings.push(
          `Possible unresolved contradiction: FINDINGS still has an unmodified normal statement ` +
          `mentioning "${kw}" ("${trimmed.slice(0, 80)}"), but the requested edits reference this structure.`
        );
        break; // one warning per line is enough
      }
    }
  }
  return warnings;
}

// ── Main entry point ────────────────────────────────────────────────────────────

export function runMyTemplateQualityCheck(input: MyTemplateQualityInput): MyTemplateQualityResult {
  const warnings: string[] = [];

  // Auto-clean — safe, deterministic, never adds/removes/alters clinical content.
  let cleaned = stripMarkdownFences(input.reportText);
  cleaned = collapseDuplicateAdjacentLines(cleaned);
  cleaned = dedupeOpinionSection(cleaned);
  cleaned = cleaned.trim();

  // Detection-only — never rewritten here.
  if (input.hadOpinionInOriginal && !hasOpinionHeading(cleaned)) {
    warnings.push(
      "Original template had an OPINION/IMPRESSION/CONCLUSION/DIAGNOSIS section, " +
      "but the generated report is missing one."
    );
  }
  warnings.push(...findDuplicateFindingsSentences(cleaned));
  warnings.push(...findUnresolvedContradictions(cleaned, input.templateEdits));

  return { cleanedText: cleaned, warnings };
}

