import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CATEGORIES,
  ERROR_STATUS,
  ServiceError,
  errorEnvelope,
  statusFor,
} from "../src/http/errors.ts";

test("every declared category maps to a status", () => {
  for (const category of ERROR_CATEGORIES) {
    assert.equal(typeof ERROR_STATUS[category], "number", category);
  }
  assert.equal(Object.keys(ERROR_STATUS).length, ERROR_CATEGORIES.length);
});

test("the agreed status mapping is exact", () => {
  assert.equal(statusFor("validation-error"), 400);
  assert.equal(statusFor("unauthorized"), 401);
  assert.equal(statusFor("insufficient-credits"), 403);
  assert.equal(statusFor("upgrade-required"), 403);
  assert.equal(statusFor("not-found"), 404);
  assert.equal(statusFor("rate-limited"), 429);
  assert.equal(statusFor("aborted"), 499);
  assert.equal(statusFor("not-implemented"), 501);
  assert.equal(statusFor("provider-error"), 502);
  assert.equal(statusFor("timeout"), 504);
  assert.equal(statusFor("internal-error"), 500);
  assert.equal(statusFor("service-unavailable"), 503);
});

test("service-unavailable is 503, never 401 — it is our fault, not the caller's", () => {
  // An auth check this service could not complete reports through this
  // category. Mapping it to 401 tells an integrator their good credential is
  // bad, which is the failure this category exists to prevent.
  assert.equal(statusFor("service-unavailable"), 503);
  assert.notEqual(statusFor("service-unavailable"), statusFor("unauthorized"));
});

test("an envelope always carries ok:false, the category, a message and a request id", () => {
  const envelope = errorEnvelope("validation-error", "Bad body.", "req-9");

  assert.deepEqual(envelope, {
    ok: false,
    error: "validation-error",
    message: "Bad body.",
    request_id: "req-9",
  });
});

test("category-specific extras are merged in", () => {
  const envelope = errorEnvelope("rate-limited", "Slow down.", "req-9", {
    retry_after_seconds: 42,
  });

  assert.equal(envelope.retry_after_seconds, 42);
  assert.equal(envelope.error, "rate-limited");
});

test("extras can never overwrite the envelope's own fields", () => {
  const envelope = errorEnvelope("provider-error", "Real message.", "req-9", {
    // deliberately hostile input
    ok: true,
    error: "not-found",
    request_id: "spoofed",
  } as never);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, "provider-error");
  assert.equal(envelope.message, "Real message.");
  assert.equal(envelope.request_id, "req-9");
});

test("ServiceError carries its category and extras", () => {
  const err = new ServiceError("insufficient-credits", "Out of credits.", {
    credits_remaining: 0,
    credits_limit: 200,
  });

  assert.ok(err instanceof Error);
  assert.equal(err.category, "insufficient-credits");
  assert.equal(err.extras.credits_limit, 200);
});
