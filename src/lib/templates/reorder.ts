import { expandForSegmentMatching } from "./segment.ts";

export interface ReorderResult {
  text: string;
  reordered: boolean;
  ambiguous: boolean;
  stats?: MatchStats;
}

interface SourceLine {
  content: string;
  eol: string;
}

interface MovableRun {
  units: string[];
  separators: string[];
}

interface ParsedReport {
  findingsPrefix: string;
  findings: MovableRun;
  headerLine: string;
  opinion: MovableRun;
  opinionSuffix: string;
}

interface MatchedUnit {
  text: string;
  originalIndex: number;
  targetIndex: number | null;
  score: number;
}

export interface MatchStats {
  scoreThresholdMatches: number;      // score >= 2
  singleWordExceptionMatches: number; // score === 1, globally-unique word
  rejectedWeakMatches: number;        // score === 1 but word not globally unique -> treated as unmatched
}

const HEADER_LINE = /^(OPINION|IMPRESSION|CONCLUSION)\s*:?\s*$/i;

const REORDER_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were",
  "has", "have", "had", "not", "but", "into", "onto", "than", "then", "there",
  "these", "seen", "shows", "showing", "noted", "appears", "normal", "mild",
  "moderate", "severe", "evidence", "signal", "signals", "finding", "findings",
  "within", "without", "small", "large", "change", "changes",
]);

function splitSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end += 1;

    let eol = "";
    if (end < text.length) {
      eol = text[end] === "\r" && text[end + 1] === "\n" ? "\r\n" : text[end];
    }

    lines.push({ content: text.slice(start, end), eol });
    start = end + eol.length;
  }

  return lines;
}

function serializeLines(lines: SourceLine[]): string {
  return lines.map((line) => line.content + line.eol).join("");
}

function isBlank(line: SourceLine): boolean {
  return line.content.trim().length === 0;
}

function isBullet(line: SourceLine): boolean {
  return line.content.trim().startsWith("- ");
}

function foldContinuationLines(lines: SourceLine[]): SourceLine[] {
  const folded = lines.map((line) => ({ ...line }));
  let bulletIndex: number | null = null;

  for (let index = 0; index < folded.length; index += 1) {
    const line = folded[index];
    const trimmed = line.content.trim();

    if (isBullet(line)) {
      bulletIndex = index;
      continue;
    }

    if (
      bulletIndex !== null
      && /^[ \t]/.test(line.content)
      && trimmed.length > 0
      && !trimmed.startsWith("- ")
      && !HEADER_LINE.test(trimmed)
    ) {
      folded[bulletIndex].content += ` ${trimmed}`;
      folded[index] = { content: "", eol: "\n" };
      continue;
    }

    bulletIndex = null;
  }

  return folded;
}

function toUnit(lines: SourceLine[]): { text: string; separator: string } {
  const last = lines[lines.length - 1];
  return {
    text: serializeLines(lines.slice(0, -1)) + last.content,
    separator: last.eol,
  };
}

function parseRun(lines: SourceLine[], start: number, end: number): MovableRun | null {
  const units: string[] = [];
  const separators: string[] = [];
  let cursor = start;

  while (cursor < end) {
    if (!isBullet(lines[cursor])) return null;

    const unitLines = [lines[cursor]];
    cursor += 1;
    while (cursor < end && isBlank(lines[cursor])) {
      unitLines.push(lines[cursor]);
      cursor += 1;
    }

    const unit = toUnit(unitLines);
    units.push(unit.text);
    separators.push(unit.separator);
  }

  return units.length > 0 ? { units, separators } : null;
}

function parseReport(reportText: string): ParsedReport | null {
  const lines = splitSourceLines(reportText);
  const headerIndex = lines.findIndex((line) => HEADER_LINE.test(line.content.trim()));
  if (headerIndex < 0) return null;

  const before = foldContinuationLines(lines.slice(0, headerIndex));
  let lastNonBlank = before.length - 1;
  while (lastNonBlank >= 0 && isBlank(before[lastNonBlank])) lastNonBlank -= 1;
  if (lastNonBlank < 0 || !isBullet(before[lastNonBlank])) return null;

  let findingsStart = lastNonBlank;
  while (findingsStart > 0) {
    let previous = findingsStart - 1;
    while (previous >= 0 && isBlank(before[previous])) previous -= 1;
    if (previous < 0 || !isBullet(before[previous])) break;
    findingsStart = previous;
  }

  // A bullet before the non-bullet boundary means apparent multi-line content split
  // what should have been one contiguous FINDINGS run. Do not guess how to group it.
  if (before.slice(0, findingsStart).some(isBullet)) return null;

  const findings = parseRun(before, findingsStart, before.length);
  if (!findings) return null;

  const afterHeader = foldContinuationLines(lines.slice(headerIndex + 1));
  if (afterHeader.length === 0 || !isBullet(afterHeader[0])) return null;

  let opinionEnd = 0;
  while (opinionEnd < afterHeader.length) {
    if (!isBullet(afterHeader[opinionEnd])) break;
    opinionEnd += 1;
    while (opinionEnd < afterHeader.length && isBlank(afterHeader[opinionEnd])) {
      opinionEnd += 1;
    }
  }

  // A later bullet after a non-bullet line is structurally ambiguous.
  if (afterHeader.slice(opinionEnd).some(isBullet)) return null;

  const opinion = parseRun(afterHeader, 0, opinionEnd);
  if (!opinion) return null;

  return {
    findingsPrefix: serializeLines(before.slice(0, findingsStart)),
    findings,
    headerLine: lines[headerIndex].content + lines[headerIndex].eol,
    opinion,
    opinionSuffix: serializeLines(afterHeader.slice(opinionEnd)),
  };
}

