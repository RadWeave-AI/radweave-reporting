/**
 * The classifier that ended three debugging cycles.
 *
 * Every case below is a real shape produced by @supabase/auth-js 2.112 or by
 * undici underneath it. The distinction that matters throughout: does this
 * error say something about the CALLER's credential, or about OUR service?
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  authErrorDetail,
  classifyTokenFailure,
  isExpiredToken,
  jwtExpiresAtMs,
} from "../src/auth/auth-error.ts";

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

/** A structurally real JWT. The signature is never checked locally. */
function jwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "HS256", typ: "JWT" })}.${segment(payload)}.c2ln`;
}

const FRESH_TOKEN = jwt({ sub: "user-123", exp: Math.floor(NOW / 1000) + 3600 });
const EXPIRED_TOKEN = jwt({ sub: "user-123", exp: Math.floor(NOW / 1000) - 60 });

/** auth-js wraps a fetch that never completed as this, with status 0. */
const fetchNeverCompleted = Object.assign(new Error("fetch failed"), {
  name: "AuthRetryableFetchError",
  status: 0,
});

const badJwt = Object.assign(new Error("invalid JWT: unable to parse or verify signature"), {
  name: "AuthApiError",
  status: 401,
  code: "bad_jwt",
});

const ourAnonKeyRejected = Object.assign(new Error("Invalid API key"), {
  name: "AuthApiError",
  status: 401,
  code: "invalid_api_key",
});

// ── authErrorDetail ──────────────────────────────────────────────────────────

test("authErrorDetail keeps every field worth having in a log", () => {
  const detail = authErrorDetail(badJwt);

  assert.match(detail, /AuthApiError/);
  assert.match(detail, /401/);
  assert.match(detail, /bad_jwt/);
  assert.match(detail, /unable to parse or verify signature/);
});

test("authErrorDetail surfaces the socket-level cause, which is the whole story", () => {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo failed" };

  const detail = authErrorDetail(error);

  assert.match(detail, /ENOTFOUND/);
  assert.match(detail, /getaddrinfo failed/);
});

test("authErrorDetail never throws on whatever it is handed", () => {
  assert.equal(authErrorDetail(null), "unknown error");
  assert.equal(authErrorDetail(undefined), "unknown error");
  assert.equal(authErrorDetail("boom"), "boom");
  assert.equal(authErrorDetail({}), "unknown error");
});

// ── JWT expiry (classification only — never acceptance) ──────────────────────

test("jwtExpiresAtMs reads exp without verifying anything", () => {
  assert.equal(jwtExpiresAtMs(EXPIRED_TOKEN), (Math.floor(NOW / 1000) - 60) * 1000);
});

test("jwtExpiresAtMs returns null for anything that is not a three-part JWT", () => {
  assert.equal(jwtExpiresAtMs("not-a-jwt"), null);
  assert.equal(jwtExpiresAtMs("a.b"), null);
  assert.equal(jwtExpiresAtMs("a.!!!not-base64!!!.c"), null);
  assert.equal(jwtExpiresAtMs(jwt({ sub: "no-exp-claim" })), null);
});

test("isExpiredToken compares against the supplied clock", () => {
  assert.equal(isExpiredToken(EXPIRED_TOKEN, NOW), true);
  assert.equal(isExpiredToken(FRESH_TOKEN, NOW), false);
});

// ── Classification: our fault (503) ──────────────────────────────────────────

test("a fetch that never completed is our fault, not the caller's", () => {
  const failure = classifyTokenFailure(fetchNeverCompleted, FRESH_TOKEN, NOW);

  assert.equal(failure.kind, "upstream");
  assert.match(failure.detail, /AuthRetryableFetchError/);
});

test("a DNS failure — the live symptom — is our fault", () => {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = { code: "ENOTFOUND" };

  assert.equal(classifyTokenFailure(error, FRESH_TOKEN, NOW).kind, "upstream");
});

test("our own anon key being rejected is our fault, however it arrives", () => {
  assert.equal(classifyTokenFailure(ourAnonKeyRejected, FRESH_TOKEN, NOW).kind, "upstream");

  const noApiKey = Object.assign(new Error("No API key found in request"), {
    name: "AuthApiError",
    status: 401,
  });
  assert.equal(classifyTokenFailure(noApiKey, FRESH_TOKEN, NOW).kind, "upstream");
});

test("a 5xx from Supabase is our dependency failing, not a bad credential", () => {
  const error = Object.assign(new Error("Service Unavailable"), {
    name: "AuthRetryableFetchError",
    status: 503,
  });
  assert.equal(classifyTokenFailure(error, FRESH_TOKEN, NOW).kind, "upstream");
});

test("a client that could not be constructed is a configuration fault", () => {
  const error = new Error("Invalid supabaseUrl: Provided URL is malformed.");
  assert.equal(classifyTokenFailure(error, FRESH_TOKEN, NOW).kind, "upstream");
});

test("an unreachable dependency outranks an expired-looking token", () => {
  // With no completed exchange we know nothing about the credential. Calling
  // it expired would send the caller to refresh a token that was never the
  // problem — the exact wrong turn that cost three debugging cycles.
  assert.equal(classifyTokenFailure(fetchNeverCompleted, EXPIRED_TOKEN, NOW).kind, "upstream");
});

// ── Classification: the caller's credential (401) ────────────────────────────

test("an expired token is reported as expired, not as invalid", () => {
  const failure = classifyTokenFailure(badJwt, EXPIRED_TOKEN, NOW);

  assert.equal(failure.kind, "expired");
  // The upstream wording is still logged even though the verdict came from exp.
  assert.match(failure.detail, /bad_jwt/);
});

test("a rejected but unexpired token is invalid", () => {
  assert.equal(classifyTokenFailure(badJwt, FRESH_TOKEN, NOW).kind, "invalid");
});

test("a token from another project is the caller's problem once OUR key was accepted", () => {
  // Supabase answered and did not complain about the apikey header, so the
  // configuration is coherent — what it refused is the token.
  const error = Object.assign(new Error("User from sub claim in JWT does not exist"), {
    name: "AuthApiError",
    status: 403,
    code: "user_not_found",
  });

  assert.equal(classifyTokenFailure(error, FRESH_TOKEN, NOW).kind, "invalid");
});

test("something that is not a JWT at all is invalid", () => {
  assert.equal(classifyTokenFailure(badJwt, "not-a-jwt", NOW).kind, "invalid");
});

test("classification with no token still works and never claims expiry", () => {
  assert.equal(classifyTokenFailure(badJwt).kind, "invalid");
});
