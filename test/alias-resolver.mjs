// Test-only ESM resolver.
//
// Two things tsconfig/Next resolve natively that the bare node: runtime does
// not, and both are needed to import a route handler under app/ from a test:
//   1. the "@/" path alias, and extensionless module specifiers behind it
//   2. Next's extensionless subpath imports such as "next/server"
//
// Without this, importing any route fails with ERR_MODULE_NOT_FOUND. Nothing
// here affects the application build — it is loaded only via --import in the
// test script.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const ROOT = pathToFileURL(resolvePath(import.meta.dirname, "..", "src") + "/").href;
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"];

function firstExisting(baseUrl) {
  for (const extension of EXTENSIONS) {
    const candidate = new URL(baseUrl.href + extension);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const resolved = firstExisting(new URL(specifier.slice(2), ROOT));
    return next(resolved ?? specifier, context);
  }

  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      // Extensionless relative TypeScript imports (e.g. "./section-stream" from
      // a route file with sibling .ts modules) — resolve against the importer.
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
        const resolved = firstExisting(new URL(specifier, context.parentURL));
        if (resolved) return next(resolved, context);
      }
      // Bare package subpaths that only resolve with an explicit extension.
      if (!specifier.endsWith(".js")) {
        return next(`${specifier}.js`, context);
      }
    }
    throw error;
  }
}