// Longer suffixes checked first so "-itis" is stripped before "-is" can fire.
// Minimum stem length of 4 prevents over-trimming short words (e.g. "basis" stays).
const MEDICAL_SUFFIXES = ["itis", "itic", "osis", "otic", "is", "ic"] as const;
const MIN_STEM_LENGTH = 4;

function stem(word: string): string {
  for (const suf of MEDICAL_SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= MIN_STEM_LENGTH) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return Array.from(new Set(
    words
      .filter((word) => word.length >= 3 && !REORDER_STOP_WORDS.has(word))
      .map(stem),
  ));
}

function bulletText(unit: string): string {
  const firstLine = splitSourceLines(unit)[0]?.content.trim() ?? "";
  let text = firstLine.startsWith("- ") ? firstLine.slice(2).trim() : firstLine;
  if (text.startsWith("**") && text.endsWith("**") && text.length >= 4) {
    text = text.slice(2, -2).trim();
  }
  return text;
}

// A word is only trusted as a lone (score===1) match signal when it is globally
// unique enough to not be coincidental: it must appear in exactly one typed
// finding's query words, AND in exactly one bullet within this same run (not
// counting the other section). Neither list is a maintained stopword blacklist —
// this is a frequency-based confidence gate instead, so no word needs to be
// hand-enumerated to be trusted or distrusted.
function matchAndReorderRun(
  run: MovableRun,
  typedQueryWordSets: Set<string>[],
  wordToFindingCount: Map<string, number>,
): { units: string[]; collision: boolean; stats: MatchStats } {
  const bulletWordSets = run.units.map((text) => new Set(tokenize(bulletText(text))));
  const wordToBulletCount = new Map<string, number>();
  for (const wordSet of bulletWordSets) {
    for (const word of wordSet) {
      wordToBulletCount.set(word, (wordToBulletCount.get(word) ?? 0) + 1);
    }
  }

  const stats: MatchStats = { scoreThresholdMatches: 0, singleWordExceptionMatches: 0, rejectedWeakMatches: 0 };

  const matched: MatchedUnit[] = run.units.map((text, originalIndex) => {
    const bulletWords = bulletWordSets[originalIndex];
    let bestScore = 0;
    let targetIndex: number | null = null;

    typedQueryWordSets.forEach((queryWords, typedIndex) => {
      let rawScore = 0;
      let soleSharedWord: string | null = null;
      for (const word of queryWords) {
        if (bulletWords.has(word)) {
          rawScore += 1;
          if (rawScore === 1) soleSharedWord = word;
        }
      }

      let confidentScore = 0;
      if (rawScore >= 2) {
        confidentScore = rawScore;
        stats.scoreThresholdMatches += 1;
      } else if (rawScore === 1 && soleSharedWord !== null) {
        const globallyUnique =
          wordToFindingCount.get(soleSharedWord) === 1 && wordToBulletCount.get(soleSharedWord) === 1;
        if (globallyUnique) {
          confidentScore = 1;
          stats.singleWordExceptionMatches += 1;
        } else {
          stats.rejectedWeakMatches += 1;
        }
      }

      if (confidentScore > bestScore) {
        bestScore = confidentScore;
        targetIndex = typedIndex;
      }
    });

    return { text, originalIndex, targetIndex, score: bestScore };
  });

  // Resolve same-target collisions by score: the higher-scoring bullet keeps the
  // match, the loser reverts to unmatched (stays anchored). Bail only on a true
  // tie — neither bullet is more confident than the other.
  const byTarget = new Map<number, MatchedUnit[]>();
  for (const unit of matched) {
    if (unit.targetIndex === null) continue;
    const list = byTarget.get(unit.targetIndex) ?? [];
    list.push(unit);
    byTarget.set(unit.targetIndex, list);
  }
  for (const units of byTarget.values()) {
    if (units.length <= 1) continue;
    units.sort((a, b) => b.score - a.score);
    const topScore = units[0].score;
    const tiedAtTop = units.filter((unit) => unit.score === topScore);
    if (tiedAtTop.length > 1) {
      return { units: run.units, collision: true, stats };
    }
    for (const loser of units.slice(1)) {
      loser.targetIndex = null;
    }
  }

  const sortedMatched = matched
    .filter((unit): unit is MatchedUnit & { targetIndex: number } => unit.targetIndex !== null)
    .sort((a, b) => a.targetIndex - b.targetIndex || a.originalIndex - b.originalIndex);
  let sortedIndex = 0;
  const units = matched.map((unit) => {
    if (unit.targetIndex === null) return unit.text;
    const sorted = sortedMatched[sortedIndex];
    sortedIndex += 1;
    return sorted.text;
  });

  return { units, collision: false, stats };
}

