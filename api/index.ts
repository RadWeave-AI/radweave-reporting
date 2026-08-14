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

import { createApp } from "../src/app.ts";
import { createSupabaseTokenVerifier } from "../src/auth/resolve-caller.ts";
import { loadConfig } from "../src/config.ts";
import { getUserPlan } from "../src/lib/stripe/get-user-plan.ts";
import { createServiceRoleClient } from "../src/supabase/clients.ts";
import { createRealWorkflow } from "../src/workflows/real.ts";

const serviceConfig = loadConfig();
const serviceSupabase = createServiceRoleClient(serviceConfig);

const app = createApp({
  verifyToken: createSupabaseTokenVerifier(
    serviceConfig.supabaseUrl,
    serviceConfig.supabaseAnonKey,
  ),
  resolvePlan: async (userId) => (await getUserPlan(userId, serviceSupabase)).plan,
  createWorkflow: (context) => createRealWorkflow(context, { serviceSupabase }),
});

export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
};
