import type { SupabaseClient } from "@supabase/supabase-js";
import { BETA_CREDIT_LIMIT, isBetaTester } from "@/lib/beta/access";

// ── Credit cost per mode ───────────────────────────────────────────────────────

export const CREDIT_COST = {
  fast:              1.0,
  quality:           1.5,
  consultant_rapid:  1.0,
  consultant_expert: 2.0,
} as const;

// ── Credits per plan per month ─────────────────────────────────────────────────

export const PLAN_CREDITS: Record<string, number> = {
  free:        10,
  basic:       100,
  pro:         300,
  institution: 2000,
};

export type ReportMode = "fast" | "quality";
export type CreditCostKey = keyof typeof CREDIT_COST;

export interface UsageRecord {
  credits_used:      number;
  credits_limit:     number;
  plan:              string;
  period_end:        string;
  credits_remaining: number;
}

/**
 * A read-only view of an existing usage row. Admin display routes use this
 * instead of getOrCreateUsage so viewing an account cannot initialize or
 * synchronize its credit record.
 */
export interface UsageSnapshot {
  initialized: boolean;
  credits_used: number | null;
  credits_limit: number | null;
  plan: string | null;
  period_end: string | null;
  credits_remaining: number | null;
}

export function usageSnapshotFromRow(row: Record<string, unknown> | null | undefined): UsageSnapshot {
  if (!row) {
    return {
      initialized: false,
      credits_used: null,
      credits_limit: null,
      plan: null,
      period_end: null,
      credits_remaining: null,
    };
  }

  const record = toRecord(row);
  return { initialized: true, ...record };
}

/** Select an existing usage row without ever initializing or changing it. */
export async function getUsageSnapshot(supabase: SupabaseClient, userId: string): Promise<UsageSnapshot> {
  const { data, error } = await supabase
    .from("usage")
    .select("credits_used, credits_limit, plan, period_end")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return usageSnapshotFromRow(data as Record<string, unknown> | null);
}

async function getActiveCreditAdjustmentTotal(supabase: SupabaseClient, userId: string): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("admin_credit_adjustments")
    .select("amount, expires_at")
    .eq("user_id", userId)
    .or(`expires_at.is.null,expires_at.gt.${now}`);

  if (error) return 0;
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

/**
 * Get or create usage record for a user.
 * Resets automatically if the billing period has expired or the plan changed.
 */
export async function getOrCreateUsage(
  supabase: SupabaseClient,
  userId: string,
  plan: string,
  billingPeriodEnd?: string | null
): Promise<UsageRecord> {
  const now   = new Date();
  const betaTester = await isBetaTester(userId, supabase);
  const effectivePlan = betaTester ? "beta" : plan;
  const baseLimit = betaTester ? BETA_CREDIT_LIMIT : (PLAN_CREDITS[plan] ?? PLAN_CREDITS.free);
  const bonusCredits = await getActiveCreditAdjustmentTotal(supabase, userId);
  const limit = Math.max(0, baseLimit + bonusCredits);
  const targetPeriod = betaTester
    ? resolveBetaCreditPeriod(now)
    : resolveCreditPeriod(now, plan, billingPeriodEnd);

  // ── Try to fetch existing record ─────────────────────────────────────────────
  const { data: existing } = await supabase
    .from("usage")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (existing) {
    const periodEnd  = new Date(existing.period_end);
    const targetEndChanged = targetPeriod.end.getTime() !== periodEnd.getTime();
    const shouldExtendCurrentPaidPeriod =
      !betaTester &&
      plan !== "free" &&
      targetEndChanged &&
      targetPeriod.end > periodEnd &&
      now <= periodEnd &&
      existing.plan === effectivePlan;
    const needsReset = now > periodEnd || existing.plan !== effectivePlan;

    if (needsReset) {
      // Period expired or user changed plan — reset counter
      const { data: reset } = await supabase
        .from("usage")
        .update({
          credits_used:  0,
          credits_limit: limit,
          plan:          effectivePlan,
          period_start:  targetPeriod.start.toISOString(),
          period_end:    targetPeriod.end.toISOString(),
          updated_at:    now.toISOString(),
        })
        .eq("user_id", userId)
        .select()
        .single();

      return toRecord(reset!);
    }

    // Mid-period plan upgrade — sync limit without resetting counter
    if (shouldExtendCurrentPaidPeriod || existing.credits_limit !== limit) {
      await supabase
        .from("usage")
        .update({
          credits_limit: limit,
          plan: effectivePlan,
          period_start: shouldExtendCurrentPaidPeriod ? targetPeriod.start.toISOString() : existing.period_start,
          period_end: shouldExtendCurrentPaidPeriod ? targetPeriod.end.toISOString() : existing.period_end,
          updated_at: now.toISOString(),
        })
        .eq("user_id", userId);
      existing.credits_limit = limit;
      existing.plan          = effectivePlan;
      if (shouldExtendCurrentPaidPeriod) {
        existing.period_start = targetPeriod.start.toISOString();
        existing.period_end = targetPeriod.end.toISOString();
      }
    }

    return toRecord(existing);
  }

  // ── No record yet — create it ─────────────────────────────────────────────────
  const { data: created } = await supabase
    .from("usage")
    .insert({
      user_id:       userId,
      credits_used:  0,
      credits_limit: limit,
      plan:          effectivePlan,
      period_start:  targetPeriod.start.toISOString(),
      period_end:    targetPeriod.end.toISOString(),
    })
    .select()
    .single();

  return toRecord(created!);
}

