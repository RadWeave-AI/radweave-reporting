/**
 * RadWeave Reporting — HTTP surface.
 *
 * Framework: Hono. Reasons, in order of weight:
 *  1. It is built on the WHATWG Request/Response primitives the existing
 *     reporting code already uses (TransformStream, Response, AbortSignal,
 *     Headers). The website's SSE plumbing ports over with no adapter layer;
 *     Fastify's req/res model would need one.
 *  2. It deploys to Vercel through `hono/vercel` with no serverless shim, and
 *     runs unchanged under @hono/node-server locally — the same code path in
 *     both places.
 *  3. Streaming is first-class rather than bolted on, and this service's whole
 *     reason to exist is streaming clinical text.
 *
 * Everything is injectable so the tests never touch Supabase or a network.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import {
  resolveCaller,
  type ApiKeyResolver,
  type PlanResolver,
  type TokenVerifier,
} from "./auth/resolve-caller.ts";
import type { AuthFailure, AuthFailureReason, Principal } from "./auth/principal.ts";
import { formatReport, validateFormatReportRequest } from "./formatting/index.ts";
import type { ReadinessReport } from "./health/readiness.ts";
import { ServiceError, errorEnvelope, statusFor, type ErrorCategory } from "./http/errors.ts";
import { respond } from "./http/transport.ts";
import { createRealWorkflow } from "./workflows/real.ts";
import { validateReportRequest } from "./workflows/request.ts";
import { WORKFLOWS, type WorkflowName, type WorkflowRun } from "./workflows/types.ts";

export interface WorkflowContext {
  workflow: WorkflowName;
  principal: Principal;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AppDeps {
  verifyToken?: TokenVerifier;
  resolvePlan?: PlanResolver;
  resolveApiKey?: ApiKeyResolver;
  createWorkflow?: (context: WorkflowContext) => WorkflowRun | Promise<WorkflowRun>;
  /**
   * Set when configuration could not be loaded. The app still starts, so the
   * deployment can SAY what is wrong instead of crashing at import time and
   * leaving only an opaque platform error. Every route but the two diagnostic
   * ones answers 503.
   */
  configError?: Error | null;
  /**
   * Shared secret for `/v1/ready`. Unset means the endpoint does not exist.
   */
  diagnosticsKey?: string;
  buildReadiness?: () => Promise<ReadinessReport>;
}

/**
 * Which HTTP category each authentication outcome belongs to.
 *
 * The one that matters: `verification-unavailable` is 503, not 401. A caller
 * whose token we could not check has done nothing wrong, and telling them
 * otherwise sends them to debug a credential that was never the problem.
 */
const CATEGORY_BY_AUTH_REASON: Record<AuthFailureReason, ErrorCategory> = {
  "missing-credential": "unauthorized",
  "malformed-credential": "unauthorized",
  "invalid-credential": "unauthorized",
  "expired-credential": "unauthorized",
  "unsupported-scheme": "unauthorized",
  "verification-unavailable": "service-unavailable",
  "not-implemented": "not-implemented",
};

/**
 * One log line per rejected request, carrying the cause the caller is not told.
 *
 * This is the whole point of the exercise: the detail exists, it is just not
 * the caller's business. A server fault logs at error level so it surfaces
 * above the routine noise of unauthenticated scanners.
 */
function logAuthFailure(requestId: string, failure: AuthFailure): void {
  const line = {
    requestId,
    reason: failure.reason,
    // The token itself is never logged.
    detail: failure.detail ?? "no upstream detail",
  };
  if (failure.reason === "verification-unavailable") {
    console.error("[radweave-reporting] auth verification unavailable", line);
  } else {
    console.warn("[radweave-reporting] auth rejected", line);
  }
}

/**
 * Constant-time comparison that does not leak length. `timingSafeEqual`
 * throws on unequal-length buffers, so both sides are hashed to a fixed width
 * first — the comparison stays constant-time and length becomes unobservable.
 */
function secretMatches(configured: string, supplied: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(configured).digest(),
    createHash("sha256").update(supplied).digest(),
  );
}

type Vars = { requestId: string; principal: Principal };

