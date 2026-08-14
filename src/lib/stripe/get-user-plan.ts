import type { SupabaseClient } from "@supabase/supabase-js";
import { isBetaTester } from "@/lib/beta/access";
import { getSupabaseService } from "@/lib/reporting/kernel";
import type { PlanKey } from "@/lib/stripe/config";

export interface UserSubscription {
  plan:                  PlanKey;
  status:                string;
  stripe_customer_id:    string | null;
  stripe_subscription_id: string | null;
  current_period_end:    string | null;
  cancel_at_period_end:  boolean;
  is_beta_tester:        boolean;
}

const FREE_SUB: UserSubscription = {
  plan:                  "free",
  status:                "active",
  stripe_customer_id:    null,
  stripe_subscription_id: null,
  current_period_end:    null,
  cancel_at_period_end:  false,
  is_beta_tester:        false,
};

/**
 * Returns the current subscription for a user (server-side only).
 * Falls back to the free plan if no row exists.
 *
 * `supabaseClient` is optional and follows the same injection pattern the
 * reporting modules use for every other collaborator (`deps.x ?? x`): callers
 * that already hold a service-role client can pass it instead of having this
 * function build a second one, and a standalone (non-Next) host can supply a
 * client built from its own configuration. Omitting it is unchanged behavior
 * — the client is still built lazily, and only after the empty-userId guard.
 */
export async function getUserPlan(
  userId: string,
  supabaseClient?: SupabaseClient,
): Promise<UserSubscription> {
  if (!userId) return FREE_SUB;

  const supabase = supabaseClient ?? getSupabaseService();

  const { data, error } = await supabase
    .from("subscriptions")
    .select(
      "plan, status, stripe_customer_id, stripe_subscription_id, " +
      "current_period_end, cancel_at_period_end, is_beta_tester"
    )
    .eq("user_id", userId)
    .maybeSingle() as {
      data: {
        plan: string | null;
        status: string | null;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        current_period_end: string | null;
        cancel_at_period_end: boolean | null;
        is_beta_tester: boolean | null;
      } | null;
      error: unknown;
    };

  if (error || !data) return FREE_SUB;

  if (await isBetaTester(userId, supabase)) {
    return {
      plan:                   "institution",
      status:                 "active",
      stripe_customer_id:     data.stripe_customer_id ?? null,
      stripe_subscription_id: data.stripe_subscription_id ?? null,
      current_period_end:     data.current_period_end ?? null,
      cancel_at_period_end:   data.cancel_at_period_end ?? false,
      is_beta_tester:         true,
    };
  }

  // Treat cancelled/past_due as free
  if (!["active", "trialing"].includes(data.status ?? "")) {
    return { ...FREE_SUB, plan: "free" };
  }

  return {
    plan:                   (data.plan as PlanKey) ?? "free",
    status:                 data.status ?? "active",
    stripe_customer_id:     data.stripe_customer_id ?? null,
    stripe_subscription_id: data.stripe_subscription_id ?? null,
    current_period_end:     data.current_period_end ?? null,
    cancel_at_period_end:   data.cancel_at_period_end ?? false,
    is_beta_tester:         data.is_beta_tester === true,
  };
}
