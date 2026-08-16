/**
 * Readiness — does this deployment's configuration actually WORK?
 *
 * `loadConfig` proves only that four strings exist, and `createClient` proves
 * only that one of them parses as a URL. A typo'd project ref, a rotated key,
 * or a key belonging to a different Supabase project all satisfy both and boot
 * cleanly, then fail at request time wearing a misleading message. Every
 * lengthy debugging session this service has caused began exactly there.
 *
 * So this module makes ONE real, cheap, read-only call per critical dependency
 * and reports what came back:
 *
 *   supabase-auth          GET /auth/v1/settings with the anon key — the same
 *                          host and the same key the Bearer path uses, so a
 *                          rejection here IS the token-verification failure,
 *                          observed without needing a token.
 *   supabase-service-role  HEAD on `subscriptions` — the exact table the plan
 *                          and credits lookups read.
 *   anthropic              GET /v1/models?limit=1 — free, no tokens billed,
 *                          and refuses a bad key. No generation is performed.
 *
 * Nothing here returns a secret. Presence booleans and the Supabase HOSTNAME
 * only — the hostname is what makes a mistyped project ref obvious at a glance,
 * and it is not a credential.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

import { authErrorDetail } from "../auth/auth-error.ts";
import type { ServiceConfig } from "../config.ts";
import type { SupabaseClientFactory } from "../supabase/clients.ts";

export interface DependencyResult {
  name: string;
  ok: boolean;
  /** `skipped` means the check could not be attempted, not that it passed. */
  status: "ok" | "failed" | "skipped";
  latency_ms: number;
  detail?: string;
}

export interface ConfigReport {
  ok: boolean;
  /** Present only when configuration failed to load — names the variable. */
  detail?: string;
  /** Hostname only. Never the full URL, never a key. */
  supabase_host?: string;
  /** Which variables are SET. Values are never reported. */
  variables: Record<string, boolean>;
}

export interface ReadinessReport {
  ok: boolean;
  config: ConfigReport;
  dependencies: DependencyResult[];
}

/** The probe surface of the Anthropic SDK, narrowed so tests can stand it in. */
export interface AnthropicProbe {
  models: { list(params: { limit: number }): Promise<unknown> };
}

export interface ReadinessDeps {
  fetchImpl?: typeof fetch;
  clientFactory?: SupabaseClientFactory;
  createAnthropic?: (apiKey: string) => AnthropicProbe;
  /** Per-dependency ceiling. A hung dependency must not hang the diagnostic. */
  timeoutMs?: number;
  /** Injectable clock so latency assertions are not wall-clock dependent. */
  now?: () => number;
}

export const REQUIRED_VARIABLES = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
] as const;

export const OPTIONAL_VARIABLES = ["VOYAGE_API_KEY", "DIAGNOSTICS_KEY", "PORT"] as const;

const DEFAULT_TIMEOUT_MS = 5_000;

class ProbeTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "ProbeTimeout";
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      // Deliberately NOT unref'd. A dependency that never answers leaves
      // nothing else pending, so an unref'd timer lets the loop drain and the
      // timeout never fires — the exact hang this guard exists to prevent.
      // It is always cleared in the `finally` below.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs one probe, timing it and turning any throw into a reported failure. */
async function probe(
  name: string,
  timeoutMs: number,
  now: () => number,
  run: () => Promise<string | null>,
): Promise<DependencyResult> {
  const started = now();
  try {
    const failure = await withTimeout(run(), timeoutMs);
    const latency_ms = now() - started;
    return failure === null
      ? { name, ok: true, status: "ok", latency_ms }
      : { name, ok: false, status: "failed", latency_ms, detail: failure };
  } catch (error) {
    return {
      name,
      ok: false,
      status: "failed",
      latency_ms: now() - started,
      detail: authErrorDetail(error),
    };
  }
}

