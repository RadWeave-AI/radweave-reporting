/**
 * Turning an opaque authentication failure into something actionable.
 *
 * Three separate multi-hour debugging cycles were spent on this service
 * because `getUser(token)` failing produced exactly one output — `null` — and
 * the caller was told "the supplied access token is not valid." At least five
 * genuinely different failures collapse into that sentence:
 *
 *   1. the request never reached Supabase at all (bad host, blocked egress)
 *   2. Supabase rejected OUR anon key (rotated, wrong project)
 *   3. Supabase rejected the CALLER's token (bad signature, foreign issuer)
 *   4. the token is not a JWT
 *   5. the token is genuinely expired
 *
 * 1 and 2 are faults in this service. Reporting them as 401 blames the caller
 * for our own misconfiguration — a hospital integrator would lose a day to it.
 * This module is what tells them apart.
 *
 * `authErrorDetail` is deliberately the same helper scripts/verify-rls-auth.ts
 * already used; it lives here now so there is one formatting pattern for auth
 * errors across the service and its scripts, not two.
 */

import { Buffer } from "node:buffer";

/**
 * How a token verification failed, in the only three ways that change what the
 * caller should DO about it.
 *
 * - `expired`  — the credential was fine, it is simply old. Get a new one.
 * - `invalid`  — the credential is not acceptable. Nothing to retry.
 * - `upstream` — we could not verify it. Nothing is wrong with the credential;
 *                the fault is this service's or its network's.
 */
export type TokenFailureKind = "expired" | "invalid" | "upstream";

export interface TokenFailure {
  kind: TokenFailureKind;
  /**
   * Everything known about the underlying error, for the server log ONLY.
   * This must never reach a caller: an unauthenticated party learning that our
   * anon key was rejected, or which host failed to resolve, is a disclosure we
   * get nothing for.
   */
  detail: string;
}

/** auth-js raises these when the HTTP exchange itself did not complete. */
const UPSTREAM_ERROR_NAMES = new Set([
  // fetch threw, or Supabase answered 5xx — _handleRequest wraps both.
  "AuthRetryableFetchError",
  // a non-JSON body, i.e. something in front of Supabase answered instead.
  "AuthUnknownError",
]);

/** undici / node:net causes that mean "no HTTP transaction ever happened". */
const NETWORK_CAUSE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

/**
 * GoTrue's wording when the `apikey` header — OUR anon key, not the caller's
 * token — is the thing it refused. Matched on the message because the error
 * code for it is not stable across GoTrue versions.
 */
const API_KEY_REJECTED = /\bapi\s*key\b/i;

/** A client that could not be constructed at all: bad URL or absent key. */
const CLIENT_CONSTRUCTION = /supabaseUrl|supabaseKey|Invalid URL/i;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  cause?: { code?: unknown; message?: unknown };
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * One-line, log-safe summary of any auth or PostgREST error.
 *
 * Format: `name | status | code | message | cause.code | cause.message`, with
 * absent parts dropped. Verbatim in spirit from scripts/verify-rls-auth.ts;
 * `code` is new, because auth-js's stable error codes (`bad_jwt`,
 * `user_not_found`, `session_not_found`) are the most diagnostic field it has.
 */
export function authErrorDetail(error: unknown): string {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error !== "object") return String(error);

  const value = asErrorLike(error);
  const parts = [
    str(value.name),
    typeof value.status === "number" ? String(value.status) : str(value.status),
    typeof value.code === "number" ? String(value.code) : str(value.code),
    str(value.message),
    str(value.cause?.code),
    str(value.cause?.message),
  ];

  const detail = parts.filter((part) => part !== undefined).join(" | ");
  return detail === "" ? "unknown error" : detail;
}

/**
 * The `exp` claim of a JWT, in milliseconds, or null if there isn't one.
 *
 * CLASSIFICATION ONLY. Nothing here verifies a signature, and no code path may
 * ever use this to ACCEPT a token — Supabase remains the sole authority on
 * whether a credential is good. It exists because GoTrue's wording for an
 * expired token has changed between versions, while `exp` never will.
 */
export function jwtExpiresAtMs(token: string): number | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString("utf8"),
    );
    const exp = (payload as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    // Not decodable — that is itself a "not a JWT" signal, handled by the
    // caller as `invalid`. Never throws: classification must not add a failure.
    return null;
  }
}

/** True only when the token carries an `exp` that has already passed. */
export function isExpiredToken(token: string, nowMs: number = Date.now()): boolean {
  const expiresAt = jwtExpiresAtMs(token);
  return expiresAt !== null && expiresAt <= nowMs;
}

/**
 * Decide which of the three failure kinds an error represents.
 *
 * Order matters. "We could not check" beats "the token looks old": if the
 * exchange never completed, we have no evidence about the credential at all,
 * and blaming an expired-looking token would send the caller to refresh a
 * token that was never the problem.
 */
export function classifyTokenFailure(
  error: unknown,
  token?: string,
  nowMs: number = Date.now(),
): TokenFailure {
  const detail = authErrorDetail(error);
  const value = asErrorLike(error);

  const name = str(value.name) ?? "";
  const status = typeof value.status === "number" ? value.status : undefined;
  const message = str(value.message) ?? "";
  const causeCode = str(value.cause?.code);

  const neverReachedSupabase =
    UPSTREAM_ERROR_NAMES.has(name) ||
    (causeCode !== undefined && NETWORK_CAUSE_CODES.has(causeCode)) ||
    message === "fetch failed" ||
    (status !== undefined && status >= 500);

  // Supabase answered, but refused OUR credential rather than the caller's.
  const ourKeyRejected =
    (status === 401 || status === 403) && API_KEY_REJECTED.test(message);

  // The client could not even be built — a malformed SUPABASE_URL or an empty
  // key. Always our fault, never the caller's.
  const cannotBuildClient = status === undefined && CLIENT_CONSTRUCTION.test(message);

  if (neverReachedSupabase || ourKeyRejected || cannotBuildClient) {
    return { kind: "upstream", detail };
  }

  if (token !== undefined && isExpiredToken(token, nowMs)) {
    return { kind: "expired", detail };
  }

  return { kind: "invalid", detail };
}
