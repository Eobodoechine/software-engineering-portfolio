// supabase/functions/search-knowledge/index.ts
//
// Hybrid search over the TaxAhead Knowledge Base (KB2 corpus).
// Combines vector similarity (pgvector cosine) with full-text search (tsvector BM25)
// using Reciprocal Rank Fusion, then returns top-K results with [K*] citation keys.
//
// Architecture:
//   POST { query, layer?, top_k?, state? }
//   1. Generate query embedding via OpenAI text-embedding-3-small
//   2. Call search_knowledge_base() RPC (hybrid search + RRF in Postgres)
//   3. Re-rank results via Cohere Rerank (or keyword-overlap fallback)
//   4. Return top-K results with citation keys [K1], [K2], ...
//
// Jurisdiction filtering:
//   The optional `state` parameter (e.g., "GA", "CA") filters results to include
//   federal (US-FED) knowledge plus state-specific knowledge for the given state.
//   Each result is tagged with a `jurisdiction` field: "US-FED" or "US-{STATE}".
//
// Auth-gated: requires authenticated user (JWT in Authorization header).
// Knowledge base is NOT tenant-specific — all authenticated users search the same corpus.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedQuery } from "../_shared/kb-embeddings.ts";
import { rerankResults, type RerankInput } from "../_shared/kb-reranker.ts";
import { logger } from "../_shared/logger.ts";
import {
  authorizePaidFeature,
  paidEntitlementErrorBody,
  type PaidEntitlementAuthorizer,
} from "../_shared/paid-entitlements.ts";

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const MAX_QUERY_LEN = 2000;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// The Supabase client is only used for .rpc() and .from().select() calls whose
// result shapes are described by SearchRow / SearchRowExtras below.
type SupabaseLike = {
  rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => unknown;
};

export interface SearchResult {
  id: string;
  source_file: string;
  layer: string;
  title: string;
  content: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  vector_score: number;
  text_score: number;
  combined_score: number;
  rerank_score: number;
  citation_key: string; // [K1], [K2], etc.
  jurisdiction: string; // "US-FED" or "US-{STATE}"
  jurisdiction_type: string;
  tax_year: number | null;
  effective_start: string | null;
  effective_end: string | null;
  source_url: string | null;
  source_version: string | null;
  authority_type: string;
  confidence: number;
}

type SearchRow = Pick<
  SearchResult,
  "id" | "content" | "title" | "vector_score" | "text_score" | "combined_score"
>;

type SearchRowExtras = {
  source_file: string;
  layer: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  jurisdiction?: string;
  jurisdiction_type?: string;
  tax_year?: number | null;
  effective_start?: string | null;
  effective_end?: string | null;
  source_url?: string | null;
  source_version?: string | null;
  authority_type?: string;
  confidence?: number;
};

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  result_count: number;
  state_filter: string | null;
}

