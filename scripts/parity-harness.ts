import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { loadConfig } from "../src/config.ts";
import { getUsageSnapshot } from "../src/lib/usage/credits.ts";
import { createServiceRoleClient } from "../src/supabase/clients.ts";
import type { WorkflowName } from "../src/workflows/types.ts";

interface ParityCase {
  id: string;
  workflow: WorkflowName;
  usage_mode: string;
  website_body: Record<string, unknown>;
  service_body: Record<string, unknown>;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

const inputPath = process.env.PARITY_INPUTS;
const accessToken = process.env.PARITY_ACCESS_TOKEN;
const websiteCookie = process.env.PARITY_WEBSITE_COOKIE;
if (!inputPath) throw new Error("PARITY_INPUTS must name the reviewed recorded-input JSON file.");
if (!accessToken) throw new Error("PARITY_ACCESS_TOKEN is required.");
if (!websiteCookie) throw new Error("PARITY_WEBSITE_COOKIE is required for the live browser route.");

const websiteUrl = (process.env.PARITY_WEBSITE_URL ?? "https://radweave.ai").replace(/\/$/, "");
const reportingUrl = (process.env.PARITY_REPORTING_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const config = loadConfig();
const admin = createServiceRoleClient(config);
const auth = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const verified = await auth.auth.getUser(accessToken);
if (verified.error || !verified.data.user) throw new Error("PARITY_ACCESS_TOKEN is not valid.");
const userId = verified.data.user.id;

const cases = JSON.parse(await readFile(resolve(inputPath), "utf8")) as ParityCase[];
if (!Array.isArray(cases) || cases.length === 0) throw new Error("PARITY_INPUTS contained no cases.");

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    events.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
  }
  return events;
}

function doneReport(events: SseEvent[], source: "website" | "service"): string {
  const errors = events.filter((event) => event.event === "error");
  if (errors.length > 0) throw new Error(`${source} emitted an error event.`);
  const done = events.findLast((event) => event.event === "done");
  const report = source === "website" ? done?.data.final_report : done?.data.report;
  if (typeof report !== "string") throw new Error(`${source} emitted no final report.`);
  return report;
}

async function postSse(url: string, body: Record<string, unknown>, headers: HeadersInit) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return parseSse(await response.text());
}

const USAGE_COLUMNS = [
  "id",
  "user_id",
  "model",
  "mode",
  "modality",
  "body_region",
  "study_type",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "estimated_cost_usd",
  "templates_used",
  "report_chars",
].join(",");

async function usageRows(mode: string) {
  const query = await admin
    .from("report_usage_logs")
    .select(USAGE_COLUMNS)
    .eq("user_id", userId)
    .eq("mode", mode)
    .order("created_at", { ascending: false })
    .limit(100);
  if (query.error) throw new Error(`Usage-row query failed: ${query.error.message}`);
  return (query.data ?? []) as Array<Record<string, unknown> & { id: string }>;
}

function canonicalUsage(row: Record<string, unknown>) {
  const { id: _databaseIdentity, ...stable } = row;
  return stable;
}

async function runAndCaptureUsage(
  mode: string,
  invoke: () => Promise<SseEvent[]>,
) {
  const beforeRows = await usageRows(mode);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const creditsBefore = await getUsageSnapshot(admin, userId);
  const events = await invoke();
  const creditsAfter = await getUsageSnapshot(admin, userId);
  const newRows = (await usageRows(mode)).filter((row) => !beforeIds.has(row.id));
  if (newRows.length !== 1) throw new Error(`Expected one new ${mode} usage row; found ${newRows.length}.`);
  return {
    events,
    usage: canonicalUsage(newRows[0]),
    creditDelta: creditsBefore.credits_remaining - creditsAfter.credits_remaining,
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : limit;
}

function usageDifferences(
  website: Record<string, unknown>,
  service: Record<string, unknown>,
) {
  const keys = Array.from(new Set([...Object.keys(website), ...Object.keys(service)])).sort();
  return keys
    .filter((key) => JSON.stringify(website[key]) !== JSON.stringify(service[key]))
    .map((key) => ({ key, website: website[key] ?? null, service: service[key] ?? null }));
}

for (const item of cases) {
  const website = await runAndCaptureUsage(item.usage_mode, () => postSse(
    `${websiteUrl}/api/generate-report`,
    item.website_body,
    { Cookie: websiteCookie },
  ));
  const service = await runAndCaptureUsage(item.usage_mode, () => postSse(
    `${reportingUrl}/v1/reports/${item.workflow}`,
    item.service_body,
    { Authorization: `Bearer ${accessToken}` },
  ));

  const websiteReport = doneReport(website.events, "website");
  const serviceReport = doneReport(service.events, "service");
  const textMatches = websiteReport === serviceReport;
  const usageMatches = JSON.stringify(website.usage) === JSON.stringify(service.usage);
  const creditsMatch = website.creditDelta === service.creditDelta;

  console.log(JSON.stringify({
    id: item.id,
    text_matches: textMatches,
    website_sha256: digest(websiteReport),
    service_sha256: digest(serviceReport),
    first_text_difference: firstDifference(websiteReport, serviceReport),
    usage_matches: usageMatches,
    usage_differences: usageMatches ? [] : usageDifferences(website.usage, service.usage),
    website_credit_delta: website.creditDelta,
    service_credit_delta: service.creditDelta,
    credits_match: creditsMatch,
  }));

  if (!textMatches) throw new Error(`Generated text differs for parity case ${item.id}.`);
  if (!usageMatches) throw new Error(`Usage row differs for parity case ${item.id}.`);
  if (!creditsMatch) throw new Error(`Credit delta differs for parity case ${item.id}.`);
}

console.log(JSON.stringify({ ok: true, cases: cases.length }));
