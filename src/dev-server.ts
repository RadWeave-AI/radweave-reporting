/**
 * Local development server.
 *
 * Vercel does not use this file — see api/index.ts.
 *
 * Named dev-server.ts, NOT server.ts, on purpose: Vercel auto-detects a
 * `server.{ts,js,mjs,...}` in the project root or src/ that calls
 * `server.listen()` at module startup, and captures it as the deployed HTTP
 * server. That would silently compete with api/index.ts for the same traffic.
 * One deployable entry point, and it is api/index.ts.
 */

import { serve } from "@hono/node-server";

import { bootstrap } from "./bootstrap.ts";

const { app, config, configError } = bootstrap();

// Locally a misconfiguration should stop you immediately — there is a human
// watching the terminal, which is not true of a deployed function. The message
// is the same one /v1/ready would have reported.
if (configError) {
  console.error(`radweave-reporting cannot start: ${configError.message}`);
  process.exit(1);
}

serve({ fetch: app.fetch, port: config!.port }, (info) => {
  console.log(`radweave-reporting listening on http://localhost:${info.port}`);
});
