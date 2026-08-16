/**
 * Vercel entry point.
 *
 * vercel.json rewrites every path here, so Hono owns routing rather than the
 * filesystem.
 *
 * The default export MUST be an object with a `fetch` method — Vercel's
 * documented "fetch Web Standard export" for Node.js functions in /api.
 *
 * Do NOT export a bare function here, and do NOT use `handle` from
 * hono/vercel. That adapter is `(app) => (req) => app.fetch(req)`: a bare
 * function taking a web Request. Vercel treats a bare default-exported
 * function as the Node-style `(req, res)` handler, calls it with
 * (IncomingMessage, ServerResponse), discards the Response it returns, and
 * never ends `res` — so every request hangs until the platform duration
 * limit. hono/vercel is for Next.js App Router / Edge, not for /api Node
 * functions. See test/vercel-entry.test.ts, which pins this shape.
 */

import { bootstrap } from "../src/bootstrap.ts";

// Wiring lives in src/bootstrap.ts so this entry and the dev server cannot
// drift apart. It never throws: a misconfigured deployment boots into a
// diagnostic-only mode rather than answering every request with an opaque
// platform crash.
const { app } = bootstrap();

export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
};