export function createApp(deps: AppDeps = {}): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  const createWorkflow = deps.createWorkflow ?? createRealWorkflow;

  // Every response carries a request id, including error envelopes.
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? crypto.randomUUID());
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "unknown";
    if (err instanceof ServiceError) {
      return c.json(
        errorEnvelope(err.category, err.message, requestId, err.extras),
        statusFor(err.category) as 400,
      );
    }
    // Never leak an internal message to a caller.
    console.error("[radweave-reporting] unhandled error", { requestId, err });
    return c.json(
      errorEnvelope("internal-error", "An unexpected error occurred.", requestId),
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      errorEnvelope("not-found", "No such endpoint.", c.get("requestId") ?? "unknown"),
      404,
    ),
  );

  // A deployment whose configuration did not load can still be asked what is
  // wrong. It just cannot do any work.
  if (deps.configError) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/v1/health" || c.req.path === "/v1/ready") return next();
      throw new ServiceError(
        "service-unavailable",
        "This service is not configured correctly and cannot serve requests.",
      );
    });
  }

  // ── Public ────────────────────────────────────────────────────────────────

  app.get("/v1/health", (c) => {
    // Liveness, and honest about it: a process that cannot serve anything must
    // not report 200. No variable name or value appears here — the public
    // surface says only that something is wrong; /v1/ready says what.
    if (deps.configError) {
      throw new ServiceError(
        "service-unavailable",
        "Service configuration is incomplete. See /v1/ready for per-dependency detail.",
      );
    }
    return c.json({
      ok: true,
      service: "radweave-reporting",
      request_id: c.get("requestId"),
    });
  });

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Deep readiness: one real call per critical dependency.
   *
   * Guarded by a dedicated `DIAGNOSTICS_KEY` rather than a Bearer token on
   * purpose — this endpoint exists to diagnose a broken auth path, so gating
   * it behind that same path would make it useless in exactly the situation it
   * was built for. A missing or wrong key answers 404, identical to a route
   * that does not exist, so the endpoint cannot be found by probing.
   */
  app.get("/v1/ready", async (c) => {
    const supplied = c.req.header("x-diagnostics-key");
    if (!deps.diagnosticsKey || !supplied || !secretMatches(deps.diagnosticsKey, supplied)) {
      return c.notFound();
    }

    if (!deps.buildReadiness) {
      throw new ServiceError(
        "not-implemented",
        "No readiness check is configured for this service.",
      );
    }

    const report = await deps.buildReadiness();
    return c.json(
      {
        ok: report.ok,
        request_id: c.get("requestId"),
        ...(report.ok
          ? {}
          : {
              error: "service-unavailable" satisfies ErrorCategory,
              message: "One or more dependencies failed their readiness check.",
            }),
        config: report.config,
        dependencies: report.dependencies,
      },
      report.ok ? 200 : 503,
    );
  });

  // ── Authenticated ─────────────────────────────────────────────────────────

  const authenticate = async (c: any, next: any) => {
    const result = await resolveCaller(c.req.header("authorization"), {
      verifyToken: deps.verifyToken,
      resolvePlan: deps.resolvePlan,
      resolveApiKey: deps.resolveApiKey,
    });
    if (!result.ok) {
      logAuthFailure(c.get("requestId"), result);
      throw new ServiceError(CATEGORY_BY_AUTH_REASON[result.reason], result.message);
    }
    c.set("principal", result.principal);
    await next();
  };

  app.use("/v1/reports/*", authenticate);
  app.use("/v1/format", authenticate);
  app.use("/v1/reviews/*", authenticate);
  app.use("/v1/credits", authenticate);

  app.get("/v1/credits", (c) => {
    const principal = c.get("principal");
    // Real balances arrive with the credits module in the extraction mission.
    return c.json({
      ok: true,
      request_id: c.get("requestId"),
      plan: principal.plan,
      credits: { remaining: 0, limit: 0 },
      stub: true,
    });
  });

  app.post("/v1/format", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ServiceError("validation-error", "Invalid JSON body.");
    }

    let request;
    try {
      request = validateFormatReportRequest(raw);
    } catch (error) {
      throw new ServiceError(
        "validation-error",
        error instanceof Error ? error.message : "Invalid formatting request.",
      );
    }

    const result = await formatReport(request);
    return c.json({
      ok: true,
      request_id: c.get("requestId"),
      style_id: result.style_id,
      style_path: result.style_path,
      report_family: result.report_family,
      html: result.html,
      plain_text: result.plain_text,
      docx_base64: result.docx?.toString("base64"),
      outline: result.outline,
    });
  });

  for (const workflow of WORKFLOWS) {
    app.post(`/v1/reports/${workflow}`, async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new ServiceError("validation-error", "Invalid JSON body.");
      }

      const body = validateReportRequest(workflow, raw);
      const run = await createWorkflow({
        workflow,
        principal: c.get("principal"),
        body,
        signal: c.req.raw.signal,
      });

      return respond(run, c.req.header("accept"), c.get("requestId"));
    });
  }

  // ── Reserved (Phase D) ────────────────────────────────────────────────────
  // Consultant Review shares this service's cost-accounting and usage
  // persistence but none of the five-workflow orchestration. The URL is
  // claimed now so adding it later is not a breaking change to v1.
  app.post("/v1/reviews/consultant", () => {
    throw new ServiceError(
      "not-implemented",
      "Consultant Review is not served by this service yet.",
    );
  });

  return app;
}
