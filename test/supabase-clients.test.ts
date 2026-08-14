import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  assertAuthUid,
  createRlsUserClient,
  createServiceRoleClient,
  type SupabaseClientFactory,
} from "../src/supabase/clients.ts";

const CONFIG = {
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon-key",
  supabaseServiceRoleKey: "service-key",
  anthropicApiKey: "anthropic-key",
  voyageApiKey: "voyage-key",
  port: 8787,
};

function recordingFactory(record: { args?: unknown[] }): SupabaseClientFactory {
  return ((...args: unknown[]) => {
    record.args = args;
    return { auth: {} } as SupabaseClient;
  }) as SupabaseClientFactory;
}

test("service-role client uses only the service key and disables session state", () => {
  const record: { args?: unknown[] } = {};
  createServiceRoleClient(CONFIG, recordingFactory(record));
  assert.equal(record.args?.[0], CONFIG.supabaseUrl);
  assert.equal(record.args?.[1], CONFIG.supabaseServiceRoleKey);
  assert.deepEqual(record.args?.[2], {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

test("RLS user client attaches the verified access token to every Supabase request", () => {
  const record: { args?: unknown[] } = {};
  createRlsUserClient(CONFIG, "verified-jwt", recordingFactory(record));
  assert.equal(record.args?.[0], CONFIG.supabaseUrl);
  assert.equal(record.args?.[1], CONFIG.supabaseAnonKey);
  assert.deepEqual(record.args?.[2], {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer verified-jwt" } },
  });
});

test("RLS user client refuses an empty token", () => {
  assert.throws(() => createRlsUserClient(CONFIG, "  ", recordingFactory({})));
});

test("assertAuthUid accepts the expected authenticated user", async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  } as unknown as SupabaseClient;
  await assert.doesNotReject(assertAuthUid(client, "user-1"));
});

test("assertAuthUid rejects a missing or different authenticated user", async () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-2" } }, error: null }) },
  } as unknown as SupabaseClient;
  await assert.rejects(assertAuthUid(client, "user-1"), /did not resolve the expected auth\.uid/);
});
