import { parseAbbreviations } from "../ai/abbreviation-parser.ts";

export interface Segment {
  text: string;
  anatomyWords: string[];
}

type SegmentSection = "findings" | "opinion";
type HeaderSection = SegmentSection | "other";

const HEADER_PREFIXES: Array<{ prefix: string; section: HeaderSection }> = [
  { prefix: "MR FINDINGS:", section: "findings" },
  { prefix: "FINDINGS:", section: "findings" },
  { prefix: "MR TECHNIQUE:", section: "other" },
  { prefix: "TECHNIQUE:", section: "other" },
  { prefix: "OPINION:", section: "opinion" },
  { prefix: "IMPRESSION:", section: "opinion" },
  { prefix: "CONCLUSION:", section: "opinion" },
];

const ANATOMY_STOP_WORDS = new Set([
  "with", "shows", "shown", "seen", "normal", "mild", "moderate", "severe",
  "evidence", "noted", "showing", "appears", "there", "these", "signal",
  "signals", "finding", "findings", "without", "within", "from", "that",
  "this", "have", "has", "were", "been", "into", "upon", "along", "related",
  "associated", "change", "changes", "intact", "small", "large", "appearance",
]);

const MATCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were",
  "has", "have", "had", "not", "but", "into", "onto", "than", "then", "there",
  "these", "seen", "shows", "showing", "noted", "appears", "normal", "mild",
  "moderate", "severe", "evidence", "signal",
]);

export function expandForSegmentMatching(findingLine: string, modality: string, region: string): string {
  const result = parseAbbreviations(findingLine, modality, region);
  return result.findings
    .filter((f) => !f.isOpinion)
    .map((f) => f.expanded)
    .join(" ");
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function classifyHeader(line: string): HeaderSection | null {
  const upper = line.trim().toUpperCase();
  return HEADER_PREFIXES.find(({ prefix }) => upper.startsWith(prefix))?.section ?? null;
}

function anatomyWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return Array.from(new Set(words.filter(
    (word) => word.length >= 4 && !ANATOMY_STOP_WORDS.has(word),
  )));
}

function toSegment(lines: string[]): Segment | null {
  const text = lines.join("\n").trim();
  return text ? { text, anatomyWords: anatomyWords(text) } : null;
}

function splitSection(sectionText: string): Segment[] {
  const isTopLevelBullet = (line: string) => /^[•\uF0B7]/.test(line.trim());
  const isSubBullet = (line: string) => /^-/.test(line.trim()) || /^o\s+/.test(line.trim());
  const lines = sectionText.split("\n");
  const hasBulletMarker = lines.some(
    (line) => isTopLevelBullet(line) || isSubBullet(line),
  );

  if (!hasBulletMarker) {
    return sectionText
      .split(/\n\s*\n+/)
      .map((paragraph) => toSegment([paragraph]))
      .filter((segment): segment is Segment => segment !== null);
  }

  const segments: Segment[] = [];
  let currentLines: string[] = [];
  let currentHasTopLevelBullet = false;

  const flushCurrent = () => {
    const segment = toSegment(currentLines);
    if (segment) segments.push(segment);
    currentLines = [];
    currentHasTopLevelBullet = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isTopLevelBullet(trimmed)) {
      flushCurrent();
      currentLines = [trimmed];
      currentHasTopLevelBullet = true;
      continue;
    }

    if (isSubBullet(trimmed)) {
      if (!currentHasTopLevelBullet) flushCurrent();
      currentLines.push(trimmed);
      continue;
    }

    currentLines.push(trimmed);
  }

  flushCurrent();
  return segments;
}

function sectionBlocks(text: string, section: SegmentSection): string[] {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");
  const headers = lines.map(classifyHeader);
  const hasClinicalHeader = headers.some(
    (header) => header === "findings" || header === "opinion",
  );

  if (!hasClinicalHeader) {
    const blocks: string[] = [];
    let current: string[] = [];
    lines.forEach((line, index) => {
      if (headers[index]) {
        blocks.push(current.join("\n"));
        current = [];
      } else {
        current.push(line);
      }
    });
    blocks.push(current.join("\n"));
    return blocks;
  }

  const blocks: string[] = [];
  let current: string[] | null = null;

  const flushCurrent = () => {
    if (current !== null) blocks.push(current.join("\n"));
    current = null;
  };

  lines.forEach((line, index) => {
    const header = headers[index];
    if (header) {
      flushCurrent();
      if (header === section) current = [];
      return;
    }
    if (current !== null) current.push(line);
  });
  flushCurrent();

  return blocks;
}

export function extractSegments(text: string, section: SegmentSection): Segment[] {
  if (!text.trim()) return [];
  return sectionBlocks(text, section).flatMap(splitSection);
}

export function pairOpinion(
  findingSegment: Segment,
  opinionSegments: Segment[],
): Segment | null {
  const findingWords = new Set(findingSegment.anatomyWords);
  let best: Segment | null = null;
  let bestScore = 0;

  for (const opinionSegment of opinionSegments) {
    const score = opinionSegment.anatomyWords.reduce(
      (shared, word) => shared + (findingWords.has(word) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = opinionSegment;
      bestScore = score;
    }
  }

  return best;
}

function findingWords(findingLine: string): string[] {
  const words = findingLine.toLowerCase().match(/[a-z]+/g) ?? [];
  return Array.from(new Set(words.filter(
    (word) => word.length >= 3 && !MATCH_STOP_WORDS.has(word),
  )));
}

export function selectSegmentForFinding(
  findingLine: string,
  cleanedFindingsText: string,
  cleanedOpinionText: string,
  cleanedFullText: string,
): { findings: string; opinion: string | null } | null {
  if (!cleanedFindingsText.trim() && !cleanedFullText.trim()) return null;

  let findingSegments = extractSegments(cleanedFindingsText, "findings");
  let opinionSegments = extractSegments(cleanedOpinionText, "opinion");

  if (findingSegments.length === 0) {
    findingSegments = extractSegments(cleanedFullText, "findings");
    opinionSegments = extractSegments(cleanedFullText, "opinion");
  }

  const queryWords = findingWords(findingLine);
  let winningSegment: Segment | null = null;
  let bestScore = 0;

  for (const segment of findingSegments) {
    const lowerSegment = segment.text.toLowerCase();
    const score = queryWords.reduce(
      (matches, word) => matches + (lowerSegment.includes(word) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      winningSegment = segment;
      bestScore = score;
    }
  }

  if (!winningSegment || bestScore === 0) {
    return {
      findings: cleanedFindingsText,
      opinion: cleanedOpinionText.trim() ? cleanedOpinionText : null,
    };
  }

  return {
    findings: winningSegment.text,
    opinion: pairOpinion(winningSegment, opinionSegments)?.text ?? null,
  };
}

