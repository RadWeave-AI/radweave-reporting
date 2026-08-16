/**
 * The one error envelope every endpoint returns.
 *
 * The website currently returns two different error vocabularies for the same
 * conditions — the SSE route answers `{ error: "credits_exhausted" }` while the
 * Desktop route answers `{ error: "insufficient-credits" }`. v1 of this service
 * unifies them. Categories are kebab-case and stable; they are part of the
 * public contract and must not be renamed once a hospital customer depends on
 * one.
 */

export const ERROR_CATEGORIES = [
  "validation-error",
  "unauthorized",
  "insufficient-credits",
  "upgrade-required",
  "not-found",
  "rate-limited",
  "not-implemented",
  "provider-error",
  "timeout",
  "aborted",
  "internal-error",
  // A dependency this service needs is unreachable or misconfigured. Distinct
  // from provider-error (the model provider failed mid-work) and from
  // internal-error (a bug): this one says "our configuration or our network,
  // not your request" — and is what an auth failure we could not complete
  // reports, instead of a 401 blaming the caller's credential.
  "service-unavailable",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ERROR_STATUS: Record<ErrorCategory, number> = {
  "validation-error": 400,
  unauthorized: 401,
  "insufficient-credits": 403,
  "upgrade-required": 403,
  "not-found": 404,
  "rate-limited": 429,
  "not-implemented": 501,
  "provider-error": 502,
  timeout: 504,
  // 499 Client Closed Request — the de facto convention. Moot in practice
  // (the caller is gone by definition), but it keeps proxy logs honest.
  aborted: 499,
  "internal-error": 500,
  "service-unavailable": 503,
};

/** Optional, category-specific fields. Never include provider-raw detail. */
export interface ErrorExtras {
  retry_after_seconds?: number;
  credits_remaining?: number;
  credits_limit?: number;
  prohibited_fields?: string[];
  unexpected_fields?: string[];
  missing_fields?: string[];
}

export interface ErrorEnvelope extends ErrorExtras {
  ok: false;
  error: ErrorCategory;
  message: string;
  request_id: string;
}

export class ServiceError extends Error {
  readonly category: ErrorCategory;
  readonly extras: ErrorExtras;

  constructor(category: ErrorCategory, message: string, extras: ErrorExtras = {}) {
    super(message);
    this.name = "ServiceError";
    this.category = category;
    this.extras = extras;
  }
}

export function errorEnvelope(
  category: ErrorCategory,
  message: string,
  requestId: string,
  extras: ErrorExtras = {},
): ErrorEnvelope {
  // Spread extras first so the envelope's own fields can never be overwritten
  // by a caller-supplied key.
  return { ...extras, ok: false, error: category, message, request_id: requestId };
}

export function statusFor(category: ErrorCategory): number {
  return ERROR_STATUS[category];
}
