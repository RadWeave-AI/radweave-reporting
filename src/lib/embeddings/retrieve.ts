/**
 * Semantic retrieval of a user's OWN past report templates, by embedding
 * similarity. Used by the My-Templates generation path to supply style examples.
 *
 * Security: the cosine search runs inside the DB via the SECURITY DEFINER RPC
 * `match_user_template_embeddings`, which scopes every row to auth.uid(). This
 * MUST be called with the AUTHENTICATED supabase client (the one carrying the
 * user's JWT) — called with the service-role client, auth.uid() is null and it
 * returns zero rows. No user_id is passed, so cross-user access is impossible.
 *
 * Resilience: any failure (embedding 429, RPC error) is caught and returns [] —
 * retrieval must NEVER break report generation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmbeddingProvider } from "./index.ts";

export interface SimilarUserTemplate {
  user_template_id: string;
  title: string;
  findings_text: string;
  conclusion_text: string | null;
  similarity: number; // 1 - cosine_distance; higher = more similar
}

export async function retrieveSimilarUserTemplates(args: {
  /** MUST be the authenticated client (supabaseAuth) so auth.uid() resolves. */
  supabase: SupabaseClient;
  queryText: string;
  limit?: number;
  excludeTemplateId?: string;
}): Promise<SimilarUserTemplate[]> {
  const { supabase, queryText, excludeTemplateId } = args;
  const limit = args.limit ?? 3;

  if (!queryText?.trim()) return [];

  try {
    // 1. Embed the current case as a search query.
    const provider = getEmbeddingProvider();
    const [vector] = await provider.embed([queryText], "query");
    if (!vector || vector.length !== provider.dimension) return [];
    // pgvector text input format — accepted by PostgREST for the vector(1024) arg.
    const vecLiteral = `[${vector.join(",")}]`;

    // 2. Per-user cosine search inside the DB (auth.uid() scoped server-side).
    const { data, error } = await supabase.rpc("match_user_template_embeddings", {
      query_embedding: vecLiteral,
      match_count: limit,
      exclude_template_id: excludeTemplateId ?? null,
      model_name: provider.model,
    });
    if (error) throw new Error(error.message);

    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      user_template_id: String(r.user_template_id),
      title: (r.title as string) ?? "",
      findings_text: (r.findings_text as string) ?? "",
      conclusion_text: (r.conclusion_text as string | null) ?? null,
      similarity: typeof r.similarity === "number" ? r.similarity : Number(r.similarity),
    }));
  } catch (err) {
    // Never break generation — degrade to no examples.
    console.warn(
      "[retrieveSimilarUserTemplates] degraded to no examples:",
      err instanceof Error ? err.message : "unknown error"
    );
    return [];
  }
}

