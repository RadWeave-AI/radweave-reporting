/**
 * Provider-agnostic embedding interface.
 *
 * Call sites depend ONLY on this interface (obtained via
 * getEmbeddingProvider() in ./index), never on a concrete provider. This is the
 * swap seam: replacing Voyage with OpenAI / a self-hosted model later means
 * adding a new implementation and changing the factory — no call-site changes.
 */
export interface EmbeddingProvider {
  /** Exact provider model string (e.g. "voyage-4"). */
  readonly model: string;
  /** Output vector dimension — must match the DB `vector(N)` column. */
  readonly dimension: number;
  /**
   * Embed one or more texts, preserving input order in the output.
   * @param inputType Voyage-style asymmetric hint: "document" for stored
   *   content, "query" for the live search text. Optional.
   */
  embed(texts: string[], inputType?: "document" | "query"): Promise<number[][]>;
}

