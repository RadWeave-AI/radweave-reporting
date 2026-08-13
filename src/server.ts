/**
 * Local development server.
 *
 * Vercel does not use this file — see api/index.ts. This exists so the service
 * can be run and exercised locally with the same app instance.
 */

import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { createSupabaseTokenVerifier } from "./auth/resolve-caller.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();

const app = createApp({
  verifyToken: createSupabaseTokenVerifier(config.supabaseUrl, config.supabaseAnonKey),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`radweave-reporting listening on http://localhost:${info.port}`);
});
