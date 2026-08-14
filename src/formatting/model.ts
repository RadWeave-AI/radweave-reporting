import { parseReport } from "./parser.ts";
import type {
  ParsedLine,
  RenderBlock,
  RenderModel,
  ReportMode,
  StylePath,
} from "./types.ts";

export function stylePathForMode(reportMode: ReportMode): StylePath {
  return reportMode === "comparison" ? "comparison" : "standard";
}

function splitReportSentences(value: string): string[] {
  return value
    .trim()
    .split(/(?<=[.!?])\s+(?=(?:[A-Z]|\*\*[A-Z]))/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sectionBlock(line: ParsedLine): RenderBlock {
  return {
    kind: "section",
    text: line.text,
    alignment: "left",
    bold: true,
    underline: true,
    uppercase: true,
    sourceKind: line.kind,
  };
}

function bulletLevel(line: ParsedLine, stylePath: StylePath): 0 | 1 | 2 {
  if (stylePath === "standard") return 0;
  if (line.kind === "bullet1") return 1;
  if (line.kind === "bullet2") return 2;
  return 0;
}

function bulletMarker(level: 0 | 1 | 2, stylePath: StylePath): "•" | "-" | "o" {
  if (stylePath === "standard" || level === 0) return "•";
  return level === 1 ? "-" : "o";
}

export function buildRenderModel(
  reportText: string,
  reportMode: ReportMode,
  styleId: string,
): RenderModel {
  const parsed = parseReport(reportText);
  const stylePath = stylePathForMode(reportMode);
  const blocks: RenderBlock[] = [];
  let currentSection: "findings" | "opinion" | "other" | null = null;

  for (const line of parsed.lines) {
    if (line.kind === "blank" || line.kind === "separator") continue;

    if (line.kind === "mriTitle") {
      currentSection = null;
      blocks.push({
        kind: "title",
        text: line.text,
        alignment: line.mriTitleIndex < 2 ? "center" : "left",
        bold: true,
        underline: true,
        uppercase: true,
        sourceKind: line.kind,
      });
      continue;
    }
    if (line.kind === "ctTitle") {
      currentSection = null;
      blocks.push({
        kind: "title",
        text: line.text,
        alignment: "justify",
        bold: true,
        underline: true,
        uppercase: false,
        sourceKind: line.kind,
      });
      continue;
    }
    if (line.kind === "findingsHeader") {
      currentSection = "findings";
      blocks.push(sectionBlock(line));
      continue;
    }
    if (line.kind === "opinionHeader") {
      currentSection = "opinion";
      blocks.push(sectionBlock(line));
      continue;
    }
    if (line.kind === "techniqueHeader" || line.kind === "sectionHeader") {
      currentSection = "other";
      blocks.push(sectionBlock(line));
      continue;
    }
    if (line.kind === "bullet0" || line.kind === "bullet1" || line.kind === "bullet2") {
      const level = bulletLevel(line, stylePath);
      blocks.push({
        kind: "bullet",
        text: line.text,
        alignment: "justify",
        bold: false,
        underline: false,
        uppercase: false,
        level,
        marker: bulletMarker(level, stylePath),
        sourceKind: line.kind,
      });
      continue;
    }

    if (currentSection === "findings" || currentSection === "opinion") {
      for (const sentence of splitReportSentences(line.text)) {
        blocks.push({
          kind: "bullet",
          text: sentence,
          alignment: "justify",
          bold: false,
          underline: false,
          uppercase: false,
          level: 0,
          marker: "•",
          sourceKind: line.kind,
        });
      }
      continue;
    }

    blocks.push({
      kind: "paragraph",
      text: line.text,
      alignment: parsed.reportFamily === "MRI" ? "left" : "justify",
      bold: false,
      underline: false,
      uppercase: false,
      sourceKind: line.kind,
    });
  }

  return { reportMode, stylePath, styleId, reportFamily: parsed.reportFamily, blocks };
}
