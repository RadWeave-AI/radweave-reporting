import type { SupabaseClient } from "@supabase/supabase-js";
import { isBetaTester } from "../beta/access.ts";
import { getSupabaseService } from "../reporting/kernel.ts";

export const FEATURE_KEYS = [
  "pathology_reports",
  "dicom_cases",
  "full_dicom_library",
  "template_library",
  "differential_helper",
  "dictation",
] as const;

export type FeatureKey = typeof FEATURE_KEYS[number];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  pathology_reports: "Pathology reports",
  dicom_cases: "Teaching cases",
  full_dicom_library: "Full teaching case library",
  template_library: "Template library",
  differential_helper: "Differential helper",
  dictation: "Dictation",
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

export function planAllowsFeature(plan: string, feature: FeatureKey) {
  if (plan === "institution") return true;
  if (plan === "pro") return true;
  if (plan === "basic") {
    return ["pathology_reports", "dicom_cases", "template_library"].includes(feature);
  }
  return false;
}

export async function hasFeatureOverride(
  userId: string,
  feature: FeatureKey,
  supabase: SupabaseClient = getSupabaseService()
) {
  const { data } = await supabase
    .from("user_feature_overrides")
    .select("enabled, expires_at")
    .eq("user_id", userId)
    .eq("feature_key", feature)
    .maybeSingle();

  if (!data || data.enabled !== true) return false;
  return !data.expires_at || new Date(data.expires_at) > new Date();
}

export async function canUseFeature(
  userId: string,
  plan: string,
  feature: FeatureKey,
  supabase: SupabaseClient = getSupabaseService(),
) {
  if (planAllowsFeature(plan, feature)) return true;
  if (await isBetaTester(userId, supabase)) return true;
  return hasFeatureOverride(userId, feature, supabase);
}
