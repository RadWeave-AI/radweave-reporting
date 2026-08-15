/**
 * Regression guard: the deployed entry point must boot under PLAIN Node.
 *
 * Production incident this pins down: every module under src/lib/** imported
 * via the "@/*" TypeScript path alias, and a handful used extensionless
 * relative specifiers. Both resolve locally only because npm scripts ran with
 * `--import ./test/register-alias.mjs`, a test-only ESM loader. Vercel's Node
 * runtime has no such loader — and Vercel's docs state path mappings are not
 * supported there — so production crashed at import time with:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@/lib' imported from
 *   src/lib/stripe/get-user-plan.ts
 *
 * The whole test suite passed throughout, because the suite itself runs with
 * that loader. That is the trap this file closes.
 *
 * It MUST spawn a child process. An in-process import would inherit the
 * parent's loader and assert nothing. NODE_OPTIONS is cleared in the child so
 * an ambient loader cannot creep back in either.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
// fileURLToPath, not URL.pathname — the repo path contains a space, which
// pathname leaves percent-encoded and node cannot open.
const PROBE = fileURLToPath(new URL("./production-boot-probe.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Config the entry point needs at module scope. Unreachable, never dialled. */
const CHILD_ENV = {
  ...process.env,
  NODE_OPTIONS: "",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  ANTHROPIC_API_KEY: "test-anthropic-key",
};

async function bootUnderPlainNode() {
  const { stdout } = await run(process.execPath, [PROBE], {
    env: CHILD_ENV,
    cwd: REPO_ROOT,
  });
  const line = stdout.trim().split("\n").at(-1);
  return JSON.parse(line!);
}

test("api/index.ts boots under plain node with no alias loader", async () => {
  const result = await bootUnderPlainNode();

  assert.equal(
    result.error,
    null,
    `entry point failed to boot without the test loader: ${JSON.stringify(result.error)}`,
  );
  assert.equal(result.booted, true);
});

test("/v1/health responds 200 on the real production boot path", async () => {
  const result = await bootUnderPlainNode();

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.service, "radweave-reporting");
});

test("no module resolves through a path alias or an extensionless specifier", async () => {
  // Belt-and-braces: if either bug class is reintroduced, the boot above fails
  // with ERR_MODULE_NOT_FOUND. This asserts on the specific failure mode so a
  // regression reports the actual cause rather than a generic boot failure.
  const result = await bootUnderPlainNode();

  assert.notEqual(
    result.error?.code,
    "ERR_MODULE_NOT_FOUND",
    "a specifier is unresolvable without the test loader — this is the production bug",
  );
});
