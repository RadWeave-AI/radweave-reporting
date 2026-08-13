/**
 * Accept-header-driven transport.
 *
 * One handler, two wire formats, chosen at the edge:
 *
 *   Accept: text/event-stream  → SSE (`event: <type>` / `data: <json>`)
 *   anything else              → a single blocking JSON body
 *
 * Both are fed by the same WorkflowRun. Nothing below this line knows what a
 * report is, and nothing in a workflow knows which transport it is on.
 */

import type { ReportResult, WorkflowEvent, WorkflowRun } from "../workflows/types.ts";
import { ServiceError, errorEnvelope, statusFor } from "./errors.ts";

/**
 * Anti-buffering pad. Proxies (and Vercel's edge in front of a Node function)
 * may hold a small response until enough bytes accumulate; without this the
 * first token can arrive seconds late. Sent as an SSE comment line, which
 * every compliant client ignores.
 *
 * The website emits this from inside each of its five workflow modules. Here
 * it belongs to the transport, which is the only layer that should know the
 * wire format exists.
 */
export const SSE_PRELUDE = `: ${" ".repeat(2048)}\n\n`;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
} as const;

export function wantsStream(acceptHeader: string | null | undefined): boolean {
  if (!acceptHeader) return false;
  return acceptHeader
    .split(",")
    .some((part) => part.trim().toLowerCase().startsWith("text/event-stream"));
}

function sseFrame(event: WorkflowEvent, requestId: string): string {
  const data =
    event.type === "error"
      ? errorEnvelope(event.data.category, event.data.message, requestId, event.data.extras)
      : event.data;
  return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Serializes a WorkflowRun as an SSE response. */
export function streamResponse(workflow: WorkflowRun, requestId: string): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (chunk: string) => writer.write(encoder.encode(chunk));

  void (async () => {
    try {
      await write(SSE_PRELUDE);
      await workflow.run(async (event) => {
        await write(sseFrame(event, requestId));
      });
      await writer.close();
    } catch (err) {
      // The stream is already committed with a 200, so a late failure can only
      // be reported in-band as a final error event.
      const serviceError =
        err instanceof ServiceError
          ? err
          : new ServiceError("internal-error", "The report stream ended unexpectedly.");
      try {
        await write(sseFrame({ type: "error", data: serviceError }, requestId));
        await writer.close();
      } catch {
        // Client already disconnected — nothing left to report to.
      }
    }
  })();

  return new Response(readable, { headers: SSE_HEADERS });
}

/**
 * Drives the same WorkflowRun to completion and returns one JSON body.
 * `delta` events are discarded — the `done` payload already contains the
 * complete report.
 */
export async function blockingResponse(
  workflow: WorkflowRun,
  requestId: string,
): Promise<Response> {
  let result: ReportResult | null = null;
  let failure: ServiceError | null = null;

  await workflow.run(async (event) => {
    if (event.type === "done") result = event.data;
    else if (event.type === "error") failure = event.data;
  });

  if (failure) {
    const err = failure as ServiceError;
    return Response.json(errorEnvelope(err.category, err.message, requestId, err.extras), {
      status: statusFor(err.category),
    });
  }

  if (!result) {
    return Response.json(
      errorEnvelope(
        "internal-error",
        "The workflow completed without producing a report.",
        requestId,
      ),
      { status: 500 },
    );
  }

  return Response.json({ ok: true, request_id: requestId, ...(result as ReportResult) });
}

/** The single dispatch point: transport chosen from Accept, nothing else. */
export function respond(
  workflow: WorkflowRun,
  acceptHeader: string | null | undefined,
  requestId: string,
): Response | Promise<Response> {
  return wantsStream(acceptHeader)
    ? streamResponse(workflow, requestId)
    : blockingResponse(workflow, requestId);
}
