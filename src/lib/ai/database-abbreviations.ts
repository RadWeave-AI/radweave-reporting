import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomAbbreviation } from "@/lib/ai/abbreviation-parser";

interface AbbreviationRow {
  abbreviation: string;
  modality: string | null;
  body_region: string | null;
  study_type: string | null;
  finding_text: string;
  opinion_text: string | null;
  category: string;
}

function scopeScore(row: AbbreviationRow, modality: string, bodyRegion: string, studyType?: string) {
  if (row.modality && row.modality.toLowerCase() !== modality.toLowerCase()) return -1;
  if (row.body_region && row.body_region.toLowerCase() !== bodyRegion.toLowerCase()) return -1;
  if (row.study_type && row.study_type.toLowerCase() !== (studyType ?? "").toLowerCase()) return -1;
  return Number(!!row.modality) + Number(!!row.body_region) + Number(!!row.study_type);
}

export async function loadDatabaseAbbreviations(
  supabase: SupabaseClient,
  modality: string,
  bodyRegion: string,
  studyType?: string
): Promise<CustomAbbreviation[]> {
  const { data, error } = await supabase
    .from("report_abbreviations")
    .select("abbreviation, modality, body_region, study_type, finding_text, opinion_text, category")
    .eq("active", true)
    .limit(2000);

  if (error) {
    console.warn("[abbreviations] database abbreviations unavailable:", error.message);
    return [];
  }

  const bestByKey = new Map<string, { row: AbbreviationRow; score: number }>();
  for (const row of (data ?? []) as AbbreviationRow[]) {
    const score = scopeScore(row, modality, bodyRegion, studyType);
    if (score < 0) continue;
    const key = row.abbreviation.trim().toLowerCase();
    const current = bestByKey.get(key);
    if (!current || score > current.score) bestByKey.set(key, { row, score });
  }

  return Array.from(bestByKey.values()).map(({ row }) => ({
    abbreviation: row.abbreviation,
    findingText: row.finding_text,
    opinionText: row.opinion_text ?? undefined,
    category: row.category,
  }));
}

