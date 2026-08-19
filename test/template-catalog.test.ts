/**
 * Template catalogue: entitlement, isolation, and response hygiene.
 *
 * These tests exist mainly to catch the removal of a safety property. Each one
 * names the property it protects; if a change makes one fail, the question is
 * whether that property is still meant to hold — not how to make the assertion
 * pass.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { listTemplateCatalog } from "../src/lib/templates/catalog-list.ts";

const SHARED_NORMAL = {
  id: "tpl-normal-1",
  file_name: "Normal CT chest",
  modality: "Normal CT",
  body_region: "Chest",
  pathology_category: "Normal",
  pathology_name: null,
  findings_text: "The lungs are clear with no focal consolidation seen.",
  opinion_text: "No acute abnormality.",
  full_text: null,
  is_normal: true,
};

const SHARED_PATHOLOGY = {
  id: "tpl-path-1",
  file_name: "CT chest pulmonary embolism",
  modality: "CT",
  body_region: "Chest",
  pathology_category: "Vascular",
  pathology_name: "Pulmonary embolism",
  findings_text: "Filling defect within the right main pulmonary artery is seen.",
  opinion_text: "Acute pulmonary embolism.",
  full_text: null,
  is_normal: false,
};

const OWN_TEMPLATE = {
  id: "own-1",
  title: "My CT abdomen",
  modality: "CT",
  body_region: "Abdomen",
  study_type: "Abdomen and pelvis",
  findings_text: "The liver is normal in size and contour throughout.",
  conclusion_text: "Unremarkable study.",
  is_favorite: true,
  updated_at: "2026-08-01T00:00:00Z",
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getUserPlan: async () => ({ plan: "pro" }) as never,
    canUseFeature: async () => true,
    fetchSharedTemplates: async () => [SHARED_NORMAL, SHARED_PATHOLOGY],
    fetchUserTemplates: async () => [OWN_TEMPLATE],
    ...overrides,
  } as never;
}

const CLIENT = {} as never;

// ── Entitlement ──────────────────────────────────────────────────────────────

test("without the pathology feature only normal shared templates are returned", async () => {
  const result = await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({ canUseFeature: async () => false }),
  );

  const shared = result.templates.filter((t) => t.category === "radweave");
  assert.deepEqual(shared.map((t) => t.id), ["tpl-normal-1"]);
  assert.equal(result.counts.radweave, 1);
});

test("with the pathology feature both normal and pathology templates are returned", async () => {
  const result = await listTemplateCatalog(CLIENT, CLIENT, { id: "user-1" }, {}, deps());

  const shared = result.templates.filter((t) => t.category === "radweave");
  assert.deepEqual(shared.map((t) => t.id).sort(), ["tpl-normal-1", "tpl-path-1"]);
});

test("an account's OWN templates are never gated by the pathology feature", async () => {
  // Own data is not a paid catalogue. Gating it would hide the user's own work.
  const result = await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({ canUseFeature: async () => false }),
  );

  assert.deepEqual(
    result.templates.filter((t) => t.category === "user").map((t) => t.id),
    ["own-1"],
  );
});

// ── Isolation ────────────────────────────────────────────────────────────────

test("user templates are fetched for the verified principal's id only", async () => {
  // The identity that reaches the query must be the one from the credential.
  const seen: string[] = [];
  await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({
      fetchUserTemplates: async (userId: string) => {
        seen.push(userId);
        return [OWN_TEMPLATE];
      },
    }),
  );

  assert.deepEqual(seen, ["user-1"]);
});

test("entitlement is resolved for the verified principal's id only", async () => {
  const planFor: string[] = [];
  const featureFor: string[] = [];
  await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({
      getUserPlan: async (userId: string) => {
        planFor.push(userId);
        return { plan: "free" } as never;
      },
      canUseFeature: async (userId: string) => {
        featureFor.push(userId);
        return false;
      },
    }),
  );

  assert.deepEqual(planFor, ["user-1"]);
  assert.deepEqual(featureFor, ["user-1"]);
});

// ── Response hygiene ─────────────────────────────────────────────────────────

test("modality is never null — a row without one is dropped, not emitted", async () => {
  // A null modality makes RadWeave Desktop reject the WHOLE list, stranding it
  // on a stale offline catalogue. Losing one row beats losing all of them.
  const result = await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({
      fetchSharedTemplates: async () => [SHARED_NORMAL, { ...SHARED_PATHOLOGY, modality: null }],
      fetchUserTemplates: async () => [{ ...OWN_TEMPLATE, modality: "   " }],
    }),
  );

  assert.equal(result.templates.length, 1);
  assert.equal(result.counts.user, 0);
  for (const template of result.templates) {
    assert.equal(typeof template.modality, "string");
    assert.ok(template.modality.trim().length > 0);
  }
});

test("templates with no usable body text are dropped", async () => {
  const result = await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({
      fetchSharedTemplates: async () => [{ ...SHARED_NORMAL, findings_text: "tiny", opinion_text: null }],
      fetchUserTemplates: async () => [],
    }),
  );

  assert.equal(result.templates.length, 0);
});

test("every returned template carries a real id and an allowlisted field set", async () => {
  const result = await listTemplateCatalog(CLIENT, CLIENT, { id: "user-1" }, {}, deps());

  const allowed = [
    "id", "category", "name", "modality", "body_region", "study_type", "is_normal", "body",
  ].sort();
  for (const template of result.templates) {
    assert.ok(template.id.length > 0);
    assert.deepEqual(Object.keys(template).sort(), allowed);
    // No owner, timestamp, or account field may ride along.
    assert.equal((template as unknown as Record<string, unknown>).user_id, undefined);
  }
});

test("shared full_text wins over composed findings, and own templates compose", async () => {
  const result = await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({
      fetchSharedTemplates: async () => [{ ...SHARED_NORMAL, full_text: "FULL TEXT OF THE TEMPLATE BODY." }],
    }),
  );

  const shared = result.templates.find((t) => t.category === "radweave");
  assert.equal(shared?.body, "FULL TEXT OF THE TEMPLATE BODY.");

  const own = result.templates.find((t) => t.category === "user");
  assert.match(own!.body, /^The liver is normal/);
  assert.match(own!.body, /OPINION:\nUnremarkable study\.$/);
});

test("an uploaded template is never claimed to be a normal template", async () => {
  // user_report_templates has no normal/pathology column; asserting "normal"
  // would misrepresent the radiologist's own template.
  const result = await listTemplateCatalog(CLIENT, CLIENT, { id: "user-1" }, {}, deps());

  assert.equal(result.templates.find((t) => t.category === "user")?.is_normal, false);
});

test("the modality filter is passed through to both sources", async () => {
  const seen: Array<string | undefined> = [];
  await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, { modality: "  CT  " },
    deps({
      fetchSharedTemplates: async (m?: string) => { seen.push(m); return []; },
      fetchUserTemplates: async (_id: string, m?: string) => { seen.push(m); return []; },
    }),
  );

  assert.deepEqual(seen, ["CT", "CT"]);
});

test("counts match the templates actually returned", async () => {
  const result = await listTemplateCatalog(
    CLIENT, CLIENT, { id: "user-1" }, {},
    deps({ canUseFeature: async () => false }),
  );

  assert.equal(
    result.counts.radweave,
    result.templates.filter((t) => t.category === "radweave").length,
  );
  assert.equal(
    result.counts.user,
    result.templates.filter((t) => t.category === "user").length,
  );
});

// ── Real query shape (defaultFetchSharedTemplates, not the injected mock) ───

/** Minimal chainable/thenable fake mirroring the supabase-js query builder. */
function fakeSharedTemplatesClient(recorder: string[]) {
  const chain: Record<string, (...args: unknown[]) => unknown> = {
    from: (table) => { recorder.push(`from:${table}`); return builder; },
    select: (cols) => { recorder.push(`select:${cols}`); return builder; },
    eq: (col, val) => { recorder.push(`eq:${col}=${val}`); return builder; },
    is: (col, val) => { recorder.push(`is:${col}=${val}`); return builder; },
    or: (expr) => { recorder.push(`or:${expr}`); return builder; },
    neq: (col, val) => { recorder.push(`neq:${col}=${val}`); return builder; },
    in: (col, vals) => { recorder.push(`in:${col}=${JSON.stringify(vals)}`); return builder; },
    limit: (n) => { recorder.push(`limit:${n}`); return builder; },
  };
  // then() has its own, differently-shaped signature -- kept off the
  // Record<string, (...args: unknown[]) => unknown> type above so it doesn't
  // have to lie about its parameter type.
  const builder = {
    ...chain,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
  };
  return builder as never;
}

test("the real shared-template query excludes body_region = PET CT, matching the website's own browsing convention", async () => {
  // A live query the website itself makes at 4+ call sites (folders/route.ts,
  // seed_template_samples.sql, the 20260721000001 migration): PET/CT hybrid
  // rows are filed under an ordinary modality but excluded from modality-
  // folder browsing everywhere. This endpoint is Desktop's only source for
  // that same browsing surface and must apply the identical exclusion.
  const calls: string[] = [];
  const fakeClient = fakeSharedTemplatesClient(calls);

  await listTemplateCatalog(
    fakeClient, CLIENT, { id: "user-1" }, {},
    deps({ fetchSharedTemplates: undefined, fetchUserTemplates: async () => [] }),
  );

  assert.ok(
    calls.includes("neq:body_region=PET CT"),
    `expected a .neq("body_region", "PET CT") call, got: ${calls.join(", ")}`,
  );
});
