import { parseReport } from "./parser.ts";
import type {
  ParsedLine,
  RenderBlock,
  RenderModel,
  ReportMode,
  ReportStyle,
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

function sectionBlock(line: ParsedLine, style: ReportStyle): RenderBlock {
  return {
    kind: "section",
    text: line.text,
    alignment: "left",
    bold: style.sectionHeadings.bold,
    underline: style.sectionHeadings.underline,
    uppercase: style.sectionHeadings.uppercase,
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
  style: ReportStyle,
): RenderModel {
  const parsed = parseReport(reportText);
  const stylePath = stylePathForMode(reportMode);
  const blocks: RenderBlock[] = [];
  let currentSection: "technique" | "findings" | "opinion" | "other" | null = null;

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
      blocks.push(sectionBlock(line, style));
      continue;
    }
    if (line.kind === "opinionHeader") {
      currentSection = "opinion";
      blocks.push(sectionBlock(line, style));
      continue;
    }
    if (line.kind === "techniqueHeader") {
      currentSection = "technique";
      blocks.push(sectionBlock(line, style));
      continue;
    }
    if (line.kind === "sectionHeader") {
      currentSection = "other";
      blocks.push(sectionBlock(line, style));
      continue;
    }
    if (line.kind === "bullet0" || line.kind === "bullet1" || line.kind === "bullet2") {
      const level = bulletLevel(line, stylePath);
      const isMriTechnique = currentSection === "technique" && parsed.reportFamily === "MRI";
      const isStandardFindings = currentSection === "findings" && stylePath === "standard";
      const sectionRule = currentSection === "findings"
        ? style.sectionContent.findings
        : currentSection === "opinion"
          ? style.sectionContent.opinion
          : null;
      blocks.push({
        kind: "bullet",
        text: line.text,
        alignment: sectionRule?.alignment ?? "justify",
        bold: isMriTechnique
          ? style.sectionContent.mriTechnique.bold
          : sectionRule?.bulletBold ?? false,
        allowInlineBold: !isStandardFindings,
        underline: false,
        uppercase: false,
        fontSizePt: isMriTechnique ? style.sectionContent.mriTechnique.fontSizePt : undefined,
        level,
        marker: bulletMarker(level, stylePath),
        sourceKind: line.kind,
      });
      continue;
    }

    if (currentSection === "findings" || currentSection === "opinion") {
      const sectionRule = style.sectionContent[currentSection];
      const isStandardFindings = currentSection === "findings" && stylePath === "standard";
      for (const sentence of splitReportSentences(line.text)) {
        blocks.push({
          kind: "bullet",
          text: sentence,
          alignment: sectionRule.alignment,
          bold: sectionRule.bulletBold,
          allowInlineBold: !isStandardFindings,
          underline: false,
          uppercase: false,
          level: 0,
          marker: "•",
          sourceKind: line.kind,
        });
      }
      continue;
    }

    const isMriTechnique = currentSection === "technique" && parsed.reportFamily === "MRI";
    blocks.push({
      kind: "paragraph",
      text: line.text,
      alignment: parsed.reportFamily === "MRI" ? "left" : "justify",
      bold: isMriTechnique ? style.sectionContent.mriTechnique.bold : false,
      underline: false,
      uppercase: false,
      fontSizePt: isMriTechnique ? style.sectionContent.mriTechnique.fontSizePt : undefined,
      sourceKind: line.kind,
    });
  }

  return { reportMode, stylePath, styleId: style.id, reportFamily: parsed.reportFamily, blocks };
}