function skipped(name: string, detail: string): DependencyResult {
  return { name, ok: false, status: "skipped", latency_ms: 0, detail };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Supabase Auth, via the anon key — the credential pair the Bearer token path
 * depends on. `/auth/v1/settings` is GoTrue's cheapest authenticated-by-apikey
 * endpoint: no user, no session, no writes.
 */
export async function checkSupabaseAuth(
  config: ServiceConfig,
  deps: ReadinessDeps = {},
): Promise<DependencyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return probe("supabase-auth", timeoutMs, deps.now ?? Date.now, async () => {
    const base = config.supabaseUrl.endsWith("/")
      ? config.supabaseUrl
      : `${config.supabaseUrl}/`;

    let url: string;
    try {
      url = new URL("auth/v1/settings", base).href;
    } catch (error) {
      return `SUPABASE_URL is not a usable URL: ${authErrorDetail(error)}`;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
        },
      });
    } catch (error) {
      // No HTTP transaction happened. This is the failure that produced a
      // 401 "token is not valid" with no outgoing request in the runtime log.
      return `unreachable — no request completed: ${authErrorDetail(error)}`;
    }

    if (response.status === 401 || response.status === 403) {
      return (
        `SUPABASE_ANON_KEY was rejected (HTTP ${response.status}) — the key is wrong, ` +
        `has been rotated, or belongs to a different project than SUPABASE_URL. ` +
        `Every Bearer token will be reported unverifiable until this is fixed.`
      );
    }
    if (response.status === 404) {
      return (
        `HTTP 404 from ${hostOf(url) ?? "the configured host"}/auth/v1/settings — ` +
        `SUPABASE_URL does not look like a Supabase project URL.`
      );
    }
    if (!response.ok) return `HTTP ${response.status} from Supabase Auth`;
    return null;
  });
}

/**
 * Supabase service-role, against the exact table the plan lookup reads.
 * `head: true` + `limit(1)` transfers no rows.
 */
export async function checkSupabaseServiceRole(
  config: ServiceConfig,
  deps: ReadinessDeps = {},
): Promise<DependencyResult> {
  const clientFactory = deps.clientFactory ?? createClient;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return probe("supabase-service-role", timeoutMs, deps.now ?? Date.now, async () => {
    const client = clientFactory(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error } = await client
      .from("subscriptions")
      .select("user_id", { head: true })
      .limit(1);

    if (!error) return null;

    const detail = authErrorDetail(error);
    return /api\s*key|JWS|JWT|401/i.test(detail)
      ? `SUPABASE_SERVICE_ROLE_KEY was rejected: ${detail}`
      : `query on 'subscriptions' failed: ${detail}`;
  });
}

/**
 * Anthropic. `models.list` is a free metadata GET that still authenticates the
 * key — deliberately NOT a messages call, which would bill a real generation.
 */
export async function checkAnthropic(
  config: ServiceConfig,
  deps: ReadinessDeps = {},
): Promise<DependencyResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createAnthropicClient =
    deps.createAnthropic ??
    ((apiKey: string) =>
      new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs }) as AnthropicProbe);

  return probe("anthropic", timeoutMs, deps.now ?? Date.now, async () => {
    try {
      await createAnthropicClient(config.anthropicApiKey).models.list({ limit: 1 });
      return null;
    } catch (error) {
      const detail = authErrorDetail(error);
      const status = (error as { status?: unknown } | null)?.status;
      return status === 401 || status === 403
        ? `ANTHROPIC_API_KEY was rejected: ${detail}`
        : `models.list failed: ${detail}`;
    }
  });
}

/**
 * The whole picture: configuration, then every critical dependency.
 *
 * Answers even when configuration failed to load — that case is precisely the
 * one where an operator has the least to go on, so it must not be the case
 * that produces no output.
 */
export async function buildReadinessReport(
  input: {
    config: ServiceConfig | null;
    configError?: Error | null;
    env?: NodeJS.ProcessEnv;
  },
  deps: ReadinessDeps = {},
): Promise<ReadinessReport> {
  const env = input.env ?? process.env;

  const variables: Record<string, boolean> = {};
  for (const name of [...REQUIRED_VARIABLES, ...OPTIONAL_VARIABLES]) {
    variables[name] = Boolean(env[name]);
  }

  if (input.config === null) {
    const detail = input.configError?.message ?? "configuration is unavailable";
    return {
      ok: false,
      config: { ok: false, detail, variables },
      dependencies: [
        skipped("supabase-auth", "not attempted: service configuration is incomplete"),
        skipped(
          "supabase-service-role",
          "not attempted: service configuration is incomplete",
        ),
        skipped("anthropic", "not attempted: service configuration is incomplete"),
      ],
    };
  }

  const config = input.config;
  const dependencies = await Promise.all([
    checkSupabaseAuth(config, deps),
    checkSupabaseServiceRole(config, deps),
    checkAnthropic(config, deps),
  ]);

  return {
    ok: dependencies.every((dependency) => dependency.ok),
    config: { ok: true, supabase_host: hostOf(config.supabaseUrl), variables },
    dependencies,
  };
}
