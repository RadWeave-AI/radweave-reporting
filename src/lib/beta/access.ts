import type { SupabaseClient } from "@supabase/supabase-js";

export const BETA_CREDIT_LIMIT = 20;

export function isBetaMode() {
  return process.env.NEXT_PUBLIC_BETA_MODE === "true";
}

export async function isBetaTester(userId: string, supabase: SupabaseClient) {
  if (!isBetaMode()) return false;
  if (!userId) return false;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("is_beta_tester")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return false;
  return data.is_beta_tester === true;
}

