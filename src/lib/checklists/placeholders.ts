/**
 * Typed placeholder DSL for checklist item text (Mission #9).
 *
 * Syntax:
 *   {{name:unit}}                    number input, unit-labeled  e.g. {{size:mm}}
 *   {{name:select:opt1|opt2|...}}    dropdown                    e.g. {{side:select:right|left}}
 *   {{name}}                         free text input
 *   [[ ...text with {{placeholders}}... ]]   optional segment — omitted entirely if
 *                                             ANY placeholder inside is left blank.
 *                                             Segments never nest.
 *
 * This module is the single source of truth for parsing, substituting, validating,
 * and (server-side) stripping this syntax. See STEP-by-STEP brief "Mission #9" for
 * the full design; this file implements SHARED PARSER + SERVER SAFETY NET only.
 */

export type PlaceholderKind = "number" | "select" | "text";

export interface PlaceholderNode {
  type: "placeholder";
  name: string;
  kind: PlaceholderKind;
  unit?: string;       // number kind only
  options?: string[];  // select kind only
  raw: string;         // original "{{...}}" source text, for error messages/preview
}

export interface TextNode {
  type: "text";
  value: string;
}

export interface SegmentNode {
  type: "segment";
  nodes: Array<TextNode | PlaceholderNode>;
  raw: string; // original "[[...]]" source text
}

export type ParsedNode = TextNode | PlaceholderNode | SegmentNode;

export interface ParseResult {
  nodes: ParsedNode[];
  // Unique placeholder names, in first-appearance order, across top-level AND
  // segment-nested placeholders. Same name in findings_text and opinion_text of
  // one item is intentionally the caller's concern (one merged value set) —
  // this module only reports names found within the single text passed in.
  placeholderNames: string[];
}

export interface ValidationIssue {
  message: string;
  raw?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface StripResult {
  result: string;
  stripped: boolean; // true if any {{...}} or [[...]] token was found and removed
}

// Matches one well-formed "{{...}}" placeholder token (no nested braces).
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
// Tokenizer: placeholders, and segment delimiters, scanned left-to-right.
const TOKEN_RE = /\{\{[^{}]*\}\}|\[\[|\]\]/g;

function parsePlaceholderInner(fullMatch: string): PlaceholderNode {
  const inner = fullMatch.slice(2, -2).trim();
  const colonIdx = inner.indexOf(":");

  if (colonIdx === -1) {
    return { type: "placeholder", name: inner, kind: "text", raw: fullMatch };
  }

  const name = inner.slice(0, colonIdx).trim();
  const rest = inner.slice(colonIdx + 1);

  if (rest.startsWith("select:")) {
    const options = rest
      .slice("select:".length)
      .split("|")
      .map((o) => o.trim());
    return { type: "placeholder", name, kind: "select", options, raw: fullMatch };
  }

  return { type: "placeholder", name, kind: "number", unit: rest.trim(), raw: fullMatch };
}

/**
 * Parse authored text into a flat node list. Lenient by design — generation is
 * never blocked by bad syntax. Unmatched "]]" or a "[[" encountered while
 * already inside a segment degrade to literal text (segments never nest).
 * Use validate() to surface authoring errors instead.
 */
export function parse(text: string): ParseResult {
  const nodes: ParsedNode[] = [];
  const placeholderNames: string[] = [];
  const seenNames = new Set<string>();

  function trackName(name: string) {
    if (name && !seenNames.has(name)) {
      seenNames.add(name);
      placeholderNames.push(name);
    }
  }

  let lastIndex = 0;
  let inSegment = false;
  let segmentNodes: Array<TextNode | PlaceholderNode> = [];
  let segmentStart = -1;

  function pushText(value: string) {
    if (!value) return;
    if (inSegment) segmentNodes.push({ type: "text", value });
    else nodes.push({ type: "text", value });
  }

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const token = match[0];
    if (match.index > lastIndex) pushText(text.slice(lastIndex, match.index));
    lastIndex = TOKEN_RE.lastIndex;

    if (token === "[[") {
      if (inSegment) {
        // Nesting not supported — degrade to literal text.
        pushText("[[");
      } else {
        inSegment = true;
        segmentNodes = [];
        segmentStart = match.index;
      }
      continue;
    }

    if (token === "]]") {
      if (inSegment) {
        nodes.push({
          type: "segment",
          nodes: segmentNodes,
          raw: text.slice(segmentStart, lastIndex),
        });
        inSegment = false;
        segmentNodes = [];
      } else {
        // Stray closer with no matching opener — literal text.
        pushText("]]");
      }
      continue;
    }

    // Placeholder token.
    const node = parsePlaceholderInner(token);
    trackName(node.name);
    if (inSegment) segmentNodes.push(node);
    else nodes.push(node);
  }

