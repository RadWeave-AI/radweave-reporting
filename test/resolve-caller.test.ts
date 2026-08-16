import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVerification,
  parseApiKey,
  resolveCaller,
  unimplementedApiKeyResolver,
} from "../src/auth/resolve-caller.ts";

const VALID_TOKEN = "valid-access-token";

const verifyToken = async (token: string) =>
  token === VALID_TOKEN ? { id: "user-123", email: "radiologist@example.com" } : null;

// ── Bearer / JWT path (the one that must work today) ─────────────────────────

test("resolves a valid Bearer token to a user principal", async () => {
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, { verifyToken });

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.principal.kind, "user");
  assert.ok(result.principal.kind === "user");
  assert.equal(result.principal.userId, "user-123");
  assert.equal(result.principal.email, "radiologist@example.com");
});

test("retains the caller's access token so an RLS-scoped client can be built later", async () => {
  // My Template's embedding retrieval needs auth.uid() to resolve, which means
  // the service must be able to act as the caller, not only as service-role.
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, { verifyToken });

  assert.ok(result.ok && result.principal.kind === "user");
  assert.equal(result.principal.accessToken, VALID_TOKEN);
});

test("resolves the caller's plan through the injected resolver", async () => {
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, {
    verifyToken,
    resolvePlan: async (userId) => (userId === "user-123" ? "pro" : "free"),
  });

  assert.ok(result.ok);
  assert.equal(result.principal.plan, "pro");
});

test("defaults to the free plan when no plan resolver is configured", async () => {
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, { verifyToken });

  assert.ok(result.ok);
  assert.equal(result.principal.plan, "free");
});

test("rejects a token Supabase does not recognise", async () => {
  const result = await resolveCaller("Bearer wrong-token", { verifyToken });

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, "invalid-credential");
});

test("rejects a missing Authorization header", async () => {
  const result = await resolveCaller(undefined, { verifyToken });

  assert.ok(!result.ok);
  assert.equal(result.reason, "missing-credential");
});

test("rejects an empty Bearer token without calling the verifier", async () => {
  let called = false;
  const result = await resolveCaller("Bearer    ", {
    verifyToken: async () => {
      called = true;
      return { id: "should-not-happen", email: null };
    },
  });

  assert.ok(!result.ok);
  assert.equal(result.reason, "malformed-credential");
  assert.equal(called, false);
});

test("rejects an unsupported authorization scheme", async () => {
  const result = await resolveCaller("Basic dXNlcjpwYXNz", { verifyToken });

  assert.ok(!result.ok);
  assert.equal(result.reason, "unsupported-scheme");
});

// The service is the trust boundary: identity comes from the credential only.
test("never derives identity from anything but the verified credential", async () => {
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, {
    verifyToken: async () => ({ id: "from-token", email: null }),
  });

  assert.ok(result.ok && result.principal.kind === "user");
  assert.equal(result.principal.userId, "from-token");
});

// ── Failure classes are distinguishable, not one generic 401 ─────────────────

test("an expired token is reported as expired rather than invalid", async () => {
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, {
    verifyToken: async () => ({
      ok: false as const,
      failure: { kind: "expired" as const, detail: "AuthApiError | 401 | bad_jwt" },
    }),
  });

  assert.ok(!result.ok);
  assert.equal(result.reason, "expired-credential");
  assert.match(result.message, /expired/i);
});

test("a verification we could not complete is OUR fault, never the caller's", async () => {
  // The bug this whole change exists to kill: a token we failed to check being
  // reported as a token that failed the check.
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, {
    verifyToken: async () => ({
      ok: false as const,
      failure: {
        kind: "upstream" as const,
        detail: "AuthRetryableFetchError | 0 | fetch failed | ENOTFOUND",
      },
    }),
  });

  assert.ok(!result.ok);
  assert.equal(result.reason, "verification-unavailable");
  assert.notEqual(result.reason, "invalid-credential");
  assert.match(result.message, /not in the credential supplied/i);
});

test("the underlying cause is carried for the log and kept out of the message", async () => {
  const result = await resolveCaller(`Bearer ${VALID_TOKEN}`, {
    verifyToken: async () => ({
      ok: false as const,
      failure: { kind: "upstream" as const, detail: "ENOTFOUND | db.wrong-ref.supabase.co" },
    }),
  });

  assert.ok(!result.ok);
  assert.equal(result.detail, "ENOTFOUND | db.wrong-ref.supabase.co");
  // A stranger learns nothing about our hostnames or our keys.
  assert.doesNotMatch(result.message, /ENOTFOUND|supabase/i);
});

test("a verifier that only knows yes-or-no still works, and means invalid", async () => {
  // Every test double in this repo is such a verifier. The richer shape is an
  // addition, not a migration.
  assert.deepEqual(normalizeVerification({ id: "u", email: null }), {
    ok: true,
    user: { id: "u", email: null },
  });

  const failure = normalizeVerification(null);
  assert.ok(!failure.ok);
  assert.equal(failure.failure.kind, "invalid");
});

// ── ApiKey path (scaffolded, deliberately not functional) ────────────────────

test("parseApiKey splits on the first dot so secrets may contain dots", () => {
  assert.deepEqual(parseApiKey("key123.secret.with.dots"), {
    keyId: "key123",
    secret: "secret.with.dots",
  });
  assert.equal(parseApiKey("nodot"), null);
  assert.equal(parseApiKey(".leading"), null);
  assert.equal(parseApiKey("trailing."), null);
});

test("a well-formed API key reports not-implemented rather than invalid", async () => {
  // Reporting "invalid-credential" would misrepresent an unbuilt feature as a
  // rejected credential, and would mislead the first hospital integrator.
  const result = await resolveCaller("ApiKey key123.somesecret", { verifyToken });

  assert.ok(!result.ok);
  assert.equal(result.reason, "not-implemented");
});

test("a malformed API key is a validation failure, not not-implemented", async () => {
  const result = await resolveCaller("ApiKey nodot", { verifyToken });

  assert.ok(!result.ok);
  assert.equal(result.reason, "malformed-credential");
});

test("the shipped API key resolver resolves nothing (no api_clients table yet)", async () => {
  assert.equal(await unimplementedApiKeyResolver("any", "thing"), null);
});

test("an injected API key resolver produces an org principal", async () => {
  // Proves the seam is real: only the resolver is missing, not the plumbing.
  const result = await resolveCaller("ApiKey key123.somesecret", {
    verifyToken,
    resolveApiKey: async (keyId) => ({ orgId: "org-7", keyId, plan: "institution" }),
  });

  assert.ok(result.ok && result.principal.kind === "org");
  assert.equal(result.principal.orgId, "org-7");
  assert.equal(result.principal.keyId, "key123");
  assert.equal(result.principal.plan, "institution");
});
