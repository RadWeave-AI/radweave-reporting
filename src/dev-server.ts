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

import { createApp } from "./app.ts";
import { createSupabaseTokenVerifier } from "./auth/resolve-caller.ts";
import { loadConfig } from "./config.ts";
import { getUserPlan } from "./lib/stripe/get-user-plan.ts";
import { createServiceRoleClient } from "./supabase/clients.ts";
import { createRealWorkflow } from "./workflows/real.ts";

const config = loadConfig();
const serviceSupabase = createServiceRoleClient(config);

const app = createApp({
  verifyToken: createSupabaseTokenVerifier(config.supabaseUrl, config.supabaseAnonKey),
  resolvePlan: async (userId) => (await getUserPlan(userId, serviceSupabase)).plan,
  createWorkflow: (context) => createRealWorkflow(context, { serviceSupabase }),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`radweave-reporting listening on http://localhost:${info.port}`);
});
