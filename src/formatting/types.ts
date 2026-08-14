export const REPORT_MODES = [
  "quick",
  "checklist",
  "comparison",
  "my-template",
  "template-guided",
] as const;

export type ReportMode = (typeof REPORT_MODES)[number];
export type StylePath = "standard" | "comparison";
export type ReportFamily = "MRI" | "CT";
export type TextAlignment = "left" | "center" | "justify";
export type ParsedLineKind =
  | "blank"
  | "separator"
  | "mriTitle"
  | "ctTitle"
  | "techniqueHeader"
  | "findingsHeader"
  | "opinionHeader"
  | "sectionHeader"
  | "bullet0"
  | "bullet1"
  | "bullet2"
  | "paragraph";

export interface ParsedLine {
  kind: ParsedLineKind;
  raw: string;
  text: string;
  mriTitleIndex: number;
}

export interface ParsedReport {
  reportFamily: ReportFamily;
  lines: ParsedLine[];
}

export type RenderBlockKind = "title" | "section" | "paragraph" | "bullet";

export interface RenderBlock {
  kind: RenderBlockKind;
  text: string;
  alignment: TextAlignment;
  bold: boolean;
  underline: boolean;
  uppercase: boolean;
  level?: 0 | 1 | 2;
  marker?: "•" | "-" | "o";
  sourceKind: ParsedLineKind;
}

export interface RenderModel {
  reportMode: ReportMode;
  stylePath: StylePath;
  styleId: string;
  reportFamily: ReportFamily;
  blocks: RenderBlock[];
}

export interface ReportStyle {
  id: string;
  fontFamily: string;
  fontSizePt: number;
  lineSpacing: number;
  paragraphSpacingBeforePt: number;
  paragraphSpacingAfterPt: number;
  marginsInches: { top: number; right: number; bottom: number; left: number };
  sectionHeadings: { bold: boolean; underline: boolean; uppercase: boolean };
  standardBullet: { marker: "•"; indentInches: number; hangingInches: number };
  comparisonBullets: Array<{
    level: 0 | 1 | 2;
    marker: "•" | "-" | "o";
    indentInches: number;
    hangingInches: number;
  }>;
}

export interface FormatReportRequest {
  report_text: string;
  report_mode: ReportMode;
  style_id: string;
  outputs?: Array<"html" | "plain_text" | "docx">;
}

export interface FormatReportResult {
  html?: string;
  plain_text?: string;
  docx?: Buffer;
  outline: RenderBlock[];
  report_family: ReportFamily;
  style_path: StylePath;
  style_id: string;
}
