/**
 * Voyage AI implementation of EmbeddingProvider.
 *
 * REST: POST https://api.voyageai.com/v1/embeddings
 * Auth: Authorization: Bearer <VOYAGE_API_KEY>
 * Model: voyage-4 (default output dimension 1024, set explicitly here so it
 *        always matches the user_report_template_embeddings.embedding column).
 *
 * The API key is read server-side only and is never included in any thrown
 * error or log line.
 */
import { getServiceConfig } from "@/config";
import type { EmbeddingProvider } from "./types";

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-4";
const VOYAGE_DIMENSION = 1024;
const MAX_RETRIES = 2;

// The service config reads only process.env; there is no filesystem fallback
// in this standalone host. Voyage is optional and checked only when this
// dormant style-example feature is invoked.
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type VoyageResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  // Some surfaces document the field as `embeddings`; tolerate both shapes.
  embeddings?: number[][];
};

class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly model = VOYAGE_MODEL;
  readonly dimension = VOYAGE_DIMENSION;

  async embed(texts: string[], inputType?: "document" | "query"): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = getServiceConfig().voyageApiKey;
    if (!apiKey) {
      throw new Error("VOYAGE_API_KEY is not configured.");
    }

    const body = JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: inputType ?? null,
      output_dimension: VOYAGE_DIMENSION,
    });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(VOYAGE_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
        });
      } catch (err) {
        // Network error — retryable.
        lastError = new Error(
          `Voyage request failed: ${err instanceof Error ? err.message : "network error"}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      // Retry on rate-limit / server errors.
      if (response.status === 429 || response.status >= 500) {
        const detail = await response.text().catch(() => "");
        lastError = new Error(
          `Voyage API error ${response.status}: ${detail.slice(0, 300) || response.statusText}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Non-retryable (4xx other than 429). Never include the key.
        throw new Error(
          `Voyage API error ${response.status}: ${detail.slice(0, 300) || response.statusText}`
        );
      }

      const json = (await response.json()) as VoyageResponse;
      const vectors = parseVectors(json, texts.length);

      for (let i = 0; i < vectors.length; i += 1) {
        if (vectors[i].length !== VOYAGE_DIMENSION) {
          throw new Error(
            `Voyage returned vector of length ${vectors[i].length} at index ${i}, expected ${VOYAGE_DIMENSION}.`
          );
        }
      }
      return vectors;
    }

    throw lastError ?? new Error("Voyage embedding failed.");
  }
}

/** Parse the response into number[][] in the original input order. */
function parseVectors(json: VoyageResponse, expectedCount: number): number[][] {
  if (Array.isArray(json.data)) {
    // OpenAI-compatible shape: data[] with per-item embedding + index.
    const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((d) => d.embedding ?? []);
    if (vectors.length !== expectedCount) {
      throw new Error(
        `Voyage returned ${vectors.length} vectors, expected ${expectedCount}.`
      );
    }
    return vectors;
  }
  if (Array.isArray(json.embeddings)) {
    if (json.embeddings.length !== expectedCount) {
      throw new Error(
        `Voyage returned ${json.embeddings.length} vectors, expected ${expectedCount}.`
      );
    }
    return json.embeddings;
  }
  throw new Error("Voyage response did not contain an embeddings array.");
}

export function createVoyageProvider(): EmbeddingProvider {
  return new VoyageEmbeddingProvider();
}
