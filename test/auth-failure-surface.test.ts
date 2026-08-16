/**
 * What a caller sees, and what the operator sees, for each auth failure class.
 *
 * The live incident behind this file: a valid, unexpired Supabase token
 * answered 401 "The supplied access token is not valid" while the runtime log
 * showed no outgoing request at all — the service had never reached Supabase,
 * and blamed the caller anyway. These tests pin both halves of the fix: the
 * caller is told the truth, and the cause reaches the log.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import type { TokenVerification } from "../src/auth/resolve-caller.ts";

const UNREACHABLE_DETAIL = "AuthRetryableFetchError | 0 | fetch failed | ENOTFOUND";

function appThatFailsWith(failure: TokenVerification) {
  return createApp({ verifyToken: async () => failure });
}

function get(app: ReturnType<typeof createApp>, authorization?: string) {
  return app.request("/v1/credits", {
    headers: authorization ? { authorization } : {},
  });
}

/** Captures console output for the duration of one call. */
async function capturingConsole<T>(work: () => Promise<T> | T): Promise<{
  result: Awaited<T>;
  warn: unknown[][];
  error: unknown[][];
}> {
  const warn: unknown[][] = [];
  const error: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => void warn.push(args);
  console.error = (...args: unknown[]) => void error.push(args);
  try {
    return { result: await work(), warn, error };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

// ── Status and message per failure class ─────────────────────────────────────

test("no credential is still 401, with the header message unchanged", async () => {
  const response = await get(appThatFailsWith({ ok: true, user: { id: "u", email: null } }));
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.message, "An Authorization header is required.");
});

test("an invalid token is 401 and says so", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: { kind: "invalid", detail: "AuthApiError | 401 | bad_jwt" },
  });
  const response = await get(app, "Bearer some-token");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error, "unauthorized");
  assert.equal(body.message, "The supplied access token is not valid.");
});

test("an expired token is 401 but tells the caller what to do about it", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: { kind: "expired", detail: "AuthApiError | 401 | bad_jwt | token is expired" },
  });
  const response = await get(app, "Bearer some-token");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.match(body.message, /expired/i);
  assert.match(body.message, /fresh access token/i);
  // "Refresh your token" and "your token is bad" are different instructions.
  assert.notEqual(body.message, "The supplied access token is not valid.");
});

test("a verification we could not complete is 503, not a 401 blaming the caller", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: { kind: "upstream", detail: UNREACHABLE_DETAIL },
  });
  const response = await get(app, "Bearer a-perfectly-good-token");
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
  assert.notEqual(response.status, 401);
  assert.match(body.message, /fault in this service/i);
});

test("the 503 body leaks no host, key or upstream detail", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: {
      kind: "upstream",
      detail: "ENOTFOUND | db.mistyped-ref.supabase.co | apikey rejected",
    },
  });
  const response = await get(app, "Bearer token");
  const raw = await response.text();

  assert.doesNotMatch(raw, /ENOTFOUND/);
  assert.doesNotMatch(raw, /mistyped-ref/);
  assert.doesNotMatch(raw, /apikey/i);
});

// ── The operator's half: the cause reaches the log ───────────────────────────

test("an unverifiable token logs the real cause at error level", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: { kind: "upstream", detail: UNREACHABLE_DETAIL },
  });

  const { error } = await capturingConsole(() =>
    get(app, "Bearer a-perfectly-good-token"),
  );

  const logged = JSON.stringify(error);
  assert.match(logged, /ENOTFOUND/, "the cause must be visible in the runtime log");
  assert.match(logged, /verification-unavailable/);
  assert.equal(error.length, 1);
});

test("a rejected token logs its cause at warn level, and never the token", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: { kind: "invalid", detail: "AuthApiError | 401 | bad_jwt" },
  });

  const { warn, error } = await capturingConsole(() =>
    get(app, "Bearer super-secret-token-value"),
  );

  const logged = JSON.stringify(warn);
  assert.match(logged, /bad_jwt/);
  assert.doesNotMatch(logged, /super-secret-token-value/, "a credential must never be logged");
  assert.equal(error.length, 0, "a caller-side rejection is not a server error");
});

test("a request id ties the log line to the response the caller received", async () => {
  const app = appThatFailsWith({
    ok: false,
    failure: { kind: "upstream", detail: UNREACHABLE_DETAIL },
  });

  const { result, error } = await capturingConsole(() =>
    app.request("/v1/credits", {
      headers: { authorization: "Bearer token", "x-request-id": "trace-77" },
    }),
  );

  assert.equal(result.headers.get("X-Request-Id"), "trace-77");
  assert.match(JSON.stringify(error), /trace-77/);
});
