import { renderDocx } from "./docx.ts";
import { renderHtml, renderPlainText } from "./html.ts";
import { buildRenderModel } from "./model.ts";
import { resolveStyle } from "./styles.ts";
import { REPORT_MODES, type FormatReportRequest, type FormatReportResult } from "./types.ts";

export * from "./model.ts";
export * from "./parser.ts";
export * from "./styles.ts";
export * from "./types.ts";

export function validateFormatReportRequest(value: unknown): FormatReportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.report_text !== "string" || !body.report_text.trim()) {
    throw new Error("report_text must be a non-empty string.");
  }
  if (typeof body.report_mode !== "string" || !REPORT_MODES.some((mode) => mode === body.report_mode)) {
    throw new Error(`report_mode must be one of: ${REPORT_MODES.join(", ")}.`);
  }
  if (typeof body.style_id !== "string" || !body.style_id.trim()) {
    throw new Error("style_id must be a non-empty string.");
  }
  const allowedOutputs = ["html", "plain_text", "docx"] as const;
  if (body.outputs !== undefined && (
    !Array.isArray(body.outputs) ||
    body.outputs.length === 0 ||
    body.outputs.some((output) => !allowedOutputs.some((allowed) => allowed === output))
  )) {
    throw new Error("outputs must be a non-empty array containing html, plain_text, and/or docx.");
  }
  resolveStyle(body.style_id);
  return body as unknown as FormatReportRequest;
}

export async function formatReport(request: FormatReportRequest): Promise<FormatReportResult> {
  const style = resolveStyle(request.style_id);
  const model = buildRenderModel(request.report_text, request.report_mode, request.style_id);
  const outputs = request.outputs ?? ["html", "plain_text"];
  return {
    html: outputs.includes("html") ? renderHtml(model, style) : undefined,
    plain_text: outputs.includes("plain_text") ? renderPlainText(model) : undefined,
    docx: outputs.includes("docx") ? await renderDocx(model, style) : undefined,
    outline: model.blocks,
    report_family: model.reportFamily,
    style_path: model.stylePath,
    style_id: style.id,
  };
}
