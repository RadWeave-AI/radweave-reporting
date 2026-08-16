/**
 * Production boot probe — spawned as a CHILD process by
 * test/production-boot.test.ts.
 *
 * This file must be run by plain `node` with NO --import loader, because that
 * is exactly how Vercel boots api/index.ts. It exists as a separate file (not
 * an inline --eval) so the spawn is identical on Windows and POSIX.
 *
 * Prints a single JSON line to stdout so the parent can assert on it.
 *
 * argv[2] optionally names the path to request (default /v1/health), and
 * PROBE_HEADERS optionally carries request headers as JSON — both so the same
 * probe can check what a MISCONFIGURED deployment answers, which is now a
 * response rather than an import-time crash.
 */

const path = process.argv[2] ?? "/v1/health";
const headers = process.env.PROBE_HEADERS ? JSON.parse(process.env.PROBE_HEADERS) : undefined;

const result = { booted: false, status: null, body: null, error: null };

try {
  const entry = await import("../api/index.ts");
  const response = await entry.default.fetch(
    new Request(`https://probe.test${path}`, { headers }),
  );
  result.booted = true;
  result.status = response.status;
  result.body = await response.json();
} catch (err) {
  result.error = {
    code: err?.code ?? err?.name ?? "unknown",
    message: String(err?.message ?? err).split("\n")[0],
  };
}

console.log(JSON.stringify(result));
