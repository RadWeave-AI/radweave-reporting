/**
 * The deep readiness check, against deliberately wrong credentials.
 *
 * Each case here is one of the failures that has actually cost this project
 * time. The bar for every one of them: an operator reading the output knows
 * which variable to fix, without reading any code.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceConfig } from "../src/config.ts";
import {
  buildReadinessReport,
  checkAnthropic,
  checkSupabaseAuth,
  checkSupabaseServiceRole,
  type ReadinessDeps,
} from "../src/health/readiness.ts";

const CONFIG: ServiceConfig = {
  supabaseUrl: "https://abcdefghijklm.supabase.co",
  supabaseAnonKey: "anon-key-value-that-must-never-be-echoed",
  supabaseServiceRoleKey: "service-role-value-that-must-never-be-echoed",
  anthropicApiKey: "sk-ant-value-that-must-never-be-echoed",
  port: 8787,
};

const COMPLETE_ENV = {
  SUPABASE_URL: CONFIG.supabaseUrl,
  SUPABASE_ANON_KEY: CONFIG.supabaseAnonKey,
  SUPABASE_SERVICE_ROLE_KEY: CONFIG.supabaseServiceRoleKey,
  ANTHROPIC_API_KEY: CONFIG.anthropicApiKey,
};

/** Every probe healthy. Individual tests override one at a time. */
function healthyDeps(overrides: ReadinessDeps = {}): ReadinessDeps {
  return {
    timeoutMs: 50,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    clientFactory: (() => ({
      from: () => ({
        select: () => ({ limit: async () => ({ error: null }) }),
      }),
    })) as never,
    createAnthropic: () => ({ models: { list: async () => ({ data: [] }) } }),
    ...overrides,
  };
}

/** A supabase-js stand-in whose PostgREST call fails with `error`. */
function failingPostgrest(error: unknown) {
  return (() => ({
    from: () => ({ select: () => ({ limit: async () => ({ error }) }) }),
  })) as never;
}

// ── Supabase Auth (the anon-key path the Bearer flow depends on) ─────────────

test("a healthy Supabase Auth reports ok", async () => {
  const result = await checkSupabaseAuth(CONFIG, healthyDeps());

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.name, "supabase-auth");
});

