/**
 * Shared reporting kernel.
 *
 * Workflow-agnostic server-side primitives used by all five reporting
 * workflows (Checklist, Comparison, Quick Report, My Template,
 * Template-guided) and by both report routes: env/client factories, prompt
 * cache-block formatting, the per-user report rate limit, clinical-text
 * pre-processing, and the allowed-model list.
 *
 * Nothing here is workflow-specific, and nothing here imports a workflow
 * module — this is the layer intended to move into the standalone RadWeave
 * Reporting service first. Checklist/auto-match orchestration lives in its
 * sibling lib/reporting/checklist-generation.ts.
 *
 * Split out of lib/reporting/generation-engine.ts, which had a dual role
 * (Checklist workflow + shared kernel). The function bodies below are
 * unchanged from that file.
 *
 * PHI / governance: nothing in this module logs request bodies or clinical
 * text.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

import { getServiceConfig } from "@/config";
// ── Shared env / client factories ───────────────────────────────────────────
// Identical to the private helpers route.ts used to define locally; moved
// here so both routes call the same implementation.

export function getSupabaseService(): SupabaseClient {
  const { supabaseUrl, supabaseServiceRoleKey } = getServiceConfig();

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

export function getAnthropic(): Anthropic {
  return new Anthropic({ apiKey: getServiceConfig().anthropicApiKey });
}

/** Builds the `system` param as one or two cache_control blocks. */
export function buildCachedSystemBlocks(systemText: string, staticInstructions?: string) {
  const blocks = [
    { type: "text" as const, text: systemText, cache_control: { type: "ephemeral" as const } },
  ];
  if (staticInstructions) {
    blocks.push({ type: "text" as const, text: staticInstructions, cache_control: { type: "ephemeral" as const } });
  }
  return blocks;
}

const REPORT_RATE_LIMIT_WINDOW_MS = 60_000;
const REPORT_RATE_LIMIT_MAX = 12;

export async function checkReportRateLimit(
  userId: string,
  supabase: SupabaseClient,
): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + REPORT_RATE_LIMIT_WINDOW_MS);

  const { data, error } = (await supabase
    .from("report_rate_limits")
    .select("count, reset_at")
    .eq("user_id", userId)
    .single()) as { data: { count: number; reset_at: string } | null; error: unknown };

  if (error || !data) {
    await supabase.from("report_rate_limits").upsert({
      user_id: userId,
      count: 1,
      reset_at: resetAt.toISOString(),
    });
    return { limited: false, retryAfterSeconds: 0 };
  }

  const windowExpired = new Date(data.reset_at) <= now;

  if (windowExpired) {
    await supabase
      .from("report_rate_limits")
      .update({ count: 1, reset_at: resetAt.toISOString() })
      .eq("user_id", userId);
    return { limited: false, retryAfterSeconds: 0 };
  }

  if (data.count >= REPORT_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.ceil((new Date(data.reset_at).getTime() - now.getTime()) / 1000);
    return { limited: true, retryAfterSeconds };
  }

  await supabase
    .from("report_rate_limits")
    .update({ count: data.count + 1 })
    .eq("user_id", userId);

  return { limited: false, retryAfterSeconds: 0 };
}

// ── Clinical-text pre-processing (moved verbatim from route.ts) ────────────

/**
 * Resolve multi-organ normal sentences before sending to AI. Handles TWO
 * cases: (1) lines with an explicit [PARTIAL NORMAL] marker, and (2)
 * unmarked normal sentences that happen to share organ words with an
 * abnormal finding elsewhere (e.g. "Normal appearance of the spleen,
 * pancreas..." when splenomegaly is listed above). Removes only the
 * affected organ keyword(s); if nothing is confidently affected the line is
 * left unchanged; if every organ in the sentence is affected, the line is
 * omitted entirely.
 */
export function resolvePartialNormals(findings: string): string {
  const lines = findings.split("\n");

  const NORMAL_LINE = /^-?\s*(normal|intact|no |patent|clear|regular|unremarkable|preserved|scanned|absent)/i;
  const abnormalContext = lines
    .filter((l) => !/\[PARTIAL NORMAL/i.test(l) && !NORMAL_LINE.test(l.trim()))
    .join(" ")
    .toLowerCase();

  const SKIP = new Set([
    "with", "from", "that", "this", "show", "also", "well", "size", "each", "its", "not",
    "are", "has", "was", "intact", "normal", "preserved", "appearance", "configuration",
    "signal", "pattern", "marrow", "both", "joint", "articular", "homogenous", "evidence",
    "showing", "without", "findings", "bilateral", "regular", "filling", "focal", "lesion",
    "lesions", "clear", "patent", "average", "density", "dilatation", "radicles", "hepatic",
    "intra", "extra", "course", "caliber", "stones", "masses", "diverticulae", "retro",
    "crural", "para", "aortic", "pelvic", "lymphadenopathy", "bases", "scanned", "unremarkable",
  ]);

  const NORMAL_PREFIXES = /^-?\s*(normal|intact|no |patent|clear|regular|unremarkable|preserved)/i;
  const HAS_LIST = /\b\w+,\s*\w+/;

  function adaptSentence(sentence: string): string | null {
    const anatomyWords = sentence
      .toLowerCase()
      .split(/[\s,;.()\[\]/]+/)
      .filter((w) => w.length >= 4 && !SKIP.has(w));

    if (anatomyWords.length < 2) return sentence;

    const affectedWords = anatomyWords.filter((w) => abnormalContext.includes(w));
    const normalWords = anatomyWords.filter((w) => !abnormalContext.includes(w));

    if (affectedWords.length === 0) return sentence;
    if (normalWords.length === 0) return null;

    let adapted = sentence;
    for (const word of affectedWords) {
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      adapted = adapted
        .replace(new RegExp(`\\bthe\\s+${esc}\\b,?\\s*`, "gi"), "")
        .replace(new RegExp(`,\\s*\\b${esc}\\b`, "gi"), "")
        .replace(new RegExp(`\\b${esc}\\b,?\\s*`, "gi"), "")
        .trim();
    }
    adapted = adapted
      .replace(/\s{2,}/g, " ")
      .replace(/,(\s*,)+/g, ",")
      .replace(/,\s*\./g, ".")
      .replace(/\bof\s*,/g, "of")
      .replace(/\bof\s*\./g, ".")
      .trim();

    return adapted || null;
  }

  const result: string[] = [];

  for (const line of lines) {
    const pnMatch = line.match(/\[PARTIAL NORMAL[^\]]*:\s*(.+?)\]$/i);
    if (pnMatch) {
      const sentence = pnMatch[1].trim();
      const adapted = adaptSentence(sentence);
      if (adapted === sentence) result.push(line);
      else if (adapted) result.push(`- ${adapted}`);
      continue;
    }

    const bare = line.replace(/^-\s*/, "").trim();
    if (NORMAL_PREFIXES.test(bare) && HAS_LIST.test(bare)) {
      const adapted = adaptSentence(bare);
      if (adapted === bare) result.push(line);
      else if (adapted) result.push(`- ${adapted}`);
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

// ── Allowed provider models ─────────────────────────────────────────────────

export const ALLOWED_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6"] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];
