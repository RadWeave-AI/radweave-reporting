/**
 * Who may run the deep check, and what a misconfigured deployment answers.
 *
 * The protection model: a dedicated DIAGNOSTICS_KEY header, NOT a Bearer
 * token. This endpoint exists to diagnose a broken auth path — gating it
 * behind that same path would make it unavailable in precisely the situation
 * it was built for. A missing or wrong key answers 404, identical to any
 * unknown route, so the endpoint cannot be discovered by probing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import type { ReadinessReport } from "../src/health/readiness.ts";

const KEY = "a-long-random-diagnostics-key";

const HEALTHY: ReadinessReport = {
  ok: true,
  config: { ok: true, supabase_host: "abcdefghijklm.supabase.co", variables: {} },
  dependencies: [
    { name: "supabase-auth", ok: true, status: "ok", latency_ms: 12 },
    { name: "supabase-service-role", ok: true, status: "ok", latency_ms: 30 },
    { name: "anthropic", ok: true, status: "ok", latency_ms: 90 },
  ],
};

const BROKEN: ReadinessReport = {
  ok: false,
  config: { ok: true, supabase_host: "mistyped-ref.supabase.co", variables: {} },
  dependencies: [
    {
      name: "supabase-auth",
      ok: false,
      status: "failed",
      latency_ms: 1_402,
      detail: "unreachable — no request completed: TypeError | fetch failed | ENOTFOUND",
    },
    { name: "supabase-service-role", ok: true, status: "ok", latency_ms: 30 },
    { name: "anthropic", ok: true, status: "ok", latency_ms: 90 },
  ],
};

function appWith(report: ReadinessReport, diagnosticsKey: string | undefined = KEY) {
  return createApp({
    verifyToken: async () => ({ id: "user-123", email: null }),
    diagnosticsKey,
    buildReadiness: async () => report,
  });
}

function ready(app: ReturnType<typeof createApp>, key?: string) {
  return app.request("/v1/ready", { headers: key ? { "x-diagnostics-key": key } : {} });
}

// ── Protection ───────────────────────────────────────────────────────────────

test("without the key the endpoint is indistinguishable from a missing route", async () => {
  const response = await ready(appWith(HEALTHY));
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "not-found");
  // 401 would confirm to a scanner that something is here.
  assert.notEqual(response.status, 401);
});

test("a wrong key answers exactly the same 404, byte for byte", async () => {
  const missing = await (await ready(appWith(HEALTHY))).json();
  const wrong = await (await ready(appWith(HEALTHY), "not-the-key")).json();

  assert.equal(wrong.error, missing.error);
  assert.equal(wrong.message, missing.message);
});

test("a key of the right value but wrong length cannot be probed by timing", async () => {
  // Both sides are sha256'd before comparison, so length is unobservable and
  // timingSafeEqual never throws on a mismatched-length guess.
  const response = await ready(appWith(HEALTHY), `${KEY}-with-extra`);
  assert.equal(response.status, 404);
});

test("with DIAGNOSTICS_KEY unset the endpoint does not exist at all", async () => {
  // Not configured is not the same as configured-and-empty: an unset key must
  // close the endpoint, never open it.
  const unguarded = createApp({ buildReadiness: async () => HEALTHY });

  const response = await ready(unguarded, KEY);
  assert.equal(response.status, 404);
});

test("the correct key opens it", async () => {
  const response = await ready(appWith(HEALTHY), KEY);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dependencies.length, 3);
  assert.equal(typeof body.request_id, "string");
});

// ── What it reports ──────────────────────────────────────────────────────────

test("a failing dependency answers 503 and names the cause", async () => {
  const response = await ready(appWith(BROKEN), KEY);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "service-unavailable");

  const auth = body.dependencies.find((d: { name: string }) => d.name === "supabase-auth");
  assert.match(auth.detail, /ENOTFOUND/);
  assert.equal(auth.ok, false);
  // The host is right there next to the failure — a mistyped ref is obvious.
  assert.equal(body.config.supabase_host, "mistyped-ref.supabase.co");
});

test("the deep check needs no Bearer token — it must work when auth is broken", async () => {
  const app = createApp({
    // Auth is completely dead: this is the situation being diagnosed.
    verifyToken: async () => ({
      ok: false as const,
      failure: { kind: "upstream" as const, detail: "ENOTFOUND" },
    }),
    diagnosticsKey: KEY,
    buildReadiness: async () => BROKEN,
  });

  const response = await ready(app, KEY);
  assert.equal(response.status, 503, "readiness must not depend on the auth path");
  assert.equal((await response.json()).dependencies.length, 3);
});

// ── Plain health stays a fast public liveness check ──────────────────────────

test("GET /v1/health is untouched: public, 200, no dependency calls", async () => {
  let probed = false;
  const app = createApp({
    diagnosticsKey: KEY,
    buildReadiness: async () => {
      probed = true;
      return HEALTHY;
    },
  });

  const response = await app.request("/v1/health");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "radweave-reporting");
  assert.equal(probed, false, "liveness must never make a network call");
});

// ── A deployment whose configuration never loaded ────────────────────────────

const CONFIG_ERROR = new Error("Missing required environment variable: SUPABASE_URL");

const DEGRADED: ReadinessReport = {
  ok: false,
  config: {
    ok: false,
    detail: CONFIG_ERROR.message,
    variables: { SUPABASE_URL: false, ANTHROPIC_API_KEY: true },
  },
  dependencies: [
    {
      name: "supabase-auth",
      ok: false,
      status: "skipped",
      latency_ms: 0,
      detail: "not attempted: service configuration is incomplete",
    },
  ],
};

function degradedApp() {
  return createApp({
    configError: CONFIG_ERROR,
    diagnosticsKey: KEY,
    buildReadiness: async () => DEGRADED,
  });
}

test("a misconfigured deployment answers 503 on health rather than a false 200", async () => {
  const response = await degradedApp().request("/v1/health");
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
  assert.match(body.message, /\/v1\/ready/);
  // The public surface must not name the variable.
  assert.doesNotMatch(body.message, /SUPABASE_URL/);
});

test("a misconfigured deployment refuses work instead of failing obscurely", async () => {
  const response = await degradedApp().request("/v1/reports/checklist", { method: "POST" });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
});

test("/v1/ready still answers when configuration never loaded — and names the variable", async () => {
  // This is the entire point of booting degraded rather than crashing: the one
  // moment an operator has least to go on is the one that must produce output.
  const response = await ready(degradedApp(), KEY);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.config.ok, false);
  assert.match(body.config.detail, /SUPABASE_URL/);
  assert.equal(body.config.variables.SUPABASE_URL, false);
});
