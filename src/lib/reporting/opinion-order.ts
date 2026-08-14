function normalizeOpinionLine(line: string) {
  return line
    .replace(/^\s*[-•]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function normalizedOpinionKey(line: string) {
  return line.toLowerCase().replace(/[.\s]+$/g, "");
}

/**
 * Keeps selected pathology opinions first, preserves unmatched AI opinions
 * next, and places deterministic residual normal opinions last.
 */
export function enforceOpinionOrder(
  report: string,
  opinionHints: string,
  residualOpinionHints = ""
) {
  // Preserve the established behavior byte-for-byte when no residual bucket is supplied.
  if (!residualOpinionHints.trim()) {
    const ordered = opinionHints
      .split("\n")
      .map(normalizeOpinionLine)
      .filter(Boolean);
    if (!ordered.length) return report;

    const pattern = /(OPINION:\s*)([\s\S]*)$/i;
    const match = report.match(pattern);
    if (!match) return report;

    const existing = match[2]
      .split("\n")
      .map(normalizeOpinionLine)
      .filter(Boolean);
    const orderedKeys = new Set(ordered.map((line) => line.toLowerCase().replace(/[.\s]+$/g, "")));
    const remaining = existing.filter((line) =>
      !orderedKeys.has(line.toLowerCase().replace(/[.\s]+$/g, ""))
    );
    const opinion = [...ordered, ...remaining].map((line) => `- **${line}**`).join("\n");
    return report.replace(pattern, `$1\n${opinion}`);
  }

  const ordered = opinionHints
    .split("\n")
    .map(normalizeOpinionLine)
    .filter(Boolean);
  const residuals = residualOpinionHints
    .split("\n")
    .map(normalizeOpinionLine)
    .filter(Boolean);
  const pattern = /(OPINION:\s*)([\s\S]*)$/i;
  const match = report.match(pattern);
  if (!match) return report;

  const existing = match[2]
    .split("\n")
    .map(normalizeOpinionLine)
    .filter(Boolean);
  const nonAiKeys = new Set([...ordered, ...residuals].map(normalizedOpinionKey));
  const remaining = existing.filter((line) => !nonAiKeys.has(normalizedOpinionKey(line)));
  const opinion = [...ordered, ...remaining, ...residuals]
    .map((line) => `- **${line}**`)
    .join("\n");
  return report.replace(pattern, `$1\n${opinion}`);
}

