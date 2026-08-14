import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// SHA-256 of LF-normalized source copied from website commit e4c37cd.
// Whole-file hashes are intentionally stricter than prompt-only extraction:
// any future change to the prompt-bearing workflows must be explicit.
const SOURCE_HASHES = {
  "src/lib/ai/system_prompt.ts": "b3cc85cb4f8e29d260169c7bec7f47e5cb5e80f128bc192ff35397c7d9b5cd2c",
  "src/lib/ai/strict-style.ts": "cd923037c117036ca9a2094ab1ccf1cc13aec97d81dd1475c9d9da65bf7c3696",
  "src/lib/templates/prompt_builder.ts": "d9443b285f82549becc1ed900c4e97b922e39fa42865f306c00b9f45c938b7a6",
  "src/lib/templates/my_template_quality_check.ts": "491c7be875b400ca64db81efbe6fd1627d449eaec25e89fc47150489e0c0c1bd",
  "src/lib/reporting/checklist-generation.ts": "78c87c2740d941d778839a06fe80a45a09b0ada4bc7dd303e32b55ffc72ab722",
  "src/lib/reporting/comparison-generation.ts": "16ab6446b234ea5e27ebe4cd205509b74b6c8376004e078dc9ea476862d6e35c",
  "src/lib/reporting/quick-report-generation.ts": "90c102eab10735b21e73a5bfe4752d17420992132d2a358774aef546bb7ff77f",
  "src/lib/reporting/my-template-generation.ts": "c83b03d175fb3cc8ba6ff92377d56cdef5b675ce0597ea2b129ca34d9ccb90eb",
  "src/lib/reporting/template-guided-generation.ts": "084659bf126c74d1c462bfc200c3acc99394d78b3d3d5c5a4931bbad72fffbcb",
} as const;

for (const [relativePath, expected] of Object.entries(SOURCE_HASHES)) {
  test(`${relativePath} remains byte-equivalent to e4c37cd after newline normalization`, async () => {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const normalized = source.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
    assert.equal(actual, expected);
  });
}
