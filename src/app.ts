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

import { Hono } from "hono";

import {
  resolveCaller,
  type ApiKeyResolver,
  type PlanResolver,
  type TokenVerifier,
} from "./auth/resolve-caller.ts";
import type { Principal } from "./auth/principal.ts";
import { formatReport, validateFormatReportRequest } from "./formatting/index.ts";
import { ServiceError, errorEnvelope, statusFor } from "./http/errors.ts";
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

  // ── Public ────────────────────────────────────────────────────────────────

  app.get("/v1/health", (c) =>
    c.json({ ok: true, service: "radweave-reporting", request_id: c.get("requestId") }),
  );

  // ── Authenticated ─────────────────────────────────────────────────────────

  const authenticate = async (c: any, next: any) => {
    const result = await resolveCaller(c.req.header("authorization"), {
      verifyToken: deps.verifyToken,
      resolvePlan: deps.resolvePlan,
      resolveApiKey: deps.resolveApiKey,
    });
    if (!result.ok) {
      const category = result.reason === "not-implemented" ? "not-implemented" : "unauthorized";
      throw new ServiceError(category, result.message);
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
