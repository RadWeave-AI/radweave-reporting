import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ServiceConfig } from "../config.ts";

export type SupabaseClientFactory = typeof createClient;

export function createServiceRoleClient(
  config: ServiceConfig,
  clientFactory: SupabaseClientFactory = createClient,
): SupabaseClient {
  return clientFactory(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Builds a stateless PostgREST client whose every request carries the user's
 * verified Supabase JWT. Database functions and RLS policies therefore see
 * the real auth.uid(); no user id is accepted from the request body.
 */
export function createRlsUserClient(
  config: Pick<ServiceConfig, "supabaseUrl" | "supabaseAnonKey">,
  accessToken: string,
  clientFactory: SupabaseClientFactory = createClient,
): SupabaseClient {
  if (!accessToken.trim()) throw new Error("A verified Supabase access token is required.");

  return clientFactory(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Real auth check used by the My Template adapter before any RLS retrieval. */
export async function assertAuthUid(
  client: SupabaseClient,
  expectedUserId: string,
): Promise<void> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user || data.user.id !== expectedUserId) {
    throw new Error("Authenticated Supabase client did not resolve the expected auth.uid().");
  }
}
