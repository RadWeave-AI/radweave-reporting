import type { ParsedLine, ParsedReport, ReportFamily } from "./types.ts";

function stripOuterBold(value: string): string {
  return value.trim().replace(/^\*\*(.+)\*\*$/, "$1").trim();
}

function isSeparatorLine(value: string): boolean {
  return /^[-—─]{3,}$/.test(value.trim());
}

function isMriTitleLine(value: string): boolean {
  const u = value.toUpperCase();
  return (
    u.startsWith("MRI OF THE") || u.startsWith("MRI OF ") ||
    u.startsWith("MRI RIGHT") || u.startsWith("MRI LEFT") ||
    u.startsWith("MRI BOTH") || u.startsWith("HIGH FIELD") ||
    u.startsWith("OPEN (") || u.startsWith("EXTREMITY (") ||
    u.startsWith("DYNAMIC MRI") || u.startsWith("MR SPECTROSCOPY") ||
    u.startsWith("LIMITED MRI") || u.startsWith("PET CT") ||
    u.startsWith("PET-CT") || u.startsWith("MRCP") ||
    u === "MRA" || u.startsWith("MRA ") || u === "MRV" || u.startsWith("MRV ")
  );
}

function isCtTitleLine(value: string): boolean {
  const lower = value.toLowerCase();
  const upper = value.toUpperCase();
  return (
    lower.endsWith("revealed:") || lower.includes("multislice") ||
    lower.startsWith("ct scan of") || lower.startsWith("post contrast ct") ||
    lower.startsWith("non-contrast ct") || lower.startsWith("non contrast ct") ||
    lower.startsWith("plain ct") || upper.startsWith("CLINICAL INDICATION:") ||
    upper.startsWith("MDCT") || upper.startsWith("X-RAY") ||
    upper.startsWith("XRAY") || upper.startsWith("RADIOGRAPH") ||
    upper.startsWith("ULTRASOUND") || upper.startsWith("US ") ||
    upper.startsWith("FLUOROSCOPY") || upper.startsWith("NUCLEAR MEDICINE")
  );
}

function isAllCapsSection(value: string): boolean {
  const s = value.trim();
  if (s.length < 3 || !s.endsWith(":")) return false;
  const body = s.slice(0, -1).trim();
  return body.length > 0 && body === body.toUpperCase() && /[A-Z]/.test(body);
}

function isRomanNumeralSection(value: string): boolean {
  return /^[IVX]+\.\s+.+:$/.test(value.trim());
}

function detectReportFamily(rawLines: string[]): ReportFamily {
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const stripped = stripOuterBold(trimmed);
    if (isMriTitleLine(stripped)) return "MRI";
    if (isCtTitleLine(stripped)) return "CT";
    break;
  }
  return "CT";
}

/**
 * Shared, rendering-independent classifier. Header detection starts from the
 * website's newest report-format-parser implementation. In particular, CT
 * titles use anchored checks rather than the older renderer's loose prose
 * substring match; that is an intentional anti-regression behavior change.
 */
export function parseReport(reportText: string): ParsedReport {
  const rawLines = reportText.replace(/\r\n/g, "\n").split("\n");
  const reportFamily = detectReportFamily(rawLines);
  const lines: ParsedLine[] = [];
  let mriTitleCount = 0;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      lines.push({ kind: "blank", raw, text: "", mriTitleIndex: -1 });
      continue;
    }
    if (isSeparatorLine(trimmed)) {
      lines.push({ kind: "separator", raw, text: "", mriTitleIndex: -1 });
      continue;
    }

    const stripped = stripOuterBold(trimmed);
    const headerKey = stripped.replace(/:$/, "").trim().toUpperCase();
    if (["TECHNIQUE", "MR TECHNIQUE", "MRI TECHNIQUE"].includes(headerKey)) {
      lines.push({ kind: "techniqueHeader", raw, text: headerKey, mriTitleIndex: -1 });
    } else if (["FINDINGS", "MR FINDINGS", "MRI FINDINGS", "MRA FINDINGS", "MRS FINDINGS"].includes(headerKey)) {
      lines.push({ kind: "findingsHeader", raw, text: headerKey, mriTitleIndex: -1 });
    } else if (["OPINION", "IMPRESSION", "CONCLUSION"].includes(headerKey)) {
      lines.push({ kind: "opinionHeader", raw, text: headerKey, mriTitleIndex: -1 });
    } else if (isRomanNumeralSection(stripped) || isAllCapsSection(stripped)) {
      lines.push({ kind: "sectionHeader", raw, text: stripped.replace(/:$/, "").trim(), mriTitleIndex: -1 });
    } else if (isMriTitleLine(stripped)) {
      lines.push({ kind: "mriTitle", raw, text: stripped.toUpperCase(), mriTitleIndex: mriTitleCount++ });
    } else if (isCtTitleLine(stripped)) {
      lines.push({ kind: "ctTitle", raw, text: stripped, mriTitleIndex: -1 });
    } else if (trimmed.startsWith("• ")) {
      lines.push({ kind: "bullet0", raw, text: trimmed.slice(2).trim(), mriTitleIndex: -1 });
    } else if (trimmed.startsWith("- ")) {
      lines.push({ kind: "bullet1", raw, text: trimmed.slice(2).trim(), mriTitleIndex: -1 });
    } else {
      const oMatch = trimmed.match(/^o(?:\s+|\t+)(.+)$/i);
      lines.push(oMatch
        ? { kind: "bullet2", raw, text: oMatch[1].trim(), mriTitleIndex: -1 }
        : { kind: "paragraph", raw, text: trimmed, mriTitleIndex: -1 });
    }
  }

  return { reportFamily, lines };
}
