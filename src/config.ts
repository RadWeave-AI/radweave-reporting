/**
 * Service configuration.
 *
 * Deliberately explicit: unlike the website, this service does NOT read
 * .env.local off process.cwd() as a fallback (the website's readEnvLocal
 * helper). Configuration comes from the environment or it does not come at
 * all, rather than being silently resolved from a file that may or may not
 * have been deployed.
 *
 * `loadConfig` still throws on the first missing variable, and that has not
 * changed. What changed is who catches it. This module originally aimed to
 * "fail loudly at boot", and on Vercel that turned out to mean the opposite of
 * loud: a function throwing at module scope answers every request with an
 * opaque FUNCTION_INVOCATION_FAILED naming no variable, no cause, not even
 * configuration as the category. Three separate multi-hour debugging cycles
 * went into decoding that silence.
 *
 * So src/bootstrap.ts catches this error and starts the service in a degraded
 * state instead: the cause is logged once at boot, /v1/health answers 503
 * rather than a misleading 200, every working route answers 503, and
 * /v1/ready names the exact variable that is missing. Loud, and legible.
 */

export interface ServiceConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  anthropicApiKey: string;
  voyageApiKey?: string;
  port: number;
}

export class ConfigError extends Error {}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    supabaseUrl: required("SUPABASE_URL", env),
    supabaseAnonKey: required("SUPABASE_ANON_KEY", env),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", env),
    anthropicApiKey: required("ANTHROPIC_API_KEY", env),
    voyageApiKey: env.VOYAGE_API_KEY || undefined,
    port: Number(env.PORT ?? 8787),
  };
}

let cachedConfig: ServiceConfig | null = null;

/** Shared lazy config for copied modules; still fails loudly on first use. */
export function getServiceConfig(): ServiceConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}
