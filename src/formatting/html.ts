import type { RenderBlock, RenderModel, ReportStyle } from "./types.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(value: string): string {
  const parts: string[] = [];
  const pattern = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    parts.push(escapeHtml(value.slice(lastIndex, match.index)));
    parts.push(`<strong>${escapeHtml(match[1])}</strong>`);
    lastIndex = pattern.lastIndex;
  }
  parts.push(escapeHtml(value.slice(lastIndex)));
  return parts.join("");
}

function blockText(block: RenderBlock): string {
  const text = block.uppercase ? block.text.toUpperCase() : block.text;
  if (block.allowInlineBold === false) return escapeHtml(text.replace(/\*\*(.*?)\*\*/g, "$1"));
  return renderInlineMarkdown(text);
}

function blockStyle(block: RenderBlock, style: ReportStyle): string {
  const declarations = [
    `font-family:${style.fontFamily}, Arial, sans-serif`,
    `font-size:${block.fontSizePt ?? style.fontSizePt}pt`,
    `line-height:${style.lineSpacing}`,
    `margin-top:${style.paragraphSpacingBeforePt}pt`,
    `margin-bottom:${style.paragraphSpacingAfterPt}pt`,
    `text-align:${block.alignment}`,
    "direction:ltr",
    "unicode-bidi:embed",
  ];
  if (block.bold) declarations.push("font-weight:700");
  if (block.underline) declarations.push("text-decoration:underline");
  if (block.kind === "bullet") {
    const indent = block.level === 2 ? 54 : block.level === 1 ? 36 : 18;
    declarations.push(`margin-left:${indent}pt`, "padding-left:0");
  }
  return declarations.join(";");
}

export function renderHtml(model: RenderModel, style: ReportStyle): string {
  const body = model.blocks.map((block) => {
    const content = block.kind === "bullet"
      ? `${escapeHtml(block.marker ?? "•")} ${blockText(block)}`
      : blockText(block);
    return `<div data-kind="${block.kind}"${block.level === undefined ? "" : ` data-level="${block.level}"`} style="${blockStyle(block, style)}">${content}</div>`;
  }).join("");
  return `<div data-style-id="${escapeHtml(style.id)}" data-style-path="${model.stylePath}" dir="ltr">${body}</div>`;
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*(.*?)\*\*/g, "$1");
}

export function renderPlainText(model: RenderModel): string {
  return model.blocks.map((block) => {
    const text = stripMarkdown(block.uppercase ? block.text.toUpperCase() : block.text);
    if (block.kind !== "bullet") return text;
    const indent = "  ".repeat(block.level ?? 0);
    return `${indent}${block.marker ?? "•"} ${text}`;
  }).join("\n");
}