  if (lastIndex < text.length) pushText(text.slice(lastIndex));

  // Unterminated "[[" at end of input: flush accumulated segment content as
  // plain text (lenient parse; validate() reports this as an error).
  if (inSegment) {
    nodes.push({ type: "text", value: text.slice(segmentStart) });
  }

  return { nodes, placeholderNames };
}

const WHITESPACE_CLEANUP_STEPS: Array<[RegExp, string]> = [
  [/[ \t]{2,}/g, " "],       // collapse runs of spaces/tabs
  [/\s+([,.;:])/g, "$1"],   // no space before punctuation (segment-omission artifact)
  [/\n{3,}/g, "\n\n"],       // collapse blank-line runs (defensive; findings are usually single-line)
];

function cleanupWhitespace(value: string): string {
  let out = value;
  for (const [pattern, replacement] of WHITESPACE_CLEANUP_STEPS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}

function capitalizeFirst(value: string): string {
  const match = value.match(/[a-zA-Z]/);
  if (!match || match.index === undefined) return value;
  const i = match.index;
  return value.slice(0, i) + value[i].toUpperCase() + value.slice(i + 1);
}

function renderPlaceholderValue(node: PlaceholderNode, values: Record<string, string>): string {
  const raw = values[node.name];
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  if (node.kind === "number" && node.unit) return `${trimmed} ${node.unit}`;
  return trimmed;
}

function isBlank(node: PlaceholderNode, values: Record<string, string>): boolean {
  return !(values[node.name]?.trim());
}

const WORD_CHAR_RE = /[A-Za-z0-9]/;

/**
 * Join rendered leaf strings (one per text/placeholder node, flattened across
 * segment boundaries) with a word-boundary-aware separator. A naive
 * parts.join("") glues two word-characters together whenever the authored
 * source has zero literal whitespace at a segment/placeholder seam (e.g.
 * "{{location}}[[with ..." — no space between "}}" and "[["), producing
 * "ureterwith"-style defects. This inserts exactly one space at a seam ONLY
 * when both abutting characters are alphanumeric; seams that already have
 * whitespace, or that meet punctuation, are left untouched (cleanupWhitespace
 * handles any resulting double-space/space-before-punctuation afterward).
 * Never touches characters WITHIN a single leaf (e.g. "L4/5" typed as one
 * literal run is never split).
 */
function joinWithWordBoundaries(leaves: string[]): string {
  let result = "";
  for (const leaf of leaves) {
    if (!leaf) continue;
    if (result) {
      const prevChar = result[result.length - 1];
      const nextChar = leaf[0];
      if (WORD_CHAR_RE.test(prevChar) && WORD_CHAR_RE.test(nextChar)) result += " ";
    }
    result += leaf;
  }
  return result;
}

/**
 * Substitute values into authored text and return the final report-ready
 * string. Blank placeholders inside a [[ ]] segment omit the whole segment;
 * blank placeholders outside a segment collapse to "" (no dash, no token).
 * A leading capital letter is applied to the assembled result (the DSL is
 * meant to open a sentence, per the ureteric-stone reference example) —
 * ONLY when the text actually contains placeholders/segments; plain text
 * with no placeholders is returned byte-identical to the input.
 */
export function substitute(text: string, values: Record<string, string>): string {
  const { nodes, placeholderNames } = parse(text);
  if (placeholderNames.length === 0 && !nodes.some((n) => n.type === "segment")) {
    return text; // no placeholders/segments anywhere — untouched passthrough
  }

  // Flat list of leaf strings — one per text/placeholder node, with segment
  // boundaries fully flattened in — so the word-boundary join protects every
  // seam uniformly, both top-level and inside an included segment.
  const leaves: string[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      leaves.push(node.value);
      continue;
    }
    if (node.type === "placeholder") {
      leaves.push(renderPlaceholderValue(node, values));
      continue;
    }
    // segment: omit entirely if any inner placeholder is blank
    const anyBlank = node.nodes.some((n) => n.type === "placeholder" && isBlank(n, values));
    if (anyBlank) continue;
    for (const inner of node.nodes) {
      leaves.push(inner.type === "text" ? inner.value : renderPlaceholderValue(inner, values));
    }
  }

  return capitalizeFirst(cleanupWhitespace(joinWithWordBoundaries(leaves)));
}

