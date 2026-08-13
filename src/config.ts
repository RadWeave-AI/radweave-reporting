/**
 * Service configuration.
 *
 * Deliberately explicit: unlike the website, this service does NOT read
 * .env.local off process.cwd() as a fallback (the website's readEnvLocal
 * helper). A standalone service should fail loudly at boot on missing
 * configuration rather than silently resolve it from a file that may or may
 * not have been deployed.
 */

export interface ServiceConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
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
    port: Number(env.PORT ?? 8787),
  };
}
