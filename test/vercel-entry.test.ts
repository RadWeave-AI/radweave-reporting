/**
 * Regression tests for the Vercel entry point's EXPORT SHAPE.
 *
 * The first deployment of this service hung on every request for the full
 * platform duration limit. Cause: api/index.ts exported a bare function
 * (`handle(app)` from hono/vercel, i.e. `(req: Request) => Response`).
 * Vercel's Node.js runtime treats a bare default-exported function as the
 * Node-style `(req, res)` handler, calls it with (IncomingMessage,
 * ServerResponse), throws away the returned Response, and never ends `res`.
 * The socket stayed open until the function timed out.
 *
 * Nothing in the previous test suite could catch that — every test drove the
 * Hono app directly and never looked at what api/index.ts exports. These do.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// api/index.ts calls loadConfig() at module scope, so configuration has to
// exist before the import. Values are syntactically valid but unreachable —
// nothing here makes a network call.
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "test-anon-key";

const entry = await import("../api/index.ts");

test("the default export is an object, not a bare function", () => {
  // A bare function is what Vercel misreads as a Node-style (req, res)
  // handler. This assertion is the whole point of the file.
  assert.notEqual(
    typeof entry.default,
    "function",
    "a bare default-exported function is invoked as (req, res) and will hang",
  );
  assert.equal(typeof entry.default, "object");
});

test("the default export exposes a fetch method (Vercel's Web Standard export)", () => {
  assert.equal(typeof entry.default.fetch, "function");
});

test("fetch takes a web Request and resolves to a real Response", async () => {
  const response = await entry.default.fetch(
    new Request("https://service.test/v1/health"),
  );

  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "radweave-reporting");
});

test("the entry routes the full surface, not just health", async () => {
  const response = await entry.default.fetch(
    new Request("https://service.test/v1/reports/checklist", { method: "POST" }),
  );

  // Unauthenticated, so 401 — the point is that it reached the app and
  // produced a response rather than hanging.
  assert.equal(response.status, 401);
});

test("api/index.ts does not import hono/vercel", async () => {
  const source = await readFile(new URL("../api/index.ts", import.meta.url), "utf8");

  // hono/vercel's handle() is for Next.js App Router / Edge. In an /api Node
  // function it produces exactly the hang described above.
  assert.doesNotMatch(
    source,
    /^\s*import\s+.*from\s+["']hono\/vercel["']/m,
    "hono/vercel's handle() returns a bare function and will hang on Vercel's Node runtime",
  );
});

test("no server.ts exists in the project root or src/ to compete for traffic", async () => {
  // Vercel captures a root- or src-level server.{ts,js,...} that calls
  // server.listen() at startup and deploys it as THE server, which would
  // silently compete with api/index.ts. The dev server is dev-server.ts.
  for (const candidate of ["../server.ts", "../src/server.ts"]) {
    await assert.rejects(
      readFile(new URL(candidate, import.meta.url)),
      /ENOENT/,
      `${candidate} would be auto-detected by Vercel as the deployed server`,
    );
  }
});
