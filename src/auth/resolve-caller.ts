/**
 * resolveCaller — the service's single authentication entry point.
 *
 * Two schemes, one Principal:
 *
 *   Authorization: Bearer <supabase-jwt>      → UserPrincipal   (implemented)
 *   Authorization: ApiKey <key-id>.<secret>   → OrgPrincipal    (scaffolded)
 *
 * The Bearer path is the one the website (server-side) and Desktop use today.
 * It is deliberately cookie-free: the token is validated directly against
 * Supabase Auth with `getUser(token)`, which resolves the real user without
 * reading or requiring a stored session. This is the same mechanism the
 * website's existing /api/desktop/generate-report bridge already uses, so
 * Desktop needs no new credential type to talk to this service.
 *
 * The ApiKey path is scaffolded but NOT functional — see parseApiKey and
 * resolveApiKeyCaller below for exactly what is missing.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { authErrorDetail, classifyTokenFailure, type TokenFailure } from "./auth-error.ts";
import {
  authFailure,
  type AuthResult,
  type OrgPrincipal,
  type UserPrincipal,
} from "./principal.ts";

const BEARER = "Bearer ";
const API_KEY = "ApiKey ";

export interface VerifiedUser {
  id: string;
  email: string | null;
}

/**
 * What a verifier learned. The failure branch carries WHY, which the previous
 * `null` return could not: every distinct cause arrived here as the same empty
 * value and left as the same 401.
 */
export type TokenVerification =
  | { ok: true; user: VerifiedUser }
  | { ok: false; failure: TokenFailure };

/**
 * Verifiers may also return the older shape — a user, or `null` for "no" —
 * which normalises to an `invalid` failure. Kept because a verifier that
 * cannot distinguish causes is still a legitimate verifier (every test double
 * is one), and forcing them all to construct a `TokenFailure` would add noise
 * without adding information.
 */
export type TokenVerifierResult = TokenVerification | VerifiedUser | null;

/**
 * Verifies a Supabase access token and returns the user it belongs to.
 * Injectable so tests never reach the network.
 */
export interface TokenVerifier {
  (token: string): Promise<TokenVerifierResult>;
}

/** Widens either accepted return shape to the one the resolver reasons about. */
export function normalizeVerification(result: TokenVerifierResult): TokenVerification {
  if (result === null || result === undefined) {
    return {
      ok: false,
      failure: { kind: "invalid", detail: "verifier returned no user and no reason" },
    };
  }
  if ("ok" in result) return result;
  return { ok: true, user: result };
}

/** Resolves a caller's subscription plan. Stubbed until the real lookup lands. */
export interface PlanResolver {
  (userId: string): Promise<string>;
}

export interface ResolveCallerDeps {
  verifyToken?: TokenVerifier;
  resolvePlan?: PlanResolver;
  resolveApiKey?: ApiKeyResolver;
}

export interface ApiKeyResolver {
  (keyId: string, secret: string): Promise<Omit<OrgPrincipal, "kind"> | null>;
}

/**
 * Default token verifier: a plain, cookie-free Supabase client. `persistSession`
 * is off because this process is stateless and must never accumulate sessions.
 *
 * Every failure exit carries its cause. `getUser(token)` is a network call —
 * auth-js has no local verification path — so "the token is bad" and "we never
 * reached Supabase" arrive here through the same return value and must be told
 * apart before either is reported.
 */
