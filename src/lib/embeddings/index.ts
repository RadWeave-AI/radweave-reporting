/**
 * Embedding provider factory — the single swap point.
 *
 * Call sites import getEmbeddingProvider() from here and depend only on the
 * EmbeddingProvider interface. To change providers later (OpenAI, self-hosted,
 * etc.), add a new implementation and switch the construction below; no call
 * site changes. Voyage (voyage-4, 1024-dim) is the only implementation today.
 */
import type { EmbeddingProvider } from "./types.ts";
import { createVoyageProvider } from "./voyage.ts";

export type { EmbeddingProvider } from "./types.ts";

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!cached) cached = createVoyageProvider();
  return cached;
}