export async function handler(
  req: Request,
  deps?: {
    supabase?: SupabaseLike;
    fetch?: typeof fetch;
    paidEntitlement?: PaidEntitlementAuthorizer;
  },
): Promise<Response> {
  const log = logger("search-knowledge");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    log.error("missing_authorization");
    return json({ error: "missing_authorization" }, 401);
  }

  let body: {
    query?: string;
    layer?: string;
    top_k?: number;
    state?: string;
    tax_year?: number;
    min_confidence?: number;
    effective_date?: string;
  };
  try {
    body = await req.json();
  } catch {
    log.error("invalid_body", { detail: "failed to parse JSON body" });
    return json({ error: "invalid_body" }, 400);
  }

  const { query, layer, top_k, state } = body;
  if (!query || typeof query !== "string") {
    log.error("query_required");
    return json({ error: "query_required" }, 400);
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    log.error("query_empty");
    return json({ error: "query_empty" }, 400);
  }
  if (trimmedQuery.length > MAX_QUERY_LEN) {
    log.error("query_too_long", { length: trimmedQuery.length });
    return json({ error: "query_too_long", max_length: MAX_QUERY_LEN }, 400);
  }

  const matchCount = Math.min(Math.max(top_k ?? DEFAULT_TOP_K, 1), MAX_TOP_K);

  // Jurisdiction filter: validate state code format (2-letter uppercase)
  const normalizedState = state?.trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(normalizedState ?? "")) {
    log.error("invalid_state_code", { state });
    return json(
      { error: "invalid_state_code", detail: "Expected 2-letter state code (e.g., GA, CA)" },
      400,
    );
  }
  // Build jurisdiction filter: always include US-FED; add US-{STATE} if state specified
  const jurisdictionFilter = normalizedState ? ["US-FED", `US-${normalizedState}`] : null; // null = no filter (return all jurisdictions)
  const taxYearFilter = Number.isInteger(body.tax_year) ? body.tax_year! : null;
  const minConfidence = typeof body.min_confidence === "number" ? body.min_confidence : 0;
  const effectiveDateFilter = body.effective_date ?? currentDate();

  const supabaseUrl = env("SUPABASE_URL") ?? "";
  const supabaseAnonKey = env("SUPABASE_ANON_KEY") ?? "";
  const supabase: SupabaseLike =
    deps?.supabase ??
    (createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    }) as unknown as SupabaseLike);
  const entitlement = deps?.paidEntitlement
    ? await deps.paidEntitlement(supabase, "advisor")
    : deps?.supabase
      ? ({ allowed: true, status: 200, reason: "entitled", feature: "advisor" } as const)
      : await authorizePaidFeature(supabase, "advisor");
  if (!entitlement.allowed) {
    log.error(entitlement.error, { feature: entitlement.feature });
    return json(paidEntitlementErrorBody(entitlement), entitlement.status);
  }

  const fetchImpl = deps?.fetch ?? fetch;

  // Step 1: Generate query embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQuery(trimmedQuery, fetchImpl);
  } catch (e) {
    log.error("embedding_failed", { detail: String(e) });
    console.error("[search-knowledge] Embedding failed:", e);
    return json({ error: "embedding_failed" }, 502);
  }

  // Step 2: Call the hybrid search RPC
  // Retrieve more candidates than requested for re-ranking (top-20 → re-rank → top-K)
  const candidateCount = Math.min(matchCount * 3, MAX_TOP_K);

  const { data: searchResults, error: searchError } = await supabase.rpc("search_knowledge_base", {
    query_embedding: JSON.stringify(queryEmbedding),
    query_text: trimmedQuery,
    match_count: candidateCount,
    layer_filter: layer ?? null,
    jurisdiction_filter: jurisdictionFilter,
    tax_year_filter: taxYearFilter,
    min_confidence: minConfidence,
    effective_date_filter: effectiveDateFilter,
  });

  if (searchError) {
    log.error("search_failed", { detail: searchError.message });
    console.error("[search-knowledge] Search RPC failed:", searchError);
    return json({ error: "search_failed", detail: searchError.message }, 500);
  }

  // Step 3: Format raw results for re-ranking
  const rawResults: RerankInput[] = ((searchResults ?? []) as (SearchRow & SearchRowExtras)[]).map(
    (row) => ({
      id: row.id,
      content: row.content,
      title: row.title,
      vector_score: row.vector_score ?? 0,
      text_score: row.text_score ?? 0,
      combined_score: row.combined_score ?? 0,
      source_file: row.source_file,
      layer: row.layer,
      chunk_index: row.chunk_index,
      metadata: row.metadata ?? {},
      jurisdiction: row.jurisdiction ?? "US-FED",
      jurisdiction_type: row.jurisdiction_type ?? "federal",
      tax_year: row.tax_year ?? null,
      effective_start: row.effective_start ?? null,
      effective_end: row.effective_end ?? null,
      source_url: row.source_url ?? null,
      source_version: row.source_version ?? null,
      authority_type: row.authority_type ?? "secondary",
      confidence: row.confidence ?? 0.5,
    }),
  );

  // Step 4: Re-rank results
  const reranked = await rerankResults(trimmedQuery, rawResults, {
    topK: matchCount,
    fetchImpl,
  });

  // Step 5: Build final results with citation keys and jurisdiction tags
  const results: SearchResult[] = reranked.map((rawItem, index: number) => {
    const item = rawItem as typeof rawItem & SearchRowExtras;
    return {
      id: item.id,
      source_file: item.source_file,
      layer: item.layer,
      title: item.title ?? "",
      content: item.content,
      chunk_index: item.chunk_index ?? 0,
      metadata: item.metadata ?? {},
      vector_score: item.vector_score ?? 0,
      text_score: item.text_score ?? 0,
      combined_score: item.combined_score ?? 0,
      rerank_score: item.rerank_score,
      citation_key: `K${index + 1}`,
      jurisdiction: item.jurisdiction ?? deriveJurisdiction(item.metadata ?? {}, item.source_file),
      jurisdiction_type: item.jurisdiction_type ?? "federal",
      tax_year: item.tax_year ?? null,
      effective_start: item.effective_start ?? null,
      effective_end: item.effective_end ?? null,
      source_url: item.source_url ?? null,
      source_version: item.source_version ?? null,
      authority_type: item.authority_type ?? "secondary",
      confidence: item.confidence ?? 0.5,
    };
  });

  const response: SearchResponse = {
    results,
    query: trimmedQuery,
    result_count: results.length,
    state_filter: normalizedState ?? null,
  };

  return json(response);
}

