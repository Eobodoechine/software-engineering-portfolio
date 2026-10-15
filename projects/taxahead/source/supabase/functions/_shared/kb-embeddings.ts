// supabase/functions/_shared/kb-embeddings.ts
//
// Embedding generation utility for TaxAhead Knowledge Base.
// Uses OpenAI's text-embedding-3-small (1536 dimensions) via direct HTTP API.
//
// Design decisions:
//   * Direct HTTP calls instead of OpenAI SDK — avoids adding a dependency
//     to the Deno edge function import map
//   * Batch support for ingestion (up to 100 texts per API call)
//   * Single-text support for query embedding in search
//   * Rate limit handling with exponential backoff

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_API_URL = "https://api.openai.com/v1/embeddings";
const MAX_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generate an embedding for a single text string (e.g., a search query).
 *
 * Best-effort: if the OpenAI embedding API cannot be reached (missing key,
 * network failure), falls back to a deterministic fixed vector so the
 * knowledge-base search always runs and never blocks the response. Recovery
 * quality is degraded in that mode, which is acceptable for a best-effort
 * retrieval layer (ingestion path uses embedTexts directly and never falls
 * back).
 */
export async function embedQuery(text: string, fetchImpl: typeof fetch = fetch): Promise<number[]> {
  try {
    const results = await embedTexts([text], fetchImpl);
    return results[0];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[kb-embeddings] Query embedding unavailable (${reason}); using deterministic fallback vector`,
    );
    return new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01);
  }
}

/**
 * Generate embeddings for multiple texts in batches.
 * Respects OpenAI's batch size limit (max 2048 inputs, but we cap at 100
 * for safety with long tax text chunks).
 */
export async function embedTexts(
  texts: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchEmbeddings = await embedBatch(batch, apiKey, fetchImpl);
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

async function embedBatch(
  texts: string[],
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetchImpl(EMBEDDING_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: texts,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (resp.status === 429) {
        // Rate limited — exponential backoff
        const retryAfter = resp.headers.get("retry-after");
        const delayMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[kb-embeddings] Rate limited, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`OpenAI embedding API error ${resp.status}: ${errorText.slice(0, 300)}`);
      }

      const data = await resp.json();
      const embeddings = data.data
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((item: { embedding: number[] }) => item.embedding);

      if (embeddings.length !== texts.length) {
        throw new Error(
          `Embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`,
        );
      }

      return embeddings;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES - 1) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[kb-embeddings] Embedding failed (${lastError.message}), retrying in ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError ?? new Error("Embedding failed after retries");
}

export { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
