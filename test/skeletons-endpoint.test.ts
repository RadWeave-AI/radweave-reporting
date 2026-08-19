/**
 * GET /v1/skeletons — auth, query handling, and envelope at the HTTP edge.
 *
 * Calls the REAL skeleton-list.ts (no injected fake) so these tests exercise
 * the actual data path, not a fixture standing in for it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";

const TOKEN = "valid-access-token";

function makeApp(overrides: Record<string, unknown> = {}) {
  return createApp({
    verifyToken: async (token) =>
      token === TOKEN ? { id: "user-123", email: "radiologist@example.com" } : null,
    resolvePlan: async () => "pro",
    ...overrides,
  });
}

function get(app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: "GET", headers });
}

function authed() {
  return { authorization: `Bearer ${TOKEN}` };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

test("the skeleton list requires a credential", async () => {
  const response = await get(makeApp(), "/v1/skeletons");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error, "unauthorized");
});

test("an ORG credential is accepted — unlike /v1/templates, there is no per-user data here", async () => {
  // ApiKey, not Bearer: that is the scheme resolveCaller actually routes an
  // org credential through (see parseApiKey / resolve-caller.ts).
  const app = createApp({
    resolveApiKey: async (keyId, secret) =>
      keyId === "key-1" && secret === "s3cret" ? { orgId: "org-1", keyId: "key-1", plan: "institution" } : null,
  });

  const response = await get(app, "/v1/skeletons", { authorization: "ApiKey key-1.s3cret" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test("a token this service could not CHECK is 503, never 401", async () => {
  const app = makeApp({
    verifyToken: async () => ({
      ok: false as const,
      failure: { kind: "upstream" as const, detail: "getaddrinfo ENOTFOUND supabase" },
    }),
  });
  const response = await get(app, "/v1/skeletons", authed());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
});

// ── Full list ────────────────────────────────────────────────────────────────

test("the full list returns the envelope with every entry", async () => {
  const response = await get(makeApp(), "/v1/skeletons", authed());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.request_id);
  assert.ok(Array.isArray(body.skeletons));
  assert.ok(body.skeletons.length > 100, "the real store has well over 100 entries");
  assert.equal(body.skeleton, undefined, "list mode must not also carry a singular 'skeleton' key");
});

test("the response carries a request id header", async () => {
  const response = await get(makeApp(), "/v1/skeletons", authed());
  assert.ok(response.headers.get("X-Request-Id"));
});

// ── Filtered list ────────────────────────────────────────────────────────────

test("?modality= filters the list to that modality only", async () => {
  const response = await get(makeApp(), "/v1/skeletons?modality=MRI", authed());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(body.skeletons.length > 0);
  for (const entry of body.skeletons) {
    assert.equal(entry.modality, "MRI");
  }
});

test("an unknown modality filters to an empty list, not an error", async () => {
  const response = await get(makeApp(), "/v1/skeletons?modality=Nuclear+Medicine", authed());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.skeletons, []);
});

test("each of the four Desktop-relevant modalities returns entries via the real endpoint", async () => {
  const app = makeApp();
  for (const modality of ["CT", "MRI", "X-ray", "Ultrasound"]) {
    const response = await get(app, `/v1/skeletons?modality=${encodeURIComponent(modality)}`, authed());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.skeletons.length > 0, `expected entries for ${modality}`);
  }
});

// ── Single lookup ────────────────────────────────────────────────────────────

test("modality + study_type returns a single skeleton, not a list", async () => {
  const app = makeApp();
  const list = await (await get(app, "/v1/skeletons?modality=CT", authed())).json();
  const known = list.skeletons[0];

  const response = await get(
    app,
    `/v1/skeletons?modality=CT&study_type=${encodeURIComponent(known.study_type)}`,
    authed(),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.skeletons, undefined, "single-lookup mode must not also carry a 'skeletons' list");
  assert.ok(body.skeleton);
  assert.equal(body.skeleton.study_type, known.study_type);
  assert.equal(body.skeleton.findings, known.findings);
});

test("a combo with no match returns skeleton: null, cleanly — not an error", async () => {
  const response = await get(
    makeApp(),
    "/v1/skeletons?modality=CT&study_type=Definitely+Not+A+Real+Study+Type",
    authed(),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.skeleton, null);
});

test("study_type without modality is a validation error", async () => {
  const response = await get(makeApp(), "/v1/skeletons?study_type=Knee", authed());
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "validation-error");
});

test("an absurdly long modality or study_type is a validation error", async () => {
  const app = makeApp();
  const longModality = await get(app, `/v1/skeletons?modality=${"C".repeat(65)}`, authed());
  assert.equal(longModality.status, 400);

  const longStudyType = await get(
    app,
    `/v1/skeletons?modality=CT&study_type=${"K".repeat(129)}`,
    authed(),
  );
  assert.equal(longStudyType.status, 400);
});

test("a service with broken configuration answers 503 for the skeleton list", async () => {
  const app = createApp({ configError: new Error("SUPABASE_URL missing") });

  const response = await get(app, "/v1/skeletons", authed());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
});
