// supabase/functions/_shared/kb-reranker.ts
//
// Re-ranking layer for TaxAhead Knowledge Base search results.
// Primary: Cohere Rerank API (direct HTTP, no SDK).
// Fallback: keyword-overlap scoring when COHERE_API_KEY is not configured.
//
// Architecture:
//   1. Accepts raw search results from hybrid search (top-20 candidates)
//   2. Calls Cohere Rerank to score each result's relevance to the query
//   3. Returns re-ranked results sorted by relevance score
//
// The fallback scorer uses normalized token overlap (Jaccard-like) between
// query terms and chunk content. It's not as accurate as Cohere but provides
// reasonable ordering when the API is unavailable.

const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const COHERE_MODEL = "rerank-english-v3.0";
const MAX_COHERE_DOCS = 50;

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

export interface RerankInput {
  id: string;
  content: string;
  title?: string;
  // Preserve original scores for blended scoring
  vector_score?: number;
  text_score?: number;
  combined_score?: number;
}

export interface RerankOutput extends RerankInput {
  rerank_score: number;
}

/**
 * Re-rank search results using Cohere Rerank or fallback keyword overlap.
 * Returns results sorted by rerank_score (descending).
 */
export async function rerankResults(
  query: string,
  results: RerankInput[],
  opts?: {
    topK?: number;
    fetchImpl?: typeof fetch;
    apiKey?: string | null;
  },
): Promise<RerankOutput[]> {
  if (!results.length) return [];

  const topK = opts?.topK ?? results.length;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const cohereKey = opts && "apiKey" in opts ? (opts.apiKey ?? undefined) : env("COHERE_API_KEY");

  if (cohereKey) {
    try {
      return await cohereRerank(query, results, cohereKey, topK, fetchImpl);
    } catch {
      console.error("[kb-reranker] Cohere rerank failed; using keyword fallback");
    }
  }

  return keywordOverlapRerank(query, results, topK);
}

/**
 * Cohere Rerank API integration.
 * Sends query + documents, receives relevance scores.
 */
async function cohereRerank(
  query: string,
  results: RerankInput[],
  apiKey: string,
  topK: number,
  fetchImpl: typeof fetch,
): Promise<RerankOutput[]> {
  // Cohere accepts up to 1000 docs but we cap at 50 for cost control
  const docs = results
    .slice(0, MAX_COHERE_DOCS)
    .map((r) => (r.title ? `${r.title}: ${r.content}` : r.content));

  const resp = await fetchImpl(COHERE_RERANK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: COHERE_MODEL,
      query,
      documents: docs,
      top_n: Math.min(topK, docs.length),
      return_documents: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Cohere rerank API error ${resp.status}`);
  }

  const data: unknown = await resp.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Cohere rerank response must be an object");
  }
  const responseResults = (data as Record<string, unknown>).results;
  const expectedCount = Math.min(topK, docs.length);
  if (!Array.isArray(responseResults) || responseResults.length !== expectedCount) {
    throw new Error("Cohere rerank response has an invalid result count");
  }

  const seen = new Set<number>();
  const validated = responseResults.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Cohere rerank result must be an object");
    }
    const { index, relevance_score } = item as Record<string, unknown>;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= docs.length) {
      throw new Error("Cohere rerank result index is invalid");
    }
    if (seen.has(index as number)) {
      throw new Error("Cohere rerank result indices must be unique");
    }
    if (typeof relevance_score !== "number" || !Number.isFinite(relevance_score)) {
      throw new Error("Cohere rerank result score is invalid");
    }
    seen.add(index as number);
    return { index: index as number, relevance_score };
  });

  const reranked: RerankOutput[] = validated.map((item) => ({
    ...results[item.index],
    rerank_score: item.relevance_score,
  }));

  return reranked.sort((a, b) => b.rerank_score - a.rerank_score);
}

/**
 * Fallback: keyword-overlap reranking.
 * Computes a normalized overlap score between query terms and each result's content.
 *
 * Algorithm:
 *   1. Tokenize query and content (lowercase, strip punctuation)
 *   2. Remove stopwords (common English words)
 *   3. Compute overlap: |queryTerms ∩ contentTerms| / |queryTerms|
 *   4. Weight by original combined_score to break ties
 */
export function keywordOverlapRerank(
  query: string,
  results: RerankInput[],
  topK: number,
): RerankOutput[] {
  const queryTerms = tokenize(query);
  if (!queryTerms.size) {
    // No usable query terms: the retrieval score is the fallback score, but
    // ordering still follows the same deterministic score-descending contract.
    return results
      .map((result, inputPosition) => ({
        ...result,
        rerank_score: result.combined_score ?? 0,
        inputPosition,
      }))
      .sort((a, b) => b.rerank_score - a.rerank_score || a.inputPosition - b.inputPosition)
      .slice(0, Math.min(topK, results.length))
      .map(({ inputPosition: _inputPosition, ...result }) => result);
  }

  const scored = results.map(
    (
      result,
      inputPosition,
    ): RerankOutput & {
      inputPosition: number;
    } => {
      const contentText = result.title ? `${result.title} ${result.content}` : result.content;
      const contentTerms = tokenize(contentText);

      // Count overlapping terms
      let overlap = 0;
      for (const term of queryTerms) {
        if (contentTerms.has(term)) overlap++;
      }

      // Base score: fraction of query terms found in content
      const baseScore = overlap / queryTerms.size;

      // Blend with original retrieval score (weighted 70% keyword, 30% original)
      const originalScore = result.combined_score ?? 0;
      const blendedScore = baseScore * 0.7 + originalScore * 0.3;

      return {
        ...result,
        rerank_score: Math.min(blendedScore, 1),
        inputPosition,
      };
    },
  );

  return scored
    .sort((a, b) => b.rerank_score - a.rerank_score || a.inputPosition - b.inputPosition)
    .slice(0, Math.min(topK, results.length))
    .map(({ inputPosition: _inputPosition, ...result }) => result);
}

// --- Tokenization helpers ---

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
]);

/**
 * Tokenize text into a set of lowercase terms, removing stopwords and short tokens.
 */
function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  // Split on non-alphanumeric characters, lowercase, filter stopwords and short tokens
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (token.length >= 2 && !STOPWORDS.has(token)) {
      terms.add(token);
    }
  }
  return terms;
}