/**
 * Internal function for use by other edge functions (e.g., ask-taxahead).
 * Performs the same hybrid search but returns results directly without HTTP wrapping.
 */
export async function searchKnowledgeBase(
  query: string,
  opts: {
    supabase: SupabaseLike;
    fetch?: typeof fetch;
    topK?: number;
    layer?: string;
    state?: string;
    taxYear?: number | null;
    minConfidence?: number;
    effectiveDate?: string;
  },
): Promise<SearchResult[]> {
  const fetchImpl = opts.fetch ?? fetch;
  const matchCount = opts.topK ?? DEFAULT_TOP_K;

  // Jurisdiction filter
  const normalizedState = opts.state?.trim().toUpperCase();
  const jurisdictionFilter =
    normalizedState && /^[A-Z]{2}$/.test(normalizedState)
      ? ["US-FED", `US-${normalizedState}`]
      : null;

  // Generate query embedding
  const queryEmbedding = await embedQuery(query, fetchImpl);

  // Retrieve more candidates for re-ranking
  const candidateCount = Math.min(matchCount * 3, MAX_TOP_K);

  // Call the hybrid search RPC
  const { data, error } = await opts.supabase.rpc("search_knowledge_base", {
    query_embedding: JSON.stringify(queryEmbedding),
    query_text: query,
    match_count: candidateCount,
    layer_filter: opts.layer ?? null,
    jurisdiction_filter: jurisdictionFilter,
    tax_year_filter: opts.taxYear ?? null,
    min_confidence: opts.minConfidence ?? 0,
    effective_date_filter: opts.effectiveDate ?? currentDate(),
  });

  if (error || !data) {
    console.error("[search-knowledge] Internal search failed:", error);
    return [];
  }

  const rawResults: RerankInput[] = (data as (SearchRow & SearchRowExtras)[]).map((row) => ({
    id: row.id,
    content: row.content,
    title: row.title,
    vector_score: row.vector_score ?? 0,
    text_score: row.text_score ?? 0,
    combined_score: row.combined_score ?? 0,
    source_file: row.source_file,
    layer: row.layer,
    chunk_index: row.chunk_index,
    metadata: row.metadata ?? {},
    jurisdiction: row.jurisdiction ?? "US-FED",
    jurisdiction_type: row.jurisdiction_type ?? "federal",
    tax_year: row.tax_year ?? null,
    effective_start: row.effective_start ?? null,
    effective_end: row.effective_end ?? null,
    source_url: row.source_url ?? null,
    source_version: row.source_version ?? null,
    authority_type: row.authority_type ?? "secondary",
    confidence: row.confidence ?? 0.5,
  }));

  // Re-rank results
  const reranked = await rerankResults(query, rawResults, {
    topK: matchCount,
    fetchImpl,
  });

  return reranked.map((rawItem, index: number): SearchResult => {
    const item = rawItem as typeof rawItem & SearchRowExtras;
    return {
      id: item.id,
      source_file: item.source_file,
      layer: item.layer,
      title: item.title ?? "",
      content: item.content,
      chunk_index: item.chunk_index ?? 0,
      metadata: item.metadata ?? {},
      vector_score: item.vector_score ?? 0,
      text_score: item.text_score ?? 0,
      combined_score: item.combined_score ?? 0,
      rerank_score: item.rerank_score ?? 0,
      citation_key: `K${index + 1}`,
      jurisdiction:
        item.jurisdiction ?? deriveJurisdiction(item.metadata ?? {}, item.source_file ?? ""),
      jurisdiction_type: item.jurisdiction_type ?? "federal",
      tax_year: item.tax_year ?? null,
      effective_start: item.effective_start ?? null,
      effective_end: item.effective_end ?? null,
      source_url: item.source_url ?? null,
      source_version: item.source_version ?? null,
      authority_type: item.authority_type ?? "secondary",
      confidence: item.confidence ?? 0.5,
    };
  });
}