export function createSupabaseTokenVerifier(
  supabaseUrl: string,
  supabaseAnonKey: string,
  clientFactory: typeof createClient = createClient,
): TokenVerifier {
  let client: SupabaseClient | null = null;

  return async (token: string): Promise<TokenVerification> => {
    if (client === null) {
      try {
        client = clientFactory(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      } catch (error) {
        // A malformed SUPABASE_URL or an empty key throws here. Left uncaught
        // this became a bare 500 with no cause in the log; it is a
        // configuration fault and is reported as one. `client` stays null so a
        // corrected redeploy is picked up rather than cached as broken.
        return {
          ok: false,
          failure: {
            kind: "upstream",
            detail: `supabase client construction failed: ${authErrorDetail(error)}`,
          },
        };
      }
    }

    try {
      const { data, error } = await client.auth.getUser(token);
      if (error) return { ok: false, failure: classifyTokenFailure(error, token) };
      if (!data.user) {
        return {
          ok: false,
          failure: {
            kind: "invalid",
            detail: "supabase returned neither a user nor an error",
          },
        };
      }
      return { ok: true, user: { id: data.user.id, email: data.user.email ?? null } };
    } catch (thrown) {
      // auth-js re-throws anything that is not an AuthError.
      return { ok: false, failure: classifyTokenFailure(thrown, token) };
    }
  };
}

/**
 * MISSING FOR HOSPITAL CUSTOMERS (deliberately not built this session):
 *  - an `api_clients` table: key id, argon2/bcrypt hash of the secret, org id,
 *    plan, scopes, created/revoked timestamps, last-used-at
 *  - key issuance + revocation (admin surface)
 *  - constant-time secret comparison against the stored hash
 *  - per-org rate limiting and per-org credit accounting, which today are
 *    both keyed by user id
 *
 * Until that exists this resolver always returns null, and the ApiKey scheme
 * reports "not-implemented" rather than pretending to authenticate anyone.
 */
export const unimplementedApiKeyResolver: ApiKeyResolver = async () => null;

/** `<key-id>.<secret>` — split on the FIRST dot; secrets may contain dots. */
export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  const separator = raw.indexOf(".");
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { keyId: raw.slice(0, separator), secret: raw.slice(separator + 1) };
}

export async function resolveCaller(
  authorizationHeader: string | null | undefined,
  deps: ResolveCallerDeps = {},
): Promise<AuthResult> {
  if (!authorizationHeader) {
    return authFailure(
      "missing-credential",
      "An Authorization header is required.",
    );
  }

  if (authorizationHeader.startsWith(BEARER)) {
    const token = authorizationHeader.slice(BEARER.length).trim();
    if (!token) {
      return authFailure("malformed-credential", "Bearer token was empty.");
    }

    const verifyToken = deps.verifyToken;
    if (!verifyToken) {
      return authFailure(
        "not-implemented",
        "No token verifier is configured for this service.",
      );
    }

    const verification = normalizeVerification(await verifyToken(token));
    if (!verification.ok) {
      const { kind, detail } = verification.failure;

      if (kind === "upstream") {
        // NOT 401. Nothing has been established about this credential, so
        // blaming it would be a guess — and the one time it was guessed, three
        // debugging cycles went into a token that was fine all along.
        return authFailure(
          "verification-unavailable",
          "Access token verification is temporarily unavailable. This is a fault " +
            "in this service, not in the credential supplied. Retry shortly.",
          detail,
        );
      }

      if (kind === "expired") {
        return authFailure(
          "expired-credential",
          "The supplied access token has expired. Obtain a fresh access token and retry.",
          detail,
        );
      }

      return authFailure(
        "invalid-credential",
        "The supplied access token is not valid.",
        detail,
      );
    }

    const { user } = verification;
    const plan = deps.resolvePlan ? await deps.resolvePlan(user.id) : "free";
    const principal: UserPrincipal = {
      kind: "user",
      userId: user.id,
      email: user.email,
      plan,
      accessToken: token,
    };
    return { ok: true, principal };
  }

  if (authorizationHeader.startsWith(API_KEY)) {
    const raw = authorizationHeader.slice(API_KEY.length).trim();
    const parsed = parseApiKey(raw);
    if (!parsed) {
      return authFailure(
        "malformed-credential",
        "An API key must be formatted as <key-id>.<secret>.",
      );
    }

    const resolveApiKey = deps.resolveApiKey ?? unimplementedApiKeyResolver;
    const record = await resolveApiKey(parsed.keyId, parsed.secret);
    if (!record) {
      // Not "invalid-credential": no key can be valid yet, and reporting it as
      // invalid would misrepresent an unbuilt feature as a rejected credential.
      return authFailure(
        "not-implemented",
        "API key authentication is not available yet. Use a Bearer access token.",
      );
    }

    const principal: OrgPrincipal = { kind: "org", ...record };
    return { ok: true, principal };
  }

  return authFailure(
    "unsupported-scheme",
    "Authorization must use the Bearer or ApiKey scheme.",
  );
}
