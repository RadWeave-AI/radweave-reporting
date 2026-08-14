import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { createStubWorkflow } from "../src/workflows/stub.ts";
import { WORKFLOWS } from "../src/workflows/types.ts";

const TOKEN = "valid-access-token";

const app = createApp({
  verifyToken: async (token) =>
    token === TOKEN ? { id: "user-123", email: "radiologist@example.com" } : null,
  resolvePlan: async () => "pro",
  createWorkflow: ({ workflow }) => createStubWorkflow(workflow),
});

/** Smallest body that satisfies each workflow's required fields. */
const MINIMAL_BODY: Record<string, Record<string, unknown>> = {
  checklist: { modality: "MRI", body_region: "Knee", findings: "- Effusion." },
  quick: { modality: "MRI", body_region: "Knee", findings: "- Effusion." },
  comparison: { modality: "CT", body_region: "Chest", prior_date: "2026-01-04" },
  "my-template": { modality: "MRI", body_region: "Brain", user_template_text: "TEMPLATE" },
  "template-guided": {
    modality: "MRI",
    body_region: "Spine",
    findings: "- Disc bulge.",
    selected_template_id: "tpl-1",
  },
};

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

// ── Health ───────────────────────────────────────────────────────────────────

test("GET /v1/health needs no credential", async () => {
  const response = await app.request("/v1/health");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "radweave-reporting");
});

test("every response carries a request id header", async () => {
  const response = await app.request("/v1/health");
  assert.ok(response.headers.get("X-Request-Id"));
});

test("a caller-supplied X-Request-Id is echoed back for traceability", async () => {
  const response = await app.request("/v1/health", { headers: { "x-request-id": "trace-42" } });
  const body = await response.json();

  assert.equal(body.request_id, "trace-42");
  assert.equal(response.headers.get("X-Request-Id"), "trace-42");
});

// ── The five report endpoints ────────────────────────────────────────────────

for (const workflow of WORKFLOWS) {
  test(`POST /v1/reports/${workflow} uses the injected workflow for an authenticated caller`, async () => {
    const response = await post(`/v1/reports/${workflow}`, MINIMAL_BODY[workflow], authed());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, workflow);
    assert.equal(typeof body.report, "string");
    assert.ok("usage" in body && "credits" in body);
  });

  test(`POST /v1/reports/${workflow} rejects an unauthenticated caller`, async () => {
    const response = await post(`/v1/reports/${workflow}`, MINIMAL_BODY[workflow]);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error, "unauthorized");
    assert.equal(body.ok, false);
  });

  test(`POST /v1/reports/${workflow} streams when the caller asks for SSE`, async () => {
    const response = await post(
      `/v1/reports/${workflow}`,
      MINIMAL_BODY[workflow],
      authed({ accept: "text/event-stream" }),
    );

    assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    const text = await response.text();
    assert.match(text, /event: done/);
  });
}

test("all five workflows are routed (no silent 404)", async () => {
  for (const workflow of WORKFLOWS) {
    const response = await post(`/v1/reports/${workflow}`, MINIMAL_BODY[workflow], authed());
    assert.notEqual(response.status, 404, workflow);
  }
});

// ── Validation policy ────────────────────────────────────────────────────────

test("a PHI field is rejected by name, before any other check", async () => {
  const response = await post(
    "/v1/reports/checklist",
    { ...MINIMAL_BODY.checklist, patient_name: "Jane Doe", nonsense_field: 1 },
    authed(),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "validation-error");
  assert.deepEqual(body.prohibited_fields, ["patient_name"]);
  // The PHI check must win over the unknown-field check.
  assert.equal(body.unexpected_fields, undefined);
});

test("a caller may not assert whose report this is", async () => {
  const response = await post(
    "/v1/reports/checklist",
    { ...MINIMAL_BODY.checklist, user_id: "someone-else" },
    authed(),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body.prohibited_fields, ["user_id"]);
});

test("unknown fields are rejected rather than ignored", async () => {
  const response = await post(
    "/v1/reports/checklist",
    { ...MINIMAL_BODY.checklist, made_up: true },
    authed(),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body.unexpected_fields, ["made_up"]);
});

test("a field valid for one workflow is not valid for another", async () => {
  const response = await post(
    "/v1/reports/checklist",
    { ...MINIMAL_BODY.checklist, selected_template_id: "tpl-1" },
    authed(),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body.unexpected_fields, ["selected_template_id"]);
});

test("missing required fields are named", async () => {
  const response = await post("/v1/reports/comparison", { modality: "CT" }, authed());
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body.missing_fields, ["body_region", "prior_date"]);
});

test("invalid JSON is a validation error, not a crash", async () => {
  const response = await app.request("/v1/reports/checklist", {
    method: "POST",
    headers: { "content-type": "application/json", ...authed() },
    body: "{not json",
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "validation-error");
});

// ── Credits ──────────────────────────────────────────────────────────────────

test("GET /v1/credits requires a credential and reports the resolved plan", async () => {
  const unauthenticated = await app.request("/v1/credits");
  assert.equal(unauthenticated.status, 401);

  const response = await app.request("/v1/credits", { headers: authed() });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.plan, "pro");
  assert.equal(body.stub, true);
});

// ── Reserved surface ─────────────────────────────────────────────────────────

test("POST /v1/reviews/consultant is reserved, not routable work", async () => {
  const response = await post("/v1/reviews/consultant", {}, authed());
  const body = await response.json();

  assert.equal(response.status, 501);
  assert.equal(body.error, "not-implemented");
  // Reserved means claimed: it must not 404, or adding it later breaks v1.
  assert.notEqual(response.status, 404);
});

test("an unknown endpoint returns the same error envelope shape", async () => {
  const response = await app.request("/v1/nope", { method: "POST" });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, "not-found");
  assert.equal(typeof body.request_id, "string");
});

// Auth runs as prefix middleware, so it fires before routing decides the path
// does not exist. That ordering is deliberate: an unauthenticated caller must
// not be able to enumerate which report endpoints exist by diffing 401 vs 404.
test("an unauthenticated caller cannot enumerate report endpoints", async () => {
  const response = await app.request("/v1/reports/does-not-exist", { method: "POST" });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error, "unauthorized");
});

test("an authenticated caller does get 404 for an unknown report endpoint", async () => {
  const response = await post("/v1/reports/does-not-exist", {}, authed());
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "not-found");
});

// ── ApiKey scheme end-to-end ─────────────────────────────────────────────────

test("an API key caller is told the scheme is unavailable, not that they are unauthorized", async () => {
  const response = await post("/v1/reports/checklist", MINIMAL_BODY.checklist, {
    authorization: "ApiKey key123.somesecret",
  });
  const body = await response.json();

  assert.equal(response.status, 501);
  assert.equal(body.error, "not-implemented");
});