test("the anon-key path is probed with the anon key, at the configured host", async () => {
  let seenUrl = "";
  let seenApiKey: string | null = null;

  await checkSupabaseAuth(
    CONFIG,
    healthyDeps({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenApiKey = new Headers(init.headers).get("apikey");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );

  assert.equal(seenUrl, "https://abcdefghijklm.supabase.co/auth/v1/settings");
  assert.equal(seenApiKey, CONFIG.supabaseAnonKey);
});

test("a mistyped SUPABASE_URL reports as unreachable with the socket cause", async () => {
  // Past failure #2, and the shape of the live 401: nothing ever left the box.
  const dnsFailure = new TypeError("fetch failed");
  (dnsFailure as { cause?: unknown }).cause = { code: "ENOTFOUND" };

  const result = await checkSupabaseAuth(
    CONFIG,
    healthyDeps({
      fetchImpl: (async () => {
        throw dnsFailure;
      }) as unknown as typeof fetch,
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /unreachable/i);
  assert.match(result.detail!, /ENOTFOUND/);
});

test("a rotated or foreign anon key names itself as the cause", async () => {
  const result = await checkSupabaseAuth(
    CONFIG,
    healthyDeps({
      fetchImpl: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /SUPABASE_ANON_KEY/);
  assert.match(result.detail!, /rotated|wrong|different project/i);
  // The operator is told what this means for real traffic.
  assert.match(result.detail!, /Bearer token/i);
});

test("a URL that is not a Supabase project is called out as such", async () => {
  const result = await checkSupabaseAuth(
    CONFIG,
    healthyDeps({
      fetchImpl: (async () =>
        new Response("nope", { status: 404 })) as unknown as typeof fetch,
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /SUPABASE_URL/);
});

test("a hung dependency fails the probe instead of hanging the diagnostic", async () => {
  const result = await checkSupabaseAuth(
    CONFIG,
    healthyDeps({
      timeoutMs: 20,
      fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /timed out/);
});

// ── Supabase service-role ────────────────────────────────────────────────────

test("a healthy service-role key reports ok", async () => {
  const result = await checkSupabaseServiceRole(CONFIG, healthyDeps());
  assert.equal(result.ok, true);
});

test("a rejected service-role key names the variable to fix", async () => {
  const result = await checkSupabaseServiceRole(
    CONFIG,
    healthyDeps({
      clientFactory: failingPostgrest({ message: "Invalid API key", code: "PGRST301" }),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("a table-level failure is reported as a query failure, not a key failure", async () => {
  const result = await checkSupabaseServiceRole(
    CONFIG,
    healthyDeps({
      clientFactory: failingPostgrest({
        message: 'relation "public.subscriptions" does not exist',
        code: "42P01",
      }),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /subscriptions/);
  assert.doesNotMatch(result.detail!, /SUPABASE_SERVICE_ROLE_KEY/);
});

// ── Anthropic ────────────────────────────────────────────────────────────────

test("the Anthropic probe lists models and bills no generation", async () => {
  let calledWith: unknown = null;
  const result = await checkAnthropic(
    CONFIG,
    healthyDeps({
      createAnthropic: () => ({
        models: {
          list: async (params: { limit: number }) => {
            calledWith = params;
            return { data: [] };
          },
        },
      }),
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calledWith, { limit: 1 });
});

test("a rejected Anthropic key names the variable to fix", async () => {
  const result = await checkAnthropic(
    CONFIG,
    healthyDeps({
      createAnthropic: () => ({
        models: {
          list: async () => {
            throw Object.assign(new Error("invalid x-api-key"), {
              name: "AuthenticationError",
              status: 401,
            });
          },
        },
      }),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.detail!, /ANTHROPIC_API_KEY/);
});

// ── The assembled report ─────────────────────────────────────────────────────

test("a fully healthy deployment reports ok with all three dependencies", async () => {
  const report = await buildReadinessReport(
    { config: CONFIG, env: COMPLETE_ENV },
    healthyDeps(),
  );

  assert.equal(report.ok, true);
  assert.equal(report.config.ok, true);
  assert.deepEqual(
    report.dependencies.map((dependency) => dependency.name).sort(),
    ["anthropic", "supabase-auth", "supabase-service-role"],
  );
  assert.ok(report.dependencies.every((dependency) => dependency.ok));
});

test("one failing dependency fails the report but the others still report", async () => {
  const report = await buildReadinessReport(
    { config: CONFIG, env: COMPLETE_ENV },
    healthyDeps({
      fetchImpl: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
    }),
  );

  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.dependencies.map((d) => [d.name, d]));
  assert.equal(byName["supabase-auth"]!.ok, false);
  assert.equal(byName["anthropic"]!.ok, true, "one failure must not mask the rest");
});

test("the Supabase hostname is reported so a mistyped project ref is visible", async () => {
  const report = await buildReadinessReport(
    { config: CONFIG, env: COMPLETE_ENV },
    healthyDeps(),
  );

  assert.equal(report.config.supabase_host, "abcdefghijklm.supabase.co");
});

test("a missing environment variable is named, and probes are not guessed at", async () => {
  // Past failure #1. Previously this crashed the function at import time and
  // produced no readable output whatsoever.
  const env = { ...COMPLETE_ENV, SUPABASE_URL: undefined };
  const report = await buildReadinessReport(
    {
      config: null,
      configError: new Error("Missing required environment variable: SUPABASE_URL"),
      env,
    },
    healthyDeps(),
  );

  assert.equal(report.ok, false);
  assert.equal(report.config.ok, false);
  assert.match(report.config.detail!, /SUPABASE_URL/);
  assert.equal(report.config.variables.SUPABASE_URL, false);
  assert.equal(report.config.variables.ANTHROPIC_API_KEY, true);
  // "skipped" must not read as "passed".
  assert.ok(report.dependencies.every((d) => d.status === "skipped" && !d.ok));
});

test("no secret value appears anywhere in the report", async () => {
  const report = await buildReadinessReport(
    { config: CONFIG, env: COMPLETE_ENV },
    healthyDeps({
      fetchImpl: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
      createAnthropic: () => ({
        models: {
          list: async () => {
            throw new Error("invalid x-api-key");
          },
        },
      }),
    }),
  );

  const serialised = JSON.stringify(report);
  for (const secret of [
    CONFIG.supabaseAnonKey,
    CONFIG.supabaseServiceRoleKey,
    CONFIG.anthropicApiKey,
  ]) {
    assert.doesNotMatch(serialised, new RegExp(secret), `report leaked ${secret}`);
  }
});