/**
 * Derive the jurisdiction from chunk metadata or source file path.
 * Priority: metadata.jurisdiction > source file path pattern > "US-FED" (default).
 */
export function deriveJurisdiction(metadata: Record<string, unknown>, sourceFile: string): string {
  // Check explicit metadata field first
  const metaJurisdiction = metadata.jurisdiction;
  if (typeof metaJurisdiction === "string" && /^US-[A-Z]{2,3}$/.test(metaJurisdiction)) {
    return metaJurisdiction;
  }

  // Infer from source file path (e.g., "state_knowledge/california.md" → "US-CA")
  const lower = sourceFile.toLowerCase();
  const stateMappings: [string, string][] = [
    ["alabama", "US-AL"],
    ["alaska", "US-AK"],
    ["arizona", "US-AZ"],
    ["arkansas", "US-AR"],
    ["california", "US-CA"],
    ["colorado", "US-CO"],
    ["connecticut", "US-CT"],
    ["delaware", "US-DE"],
    ["florida", "US-FL"],
    ["georgia", "US-GA"],
    ["hawaii", "US-HI"],
    ["idaho", "US-ID"],
    ["illinois", "US-IL"],
    ["indiana", "US-IN"],
    ["iowa", "US-IA"],
    ["kansas", "US-KS"],
    ["kentucky", "US-KY"],
    ["louisiana", "US-LA"],
    ["maine", "US-ME"],
    ["maryland", "US-MD"],
    ["massachusetts", "US-MA"],
    ["michigan", "US-MI"],
    ["minnesota", "US-MN"],
    ["mississippi", "US-MS"],
    ["missouri", "US-MO"],
    ["montana", "US-MT"],
    ["nebraska", "US-NE"],
    ["nevada", "US-NV"],
    ["new hampshire", "US-NH"],
    ["new jersey", "US-NJ"],
    ["new mexico", "US-NM"],
    ["new york", "US-NY"],
    ["north carolina", "US-NC"],
    ["north dakota", "US-ND"],
    ["ohio", "US-OH"],
    ["oklahoma", "US-OK"],
    ["oregon", "US-OR"],
    ["pennsylvania", "US-PA"],
    ["rhode island", "US-RI"],
    ["south carolina", "US-SC"],
    ["south dakota", "US-SD"],
    ["tennessee", "US-TN"],
    ["texas", "US-TX"],
    ["utah", "US-UT"],
    ["vermont", "US-VT"],
    ["virginia", "US-VA"],
    ["washington", "US-WA"],
    ["west virginia", "US-WV"],
    ["wisconsin", "US-WI"],
    ["wyoming", "US-WY"],
    ["district of columbia", "US-DC"],
  ];
  for (const [name, code] of stateMappings) {
    if (lower.includes(name)) return code;
  }

  return "US-FED";
}

if (import.meta.main) {
  Deno.serve((req) => handler(req));
}