function serializeRun(units: string[], separators: string[]): string {
  return units.map((unit, index) => unit + separators[index]).join("");
}

function sameStringMultiset(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function warnAndBail(reportText: string, failedCheck: string, stats?: MatchStats): ReorderResult {
  console.warn(`[quick-report-reorder] safety check failed: ${failedCheck}`);
  return { text: reportText, reordered: false, ambiguous: true, stats };
}

export function reorderQuickReportBullets(
  reportText: string,
  typedFindingLines: string[],
  modality: string,
  region: string,
): ReorderResult {
  const parsed = parseReport(reportText);
  if (!parsed) return { text: reportText, reordered: false, ambiguous: true };

  // Score bullets against BOTH the raw typed text and the abbreviation expansion,
  // taking the union so the higher signal always wins. This handles cases where the
  // expansion produces a canned sentence that shares no tokens with a terse OPINION
  // bullet (e.g. "ACL sprain" expands to a long descriptive sentence, but the OPINION
  // bullet is literally "ACL sprain" — raw tokens "acl"+"sprain" still match it).
  const typedQueryWordSets = typedFindingLines.map((line) => {
    const rawTokens = tokenize(line);
    const expandedTokens = tokenize(expandForSegmentMatching(line, modality, region));
    return new Set([...rawTokens, ...expandedTokens]);
  });

  // Global across all typed findings (shared by both runs) — how many DIFFERENT
  // typed findings mention this word at all. Used by the single-word exception.
  const wordToFindingCount = new Map<string, number>();
  for (const queryWords of typedQueryWordSets) {
    for (const word of queryWords) {
      wordToFindingCount.set(word, (wordToFindingCount.get(word) ?? 0) + 1);
    }
  }

  const reorderedFindings = matchAndReorderRun(parsed.findings, typedQueryWordSets, wordToFindingCount);
  const reorderedOpinion = matchAndReorderRun(parsed.opinion, typedQueryWordSets, wordToFindingCount);
  const stats: MatchStats = {
    scoreThresholdMatches: reorderedFindings.stats.scoreThresholdMatches + reorderedOpinion.stats.scoreThresholdMatches,
    singleWordExceptionMatches: reorderedFindings.stats.singleWordExceptionMatches + reorderedOpinion.stats.singleWordExceptionMatches,
    rejectedWeakMatches: reorderedFindings.stats.rejectedWeakMatches + reorderedOpinion.stats.rejectedWeakMatches,
  };

  if (reorderedFindings.collision || reorderedOpinion.collision) {
    return { text: reportText, reordered: false, ambiguous: true, stats };
  }

  const candidate = parsed.findingsPrefix
    + serializeRun(reorderedFindings.units, parsed.findings.separators)
    + parsed.headerLine
    + serializeRun(reorderedOpinion.units, parsed.opinion.separators)
    + parsed.opinionSuffix;

  const verified = parseReport(candidate);
  if (!verified) return warnAndBail(reportText, "reordered report no longer parses", stats);
  if (!sameStringMultiset(parsed.findings.units, verified.findings.units)) {
    return warnAndBail(reportText, "FINDINGS unit multiset changed", stats);
  }
  if (!sameStringMultiset(parsed.opinion.units, verified.opinion.units)) {
    return warnAndBail(reportText, "OPINION unit multiset changed", stats);
  }
  if (parsed.findings.separators.join("\u0000") !== verified.findings.separators.join("\u0000")) {
    return warnAndBail(reportText, "FINDINGS unit separators changed", stats);
  }
  if (parsed.opinion.separators.join("\u0000") !== verified.opinion.separators.join("\u0000")) {
    return warnAndBail(reportText, "OPINION unit separators changed", stats);
  }
  if (parsed.findingsPrefix !== verified.findingsPrefix) {
    return warnAndBail(reportText, "content before FINDINGS run changed", stats);
  }
  if (parsed.headerLine !== verified.headerLine) {
    return warnAndBail(reportText, "OPINION header line changed", stats);
  }
  if (parsed.opinionSuffix !== verified.opinionSuffix) {
    return warnAndBail(reportText, "content after OPINION run changed", stats);
  }

  if (candidate === reportText) {
    return { text: reportText, reordered: false, ambiguous: false, stats };
  }
  return { text: candidate, reordered: true, ambiguous: false, stats };
}

