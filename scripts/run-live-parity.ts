import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { createServiceRoleClient } from "../src/supabase/clients.ts";

const config = loadConfig();
const admin = createServiceRoleClient(config);
const nonce = crypto.randomUUID();
const email = `radweave-reporting-parity-${nonce}@example.com`;
const password = `${crypto.randomUUID()}Aa1!`;
const websiteUrl = (process.env.PARITY_WEBSITE_URL ?? "https://radweave.ai").replace(/\/$/, "");

let userId: string | null = null;
let failure: unknown = null;
const cleanupErrors: string[] = [];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeRows(table: string) {
  if (!userId) return;
  const result = await admin.from(table).delete().eq("user_id", userId);
  if (result.error) cleanupErrors.push(`${table}: ${result.error.message}`);
}

try {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`Disposable parity user creation failed: ${errorMessage(created.error)}`);
  }
  userId = created.data.user.id;

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const usage = await admin.from("usage").upsert({
    user_id: userId,
    credits_used: 0,
    credits_limit: 10,
    plan: "free",
    period_start: now.toISOString(),
    period_end: periodEnd.toISOString(),
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });
  if (usage.error) throw new Error(`Disposable credit initialization failed: ${usage.error.message}`);

  const override = await admin.from("user_feature_overrides").upsert({
    user_id: userId,
    feature_key: "pathology_reports",
    enabled: true,
    note: "Disposable reporting parity verification",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, { onConflict: "user_id,feature_key" });
  if (override.error) throw new Error(`Disposable feature override failed: ${override.error.message}`);

  const auth = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await auth.auth.signInWithPassword({ email, password });
  const accessToken = signedIn.data.session?.access_token;
  if (signedIn.error || !accessToken) {
    throw new Error(`Disposable access-token sign-in failed: ${errorMessage(signedIn.error)}`);
  }

  const websiteLogin = await fetch(`${websiteUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!websiteLogin.ok) {
    throw new Error(`Live website login returned HTTP ${websiteLogin.status}.`);
  }
  const setCookies = (websiteLogin.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [];
  const websiteCookie = setCookies
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!websiteCookie) throw new Error("Live website login returned no auth cookie.");

  process.env.PARITY_ACCESS_TOKEN = accessToken;
  process.env.PARITY_WEBSITE_COOKIE = websiteCookie;
  process.env.PARITY_INPUTS ??= fileURLToPath(
    new URL("./parity-inputs.deidentified.json", import.meta.url),
  );

  await import("./parity-harness.ts");
} catch (error) {
  failure = error;
} finally {
  delete process.env.PARITY_ACCESS_TOKEN;
  delete process.env.PARITY_WEBSITE_COOKIE;
  await removeRows("report_reviews");
  await removeRows("report_usage_logs");
  await removeRows("report_rate_limits");
  await removeRows("user_feature_overrides");
  await removeRows("admin_credit_adjustments");
  await removeRows("usage");
  if (userId) {
    const deleted = await admin.auth.admin.deleteUser(userId);
    if (deleted.error) cleanupErrors.push(`auth user: ${deleted.error.message}`);
  }
}

if (cleanupErrors.length > 0) {
  const cleanupFailure = new Error(`Parity cleanup failed (${cleanupErrors.join("; ")})`);
  if (!failure) failure = cleanupFailure;
  else console.error(cleanupFailure.message);
}
if (failure) throw failure;

console.log(JSON.stringify({ ok: true, cleanup_complete: true }));
