export interface StrictStyleRequirements {
  findings: string[];
  opinions: string[];
  unknownTokens: string[];
}

export interface StrictStyleValidation {
  passed: boolean;
  missingFindings: string[];
  missingOpinions: string[];
  unknownTokens: string[];
  issues: string[];
}

function cleanPhrase(value: string): string {
  return value
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .trim();
}

function comparable(value: string): string {
  return cleanPhrase(value)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function extractStrictStyleRequirements(parsedEdits?: string): StrictStyleRequirements {
  const requirements: StrictStyleRequirements = {
    findings: [],
    opinions: [],
    unknownTokens: [],
  };
  if (!parsedEdits?.trim()) return requirements;

  let section: "findings" | "opinions" | "other" = "other";
  for (const rawLine of parsedEdits.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^STRUCTURED FINDINGS/i.test(line)) {
      section = "findings";
      continue;
    }
    if (/^OPINION POINTS/i.test(line)) {
      section = "opinions";
      continue;
    }
    if (/^[A-Z][A-Z ]+(?:\(|:)/.test(line) || /^ADDITIONAL FINDINGS/i.test(line)) {
      section = "other";
    }

    const unknownMatch = line.match(/\[Unrecognised tokens:\s*(.*?)\]/i);
    if (unknownMatch) {
      requirements.unknownTokens.push(
        ...unknownMatch[1].split(",").map((token) => token.trim()).filter(Boolean)
      );
      continue;
    }

    if (!/^[-*•]\s+/.test(line)) continue;
    const phrase = cleanPhrase(line);
    if (!phrase) continue;
    if (section === "findings") requirements.findings.push(phrase);
    if (section === "opinions") requirements.opinions.push(phrase);
  }

  requirements.findings = Array.from(new Set(requirements.findings));
  requirements.opinions = Array.from(new Set(requirements.opinions));
  requirements.unknownTokens = Array.from(new Set(requirements.unknownTokens));
  return requirements;
}

export function validateStrictStyle(
  report: string,
  requirements: StrictStyleRequirements
): StrictStyleValidation {
  const normalizedReport = comparable(report);
  const missingFindings = requirements.findings.filter(
    (phrase) => !normalizedReport.includes(comparable(phrase))
  );
  const missingOpinions = requirements.opinions.filter(
    (phrase) => !normalizedReport.includes(comparable(phrase))
  );
  const issues: string[] = [];

  if (missingFindings.length) {
    issues.push(`${missingFindings.length} curated finding phrase${missingFindings.length === 1 ? "" : "s"} missing or rephrased.`);
  }
  if (missingOpinions.length) {
    issues.push(`${missingOpinions.length} curated opinion phrase${missingOpinions.length === 1 ? "" : "s"} missing or rephrased.`);
  }
  if (requirements.unknownTokens.length) {
    issues.push(`Manual review required for: ${requirements.unknownTokens.join(", ")}.`);
  }

  return {
    passed: missingFindings.length === 0 && missingOpinions.length === 0 && requirements.unknownTokens.length === 0,
    missingFindings,
    missingOpinions,
    unknownTokens: requirements.unknownTokens,
    issues,
  };
}

function insertBeforeOpinion(report: string, phrases: string[]): string {
  if (!phrases.length) return report;
  const block = phrases.map((phrase) => `• ${phrase}`).join("\n");
  const opinionMatch = report.match(/\n\s*OPINION\s*:/i);
  if (!opinionMatch?.index) return `${report.trimEnd()}\n\nMRI FINDINGS:\n${block}`;
  return `${report.slice(0, opinionMatch.index).trimEnd()}\n${block}\n${report.slice(opinionMatch.index)}`;
}

function insertIntoOpinion(report: string, phrases: string[]): string {
  if (!phrases.length) return report;
  const block = phrases.map((phrase) => `• ${phrase}`).join("\n");
  const opinionMatch = report.match(/(\n\s*OPINION\s*:\s*\n?)/i);
  if (!opinionMatch?.index) return `${report.trimEnd()}\n\nOPINION:\n${block}`;
  const insertionAt = opinionMatch.index + opinionMatch[0].length;
  return `${report.slice(0, insertionAt)}${block}\n${report.slice(insertionAt)}`;
}

export function enforceStrictStyle(
  report: string,
  requirements: StrictStyleRequirements
): string {
  const validation = validateStrictStyle(report, requirements);
  let enforced = insertBeforeOpinion(report, validation.missingFindings);
  enforced = insertIntoOpinion(enforced, validation.missingOpinions);
  return enforced;
}

export function buildStrictCorrectionPrompt(
  report: string,
  requirements: StrictStyleRequirements,
  validation: StrictStyleValidation
): string {
  return [
    "Correct the radiology report below.",
    "Return only the complete corrected report.",
    "Preserve its headings and overall consultant style.",
    "Every protected phrase below must appear verbatim, with no paraphrasing.",
    "Remove statements that directly contradict a protected phrase.",
    "Do not introduce any new diagnosis, severity, location, or certainty.",
    "",
    "PROTECTED FINDING PHRASES:",
    ...requirements.findings.map((phrase) => `- ${phrase}`),
    "",
    "PROTECTED OPINION PHRASES:",
    ...requirements.opinions.map((phrase) => `- ${phrase}`),
    "",
    "VALIDATION ISSUES:",
    ...validation.issues.map((issue) => `- ${issue}`),
    "",
    "REPORT TO CORRECT:",
    report,
  ].join("\n");
}

