import {
  AlignmentType,
  Document,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
  UnderlineType,
  convertInchesToTwip,
} from "docx";

import type { RenderBlock, RenderModel, ReportStyle, TextAlignment } from "./types.ts";

const BULLET_REFERENCE = "radweave-report-bullets";

function alignment(value: TextAlignment): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (value === "center") return AlignmentType.CENTER;
  if (value === "justify") return AlignmentType.BOTH;
  return AlignmentType.LEFT;
}

function runs(block: RenderBlock, style: ReportStyle): TextRun[] {
  const value = block.uppercase ? block.text.toUpperCase() : block.text;
  const result: TextRun[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const add = (text: string, bold: boolean) => result.push(new TextRun({
    text,
    font: style.fontFamily,
    size: style.fontSizePt * 2,
    bold,
    underline: block.underline ? { type: UnderlineType.SINGLE } : undefined,
    rightToLeft: false,
  }));

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) add(value.slice(lastIndex, match.index), block.bold);
    add(match[1], true);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < value.length || result.length === 0) add(value.slice(lastIndex), block.bold);
  return result;
}

function paragraph(block: RenderBlock, style: ReportStyle): Paragraph {
  return new Paragraph({
    alignment: alignment(block.alignment),
    bidirectional: false,
    spacing: {
      line: Math.round(240 * style.lineSpacing),
      lineRule: LineRuleType.AUTO,
      before: Math.round(style.paragraphSpacingBeforePt * 20),
      after: Math.round(style.paragraphSpacingAfterPt * 20),
    },
    numbering: block.kind === "bullet"
      ? { reference: BULLET_REFERENCE, level: block.level ?? 0 }
      : undefined,
    children: runs(block, style),
  });
}

export async function renderDocx(model: RenderModel, style: ReportStyle): Promise<Buffer> {
  const levels = (model.stylePath === "comparison"
    ? style.comparisonBullets
    : [{ level: 0 as const, ...style.standardBullet }]
  ).map((bullet) => ({
    level: bullet.level,
    format: LevelFormat.BULLET,
    text: bullet.marker,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: {
          left: convertInchesToTwip(bullet.indentInches),
          hanging: convertInchesToTwip(bullet.hangingInches),
        },
      },
      run: { font: "Arial", size: style.fontSizePt * 2 },
    },
  }));

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: style.fontFamily, size: style.fontSizePt * 2 },
          paragraph: {
            spacing: {
              line: Math.round(240 * style.lineSpacing),
              lineRule: LineRuleType.AUTO,
              before: Math.round(style.paragraphSpacingBeforePt * 20),
              after: Math.round(style.paragraphSpacingAfterPt * 20),
            },
          },
        },
      },
    },
    numbering: { config: [{ reference: BULLET_REFERENCE, levels }] },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(style.marginsInches.top),
            right: convertInchesToTwip(style.marginsInches.right),
            bottom: convertInchesToTwip(style.marginsInches.bottom),
            left: convertInchesToTwip(style.marginsInches.left),
          },
        },
      },
      children: model.blocks.map((block) => paragraph(block, style)),
    }],
  });
  return Packer.toBuffer(document);
}
