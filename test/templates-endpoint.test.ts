/**
 * GET /v1/templates — auth, envelope, and error classification at the HTTP edge.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import type { TemplateCatalogResult } from "../src/lib/templates/catalog-list.ts";

const TOKEN = "valid-access-token";

const CATALOG: TemplateCatalogResult = {
  counts: { radweave: 1, user: 1 },
  templates: [
    {
      id: "tpl-1", category: "radweave", name: "Normal CT chest", modality: "Normal CT",
      body_region: "Chest", study_type: null, is_normal: true,
      body: "The lungs are clear with no focal consolidation.",
    },
    {
      id: "own-1", category: "user", name: "My CT abdomen", modality: "CT",
      body_region: "Abdomen", study_type: "Abdomen and pelvis", is_normal: false,
      body: "The liver is normal in size and contour.",
    },
  ],
};

function makeApp(overrides: Record<string, unknown> = {}) {
  return createApp({
    verifyToken: async (token) =>
      token === TOKEN ? { id: "user-123", email: "radiologist@example.com" } : null,
    resolvePlan: async () => "pro",
    listTemplates: async () => CATALOG,
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

test("the catalogue requires a credential", async () => {
  const response = await get(makeApp(), "/v1/templates");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error, "unauthorized");
});

test("an invalid token is rejected", async () => {
  const response = await get(makeApp(), "/v1/templates", { authorization: "Bearer nope" });

  assert.equal(response.status, 401);
});

test("a token this service could not CHECK is 503, never 401", async () => {
  // A caller whose token we could not verify has done nothing wrong; telling
  // them their credential is bad sends them to debug the wrong thing.
  const app = makeApp({
    verifyToken: async () => ({
      ok: false as const,
      failure: { kind: "upstream" as const, detail: "getaddrinfo ENOTFOUND supabase" },
    }),
  });
  const response = await get(app, "/v1/templates", authed());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
  // The upstream detail is logged, never returned.
  assert.doesNotMatch(JSON.stringify(body), /ENOTFOUND/);
});

test("identity comes from the token — a user_id query parameter is ignored", async () => {
  const seen: string[] = [];
  const app = makeApp({
    listTemplates: async ({ principal }: { principal: { userId: string } }) => {
      seen.push(principal.userId);
      return CATALOG;
    },
  });

  const response = await get(app, "/v1/templates?user_id=someone-else", authed());

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["user-123"]);
});

// ── Success envelope ─────────────────────────────────────────────────────────

test("a successful read returns the service envelope with counts and templates", async () => {
  const response = await get(makeApp(), "/v1/templates", authed());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.request_id);
  assert.deepEqual(body.counts, { radweave: 1, user: 1 });
  assert.equal(body.templates.length, 2);
  assert.equal(body.templates[0].id, "tpl-1");
});

test("the response carries a request id header", async () => {
  const response = await get(makeApp(), "/v1/templates", authed());

  assert.ok(response.headers.get("X-Request-Id"));
});

test("the modality filter reaches the catalogue", async () => {
  const seen: Array<string | undefined> = [];
  const app = makeApp({
    listTemplates: async ({ modality }: { modality?: string }) => {
      seen.push(modality);
      return CATALOG;
    },
  });

  await get(app, "/v1/templates?modality=CT", authed());
  await get(app, "/v1/templates", authed());
  await get(app, "/v1/templates?modality=%20%20", authed());

  assert.deepEqual(seen, ["CT", undefined, undefined]);
});

test("an absurdly long modality is a validation error, not a database round trip", async () => {
  let called = false;
  const app = makeApp({
    listTemplates: async () => {
      called = true;
      return CATALOG;
    },
  });

  const response = await get(app, `/v1/templates?modality=${"C".repeat(65)}`, authed());
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "validation-error");
  assert.equal(called, false);
});

// ── Failure classification ───────────────────────────────────────────────────

test("a lookup failure is provider-error and never leaks the underlying message", async () => {
  const app = makeApp({
    listTemplates: async () => {
      throw new Error("relation \"templates\" does not exist at line 42");
    },
  });

  const response = await get(app, "/v1/templates", authed());
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error, "provider-error");
  assert.equal(body.message, "Templates could not be loaded.");
  assert.doesNotMatch(JSON.stringify(body), /relation|line 42/);
});

test("an unconfigured catalogue says so instead of returning an empty list", async () => {
  // An empty catalogue and a broken deployment must not look identical.
  const app = makeApp({ listTemplates: undefined });

  const response = await get(app, "/v1/templates", authed());
  const body = await response.json();

  assert.equal(response.status, 501);
  assert.equal(body.error, "not-implemented");
});

test("an org credential is told the catalogue is user-only", async () => {
  const app = createApp({
    resolveApiKey: async () => ({ orgId: "org-1", keyId: "key-1", plan: "institution" }),
    listTemplates: async () => CATALOG,
  });

  const response = await get(app, "/v1/templates", { authorization: "Bearer rw_live_key" });
  const body = await response.json();

  assert.equal(response.status, 501);
  assert.equal(body.error, "not-implemented");
});

test("a service with broken configuration answers 503 for the catalogue", async () => {
  const app = createApp({ configError: new Error("SUPABASE_URL missing") });

  const response = await get(app, "/v1/templates", authed());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "service-unavailable");
  assert.doesNotMatch(JSON.stringify(body), /SUPABASE_URL/);
});
