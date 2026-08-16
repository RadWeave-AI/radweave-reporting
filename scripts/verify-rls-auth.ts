import { createClient } from "@supabase/supabase-js";

import { authErrorDetail } from "../src/auth/auth-error.ts";
import { loadConfig } from "../src/config.ts";
import {
  assertAuthUid,
  createRlsUserClient,
  createServiceRoleClient,
} from "../src/supabase/clients.ts";

const config = loadConfig();
const admin = createServiceRoleClient(config);
const nonce = crypto.randomUUID();
const email = `radweave-reporting-rls-${nonce}@example.com`;
const password = `${crypto.randomUUID()}Aa1!`;
const foreignEmail = `radweave-reporting-rls-foreign-${nonce}@example.com`;
const foreignPassword = `${crypto.randomUUID()}Bb2!`;
const ownTemplateId = crypto.randomUUID();
const foreignTemplateId = crypto.randomUUID();
const queryVector = `[${[1, ...Array<number>(1023).fill(0)].join(",")}]`;

let userId: string | null = null;
let foreignUserId: string | null = null;
let fixturesCreated = false;
let verified = false;

// authErrorDetail moved to src/auth/auth-error.ts: the service's auth path now
// formats errors the same way this script always has, and one pattern is
// easier to read across logs than two.

try {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`Temporary auth user creation failed: ${authErrorDetail(created.error)}`);
  }
  userId = created.data.user.id;

  const foreignCreated = await admin.auth.admin.createUser({
    email: foreignEmail,
    password: foreignPassword,
    email_confirm: true,
  });
  if (foreignCreated.error || !foreignCreated.data.user) {
    throw new Error(`Foreign temporary auth user creation failed: ${authErrorDetail(foreignCreated.error)}`);
  }
  foreignUserId = foreignCreated.data.user.id;

  // Non-clinical sentinels for the exact My Template retrieval RPC. Both are
  // removed below; no patient or fabricated report content is stored.
  const templateInsert = await admin.from("user_report_templates").insert([
    { id: ownTemplateId, user_id: userId, title: "__RLS_AUTH_TEST_OWN__", findings_text: "" },
    { id: foreignTemplateId, user_id: foreignUserId, title: "__RLS_AUTH_TEST_FOREIGN__", findings_text: "" },
  ]);
  if (templateInsert.error) throw new Error(`Temporary template fixture failed: ${templateInsert.error.message}`);

  const embeddingInsert = await admin.from("user_report_template_embeddings").insert([
    { user_template_id: ownTemplateId, user_id: userId, embedding: queryVector, model: "voyage-4", content_hash: nonce },
    { user_template_id: foreignTemplateId, user_id: foreignUserId, embedding: queryVector, model: "voyage-4", content_hash: nonce },
  ]);
  if (embeddingInsert.error) throw new Error(`Temporary embedding fixture failed: ${embeddingInsert.error.message}`);
  fixturesCreated = true;

  const signInClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await signInClient.auth.signInWithPassword({ email, password });
  const accessToken = signedIn.data.session?.access_token;
  if (signedIn.error || !accessToken) {
    throw new Error(`Temporary auth sign-in failed: ${authErrorDetail(signedIn.error)}`);
  }

  const rlsClient = createRlsUserClient(config, accessToken);
  await assertAuthUid(rlsClient, userId);

  const matched = await rlsClient.rpc("match_user_template_embeddings", {
    query_embedding: queryVector,
    match_count: 10,
    exclude_template_id: null,
    model_name: "voyage-4",
  });
  if (matched.error) throw new Error(`RLS retrieval RPC failed: ${matched.error.message}`);
  const ids = (matched.data ?? []).map((row) => row.user_template_id as string);
  if (!ids.includes(ownTemplateId)) {
    throw new Error("auth.uid() did not expose the authenticated user's own retrieval fixture.");
  }
  if (ids.includes(foreignTemplateId)) {
    throw new Error("auth.uid() exposed another user's retrieval fixture.");
  }

  verified = true;
} finally {
  const cleanupErrors: string[] = [];
  if (fixturesCreated) {
    const embeddingCleanup = await admin
      .from("user_report_template_embeddings")
      .delete()
      .in("user_template_id", [ownTemplateId, foreignTemplateId]);
    if (embeddingCleanup.error) cleanupErrors.push(`embeddings: ${embeddingCleanup.error.message}`);
    const templateCleanup = await admin
      .from("user_report_templates")
      .delete()
      .in("id", [ownTemplateId, foreignTemplateId]);
    if (templateCleanup.error) cleanupErrors.push(`templates: ${templateCleanup.error.message}`);
  }
  if (userId) {
    const cleanup = await admin.auth.admin.deleteUser(userId);
    if (cleanup.error) cleanupErrors.push(`own auth user: ${cleanup.error.message}`);
  }
  if (foreignUserId) {
    const cleanup = await admin.auth.admin.deleteUser(foreignUserId);
    if (cleanup.error) cleanupErrors.push(`foreign auth user: ${cleanup.error.message}`);
  }
  if (cleanupErrors.length > 0) throw new Error(`RLS test cleanup failed (${cleanupErrors.join("; ")})`);
}

console.log(JSON.stringify({
  ok: verified,
  auth_uid_resolved: verified,
  own_template_visible: verified,
  foreign_template_denied: verified,
  cleanup_complete: true,
}));
