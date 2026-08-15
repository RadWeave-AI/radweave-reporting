import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

const COMPLETE_ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  ANTHROPIC_API_KEY: "anthropic",
  VOYAGE_API_KEY: "voyage",
  PORT: "9000",
};

test("loadConfig returns every real-generation secret from the process environment", () => {
  assert.deepEqual(loadConfig(COMPLETE_ENV), {
    supabaseUrl: COMPLETE_ENV.SUPABASE_URL,
    supabaseAnonKey: COMPLETE_ENV.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: COMPLETE_ENV.SUPABASE_SERVICE_ROLE_KEY,
    anthropicApiKey: COMPLETE_ENV.ANTHROPIC_API_KEY,
    voyageApiKey: COMPLETE_ENV.VOYAGE_API_KEY,
    port: 9000,
  });
});

for (const name of [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
] as const) {
  test(`loadConfig fails loudly when ${name} is absent`, () => {
    const env = { ...COMPLETE_ENV } as Record<string, string | undefined>;
    delete env[name];
    assert.throws(() => loadConfig(env), new ConfigError(`Missing required environment variable: ${name}`));
  });
}

test("loadConfig permits VOYAGE_API_KEY to be absent", () => {
  const env = { ...COMPLETE_ENV } as Record<string, string | undefined>;
  delete env.VOYAGE_API_KEY;
  assert.equal(loadConfig(env).voyageApiKey, undefined);
});

test("service config has no .env.local filesystem fallback", async () => {
  const source = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s+.*node:fs|readFileSync\s*\(|function\s+readEnvLocal/m);
});