/**
 * Atomically add credits_used after a successful generation.
 * Uses a Supabase RPC so the increment is safe under concurrent requests.
 * NOTE: unconditional — kept for other callers. The generation path now uses
 * reserveCredits/refundCredits below to avoid the check-then-deduct race.
 */
export async function deductCredits(
  supabase: SupabaseClient,
  userId: string,
  mode: ReportMode
): Promise<void> {
  const cost = CREDIT_COST[mode];
  await supabase.rpc("increment_credits_used", {
    p_user_id: userId,
    p_amount:  cost,
  });
}

/**
 * Atomically reserve (deduct up front) a credit BEFORE generation.
 * Single conditional UPDATE inside reserve_credits — the row lock serializes
 * concurrent callers, so only as many succeed as there are credits. Returns
 * true if reserved, false if the user cannot afford it. Throws on RPC error
 * (caller must fail safe and NOT generate).
 */
export async function reserveCredits(
  supabase: SupabaseClient,
  userId: string,
  mode: CreditCostKey
): Promise<boolean> {
  const cost = CREDIT_COST[mode];
  const { data, error } = await supabase.rpc("reserve_credits", {
    p_user_id: userId,
    p_amount:  cost,
  });
  if (error) throw new Error(`reserve_credits failed: ${error.message}`);
  return data === true;
}

/**
 * Compensating refund for a reserved credit when generation fails, so a failed
 * generation is net-zero charge. Floored at 0 inside the RPC.
 */
export async function refundCredits(
  supabase: SupabaseClient,
  userId: string,
  mode: CreditCostKey
): Promise<void> {
  const cost = CREDIT_COST[mode];
  const { error } = await supabase.rpc("refund_credits", {
    p_user_id: userId,
    p_amount:  cost,
  });
  if (error) throw new Error(`refund_credits failed: ${error.message}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateTruncMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function resolveCreditPeriod(now: Date, plan: string, billingPeriodEnd?: string | null): { start: Date; end: Date } {
  if (plan !== "free" && billingPeriodEnd) {
    const stripeEnd = new Date(billingPeriodEnd);
    if (!Number.isNaN(stripeEnd.getTime()) && stripeEnd > now) {
      const stripeStart = new Date(stripeEnd);
      stripeStart.setMonth(stripeStart.getMonth() - 1);
      return { start: stripeStart, end: stripeEnd };
    }
  }

  const start = dateTruncMonth(now);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

function resolveBetaCreditPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  return { start, end };
}

function toRecord(row: Record<string, unknown>): UsageRecord {
  const used  = Number(row.credits_used);
  const limit = Number(row.credits_limit);
  return {
    credits_used:      used,
    credits_limit:     limit,
    plan:              row.plan as string,
    period_end:        row.period_end as string,
    credits_remaining: Math.max(0, limit - used),
  };
}

