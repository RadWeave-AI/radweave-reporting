/**
 * The one place this service is wired together.
 *
 * api/index.ts and src/dev-server.ts previously repeated the same four-line
 * wiring, so a fix to the auth path had to be made twice or it was made once
 * and looked fine locally. They now share this.
 *
 * Configuration failure does NOT crash the process. That was the original
 * design — "fail loudly at boot" — and the trouble with it is that a Vercel
 * function which throws at import time answers every request with an opaque
 * platform error. There is nothing to read: not which variable, not even that
 * the cause is configuration. It still fails loudly, and now it fails
 * legibly: the cause is logged once at boot, `/v1/health` answers 503, every
 * working route answers 503, and `/v1/ready` names the missing variable.
 */

import { createApp } from "./app.ts";
import { createSupabaseTokenVerifier } from "./auth/resolve-caller.ts";
import { loadConfig, type ServiceConfig } from "./config.ts";
import { buildReadinessReport } from "./health/readiness.ts";
import { getUserPlan } from "./lib/stripe/get-user-plan.ts";
import { listTemplateCatalog } from "./lib/templates/catalog-list.ts";
import { assertAuthUid, createRlsUserClient, createServiceRoleClient } from "./supabase/clients.ts";
import { createRealWorkflow } from "./workflows/real.ts";

export interface Bootstrapped {
  app: ReturnType<typeof createApp>;
  config: ServiceConfig | null;
  configError: Error | null;
}

export function bootstrap(env: NodeJS.ProcessEnv = process.env): Bootstrapped {
  let config: ServiceConfig | null = null;
  let serviceSupabase: ReturnType<typeof createServiceRoleClient> | null = null;
  let configError: Error | null = null;

  try {
    config = loadConfig(env);
    // Constructing this here rather than lazily is deliberate: createClient
    // rejects a malformed SUPABASE_URL, and catching that now turns a
    // mid-request 500 into a diagnosable 503 at every entry point.
    serviceSupabase = createServiceRoleClient(config);
  } catch (error) {
    config = null;
    serviceSupabase = null;
    configError = error instanceof Error ? error : new Error(String(error));
  }

  const diagnosticsKey = env.DIAGNOSTICS_KEY || undefined;
  const buildReadiness = () => buildReadinessReport({ config, configError, env });

  if (config === null || serviceSupabase === null) {
    console.error(
      "[radweave-reporting] configuration is incomplete — serving diagnostics only",
      { detail: configError?.message ?? "unknown configuration error" },
    );
    return {
      app: createApp({ configError, diagnosticsKey, buildReadiness }),
      config: null,
      configError,
    };
  }

  const supabase = serviceSupabase;
  const loadedConfig = config;
  return {
    app: createApp({
      verifyToken: createSupabaseTokenVerifier(config.supabaseUrl, config.supabaseAnonKey),
      resolvePlan: async (userId) => (await getUserPlan(userId, supabase)).plan,
      createWorkflow: (context) => createRealWorkflow(context, { serviceSupabase: supabase }),
      // The shared library is read service-role (it is global and has no
      // owner column); the caller's own templates are read through a client
      // carrying THEIR verified JWT, so the database enforces auth.uid()
      // itself. assertAuthUid fails closed if that client somehow resolves a
      // different user than the one the token authenticated.
      listTemplates: async ({ principal, modality }) => {
        const userClient = createRlsUserClient(loadedConfig, principal.accessToken);
        await assertAuthUid(userClient, principal.userId);
        return listTemplateCatalog(supabase, userClient, { id: principal.userId }, { modality });
      },
      diagnosticsKey,
      buildReadiness,
    }),
    config,
    configError: null,
  };
}