/**
 * Report syntax errors without blocking anything — used by authoring UX
 * (live preview) and lib/admin/checklist-health.ts (invalid_placeholder_syntax).
 */
export function validate(text: string): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Unbalanced {{ }}: strip every well-formed placeholder, then anything
  // left behind with a stray "{{" or "}}" is unbalanced.
  const residual = text.replace(PLACEHOLDER_RE, "");
  if (residual.includes("{{") || residual.includes("}}")) {
    issues.push({ message: "Unbalanced {{ }} — every {{ must have a matching }} with no nested braces." });
  }

  // Empty placeholder name, e.g. "{{}}" or "{{:mm}}".
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const inner = m[1];
    const name = inner.split(":")[0].trim();
    if (!name) {
      issues.push({ message: "Placeholder is missing a name.", raw: m[0] });
    }
  }

  // Malformed select: fewer than 2 options, or an empty option.
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const node = parsePlaceholderInner(m[0]);
    if (node.kind === "select") {
      const options = node.options ?? [];
      if (options.length < 2 || options.some((o) => !o)) {
        issues.push({ message: `Malformed select placeholder "${node.name}" — needs at least two non-empty options separated by |.`, raw: m[0] });
      }
    }
  }

  // Unbalanced / nested [[ ]]: walk bracket tokens with a depth counter that
  // never exceeds 1 (segments never nest).
  let depth = 0;
  for (const m of text.matchAll(/\[\[|\]\]/g)) {
    if (m[0] === "[[") {
      if (depth > 0) {
        issues.push({ message: "Nested [[ ]] segments are not supported." });
      }
      depth++;
    } else {
      depth--;
      if (depth < 0) {
        issues.push({ message: "Unmatched ]] with no preceding [[." });
        depth = 0;
      }
    }
  }
  if (depth > 0) {
    issues.push({ message: "Unbalanced [[ ]] — a [[ segment was never closed." });
  }

  return { valid: issues.length === 0, issues };
}

// Historical "leave it blank" conventions authors used before this DSL existed
// (dashes, slash-pairs, em-dash) — flagged by checklist-health as
// legacy_blank_convention so those items can be migrated to typed placeholders
// in the separate scripted retrofit pass. Detection only; no rewriting.
const LEGACY_BLANK_RE = /(^|\s)(-{2,4}|—)(\s|$)|\b[A-Za-z]+\/[A-Za-z]+\b/;

export function hasLegacyBlankConvention(text: string): boolean {
  return LEGACY_BLANK_RE.test(text);
}

/**
 * SERVER SAFETY NET: remove any surviving {{...}}/[[...]] syntax from text
 * that reaches the server unsubstituted (a direct API caller bypassing the
 * client, or a client bug). Whole [[ ]] segments are dropped (mirrors the
 * client's blank-segment-omission rule); bare {{...}} placeholders collapse
 * to "" (mirrors the client's blank-placeholder rule). Never throws, never
 * blocks generation.
 */
export function strip(text: string): StripResult {
  if (!text) return { result: text, stripped: false };

  let stripped = false;
  let out = text.replace(/\[\[[\s\S]*?\]\]/g, () => {
    stripped = true;
    return "";
  });
  out = out.replace(PLACEHOLDER_RE, () => {
    stripped = true;
    return "";
  });

  if (!stripped) return { result: text, stripped: false };
  return { result: cleanupWhitespace(out), stripped: true };
}

