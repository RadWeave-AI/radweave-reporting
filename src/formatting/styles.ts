import type { ReportStyle } from "./types.ts";

// Style decisions live in data so additional presets can be introduced without
// changing parsing or rendering code. This preset intentionally reproduces the
// website's current DOCX output.
export const REPORT_STYLES: Readonly<Record<string, ReportStyle>> = {
  default: {
    id: "default",
    fontFamily: "Tahoma",
    fontSizePt: 14,
    lineSpacing: 1.15,
    paragraphSpacingBeforePt: 0,
    paragraphSpacingAfterPt: 0,
    marginsInches: { top: 1, right: 1, bottom: 1, left: 1 },
    sectionHeadings: { bold: true, underline: true, uppercase: true },
    standardBullet: { marker: "•", indentInches: 0.25, hangingInches: 0.25 },
    comparisonBullets: [
      { level: 0, marker: "•", indentInches: 0.25, hangingInches: 0.25 },
      { level: 1, marker: "-", indentInches: 0.5, hangingInches: 0.25 },
      { level: 2, marker: "o", indentInches: 0.75, hangingInches: 0.25 },
    ],
  },
};

export function resolveStyle(styleId: string): ReportStyle {
  const style = REPORT_STYLES[styleId];
  if (!style) throw new Error(`Unknown report style: ${styleId}`);
  return style;
}
