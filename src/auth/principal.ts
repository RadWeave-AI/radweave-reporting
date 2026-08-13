/**
 * Who is calling, as resolved by the service itself.
 *
 * The single most important rule in this file: a Principal is derived ONLY
 * from a verified credential. It is never built from anything in the request
 * body. A caller cannot name the user it is acting for — that is what stops
 * the website (or any other client) from becoming a confused deputy.
 */

/** An end user: the website acting server-side on a user's behalf, or Desktop. */
export interface UserPrincipal {
  kind: "user";
  userId: string;
  email: string | null;
  /** Subscription plan. Resolved from Supabase once the real plan lookup lands. */
  plan: string;
  /**
   * The caller's own access token, retained so the service can build an
   * RLS-scoped Supabase client for workflows that need `auth.uid()` to
   * resolve — My Template's template-embedding retrieval is the one that
   * genuinely requires it.
   */
  accessToken: string;
}

/** A hospital / institutional API customer authenticating with an issued key. */
export interface OrgPrincipal {
  kind: "org";
  orgId: string;
  keyId: string;
  plan: string;
}

export type Principal = UserPrincipal | OrgPrincipal;

export type AuthFailureReason =
  | "missing-credential"
  | "malformed-credential"
  | "invalid-credential"
  | "unsupported-scheme"
  | "not-implemented";

export interface AuthFailure {
  ok: false;
  reason: AuthFailureReason;
  message: string;
}

export interface AuthSuccess {
  ok: true;
  principal: Principal;
}

export type AuthResult = AuthSuccess | AuthFailure;

export function authFailure(reason: AuthFailureReason, message: string): AuthFailure {
  return { ok: false, reason, message };
}
