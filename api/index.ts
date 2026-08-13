/**
 * Vercel entry point.
 *
 * vercel.json rewrites every path here, so Hono owns routing rather than the
 * filesystem. Node runtime (not Edge): the Anthropic SDK and the reporting
 * modules that land in the later mission expect Node.
 */

import { handle } from "hono/vercel";

import { createApp } from "../src/app.ts";
import { createSupabaseTokenVerifier } from "../src/auth/resolve-caller.ts";
import { loadConfig } from "../src/config.ts";

export const config = { runtime: "nodejs" };

const serviceConfig = loadConfig();

const app = createApp({
  verifyToken: createSupabaseTokenVerifier(
    serviceConfig.supabaseUrl,
    serviceConfig.supabaseAnonKey,
  ),
});

export default handle(app);
