import assert from "node:assert/strict";
import test from "node:test";

import { ServiceError } from "../src/http/errors.ts";
import {
  SSE_PRELUDE,
  blockingResponse,
  respond,
  streamResponse,
  wantsStream,
} from "../src/http/transport.ts";
import { createFailingWorkflow, createStubWorkflow } from "../src/workflows/stub.ts";

const REQUEST_ID = "req-test-1";

function parseSse(body: string) {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return {
        event: eventLine!.slice("event:".length).trim(),
        data: JSON.parse(dataLine!.slice("data:".length).trim()),
      };
    });
}

// ── Accept negotiation ───────────────────────────────────────────────────────

test("wantsStream only matches text/event-stream", () => {
  assert.equal(wantsStream("text/event-stream"), true);
  assert.equal(wantsStream("text/event-stream; charset=utf-8"), true);
  assert.equal(wantsStream("application/json, text/event-stream"), true);
  assert.equal(wantsStream("application/json"), false);
  assert.equal(wantsStream("*/*"), false);
  assert.equal(wantsStream(undefined), false);
  assert.equal(wantsStream(null), false);
});

// ── One workflow, two transports ─────────────────────────────────────────────

test("the same workflow yields SSE for text/event-stream", async () => {
  const response = await respond(createStubWorkflow("checklist"), "text/event-stream", REQUEST_ID);

  assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
  assert.equal(response.headers.get("Cache-Control"), "no-cache, no-transform");
});

test("the same workflow yields one JSON body otherwise", async () => {
  const response = await respond(createStubWorkflow("checklist"), "application/json", REQUEST_ID);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.request_id, REQUEST_ID);
  assert.equal(body.mode, "checklist");
});

test("streamed deltas reassemble into exactly the blocking report", async () => {
  // The property that matters: a streaming client and a blocking client must
  // end up with identical text. This is what two divergent engines lose.
  const streamed = await streamResponse(createStubWorkflow("quick"), REQUEST_ID).text();
  const blocking = await (
    await blockingResponse(createStubWorkflow("quick"), REQUEST_ID)
  ).json();

  const frames = parseSse(streamed);
  const assembled = frames
    .filter((f) => f.event === "delta")
    .map((f) => f.data.t)
    .join("");

  assert.equal(assembled, blocking.report);
  assert.equal(frames.at(-1)!.event, "done");
  assert.equal(frames.at(-1)!.data.report, blocking.report);
});

test("the SSE response opens with the anti-buffering prelude", async () => {
  const body = await streamResponse(createStubWorkflow("comparison"), REQUEST_ID).text();

  assert.ok(body.startsWith(SSE_PRELUDE));
  assert.ok(SSE_PRELUDE.startsWith(":"), "the pad must be an SSE comment line");
});

test("a delta arrives before the done event", async () => {
  const frames = parseSse(
    await streamResponse(createStubWorkflow("template-guided"), REQUEST_ID).text(),
  );

  assert.equal(frames[0]!.event, "delta");
  assert.equal(frames.at(-1)!.event, "done");
});

// ── Mid-run failure in each transport ────────────────────────────────────────

test("a mid-run failure becomes an in-band error event when streaming", async () => {
  const workflow = createFailingWorkflow(
    new ServiceError("provider-error", "The model provider failed.", {}),
  );
  const frames = parseSse(await streamResponse(workflow, REQUEST_ID).text());

  assert.equal(frames.at(-1)!.event, "error");
  assert.equal(frames.at(-1)!.data.error, "provider-error");
  assert.equal(frames.at(-1)!.data.ok, false);
  assert.equal(frames.at(-1)!.data.request_id, REQUEST_ID);
});

test("the same failure becomes a real HTTP status when blocking", async () => {
  const workflow = createFailingWorkflow(
    new ServiceError("rate-limited", "Too many reports.", { retry_after_seconds: 30 }),
  );
  const response = await blockingResponse(workflow, REQUEST_ID);
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(body.error, "rate-limited");
  assert.equal(body.retry_after_seconds, 30);
});

test("a workflow that emits nothing is an internal error, not an empty 200", async () => {
  const response = await blockingResponse({ async run() {} }, REQUEST_ID);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, "internal-error");
});

test("a thrown (not emitted) failure still closes the stream with an error event", async () => {
  const workflow = {
    async run() {
      throw new ServiceError("timeout", "Upstream timed out.");
    },
  };
  const frames = parseSse(await streamResponse(workflow, REQUEST_ID).text());

  assert.equal(frames.at(-1)!.event, "error");
  assert.equal(frames.at(-1)!.data.error, "timeout");
});

test("an unexpected throw is not leaked to the caller", async () => {
  const workflow = {
    async run() {
      throw new Error("connection string postgres://user:password@host");
    },
  };
  const frames = parseSse(await streamResponse(workflow, REQUEST_ID).text());

  assert.equal(frames.at(-1)!.data.error, "internal-error");
  assert.doesNotMatch(JSON.stringify(frames.at(-1)!.data), /password/);
});
