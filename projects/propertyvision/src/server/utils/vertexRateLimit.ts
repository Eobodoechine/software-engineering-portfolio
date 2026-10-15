/**
 * Vertex AI Rate Limiter
 *
 * Global rate limiting for all Vertex AI calls to prevent quota exhaustion.
 * Uses Bottleneck for token-bucket rate limiting + exponential backoff retry logic.
 */

import Bottleneck from 'bottleneck';
import { jobLog } from './jobLogger';

// Global rate limiter for all Vertex AI calls
// Configured via environment variables for easy tuning
export const vertexLimiter = new Bottleneck({
  // Token bucket: refill 'reservoir' tokens every 'reservoirRefreshInterval'
  reservoir: Number(process.env.PV_VERTEX_RPS ?? 4),
  reservoirRefreshAmount: Number(process.env.PV_VERTEX_RPS ?? 4),
  reservoirRefreshInterval: 1000, // Refresh every second

  // Max concurrent requests (global across all call types)
  maxConcurrent: Number(process.env.PV_VERTEX_MAX_CONCURRENCY ?? 2),
});

jobLog(`✅ Vertex rate limiter initialized: RPS=${process.env.PV_VERTEX_RPS ?? 4}, MaxConcurrent=${process.env.PV_VERTEX_MAX_CONCURRENCY ?? 2}`);

/**
 * Retry wrapper with exponential backoff + jitter
 *
 * Handles:
 * - 429 (rate limit exceeded)
 * - 5xx (server errors)
 *
 * Respects Retry-After header if present.
 *
 * @param fn - Async function to execute with retries
 * @param context - Context string for logging
 * @returns Promise<T> - Result from fn
 */
export async function callWithRetries<T>(
  fn: () => Promise<T>,
  context = 'vertex-call'
): Promise<T> {
  const maxRetries = 4;

  for (let attempt = 0; ; attempt++) {
    try {
      // Schedule through rate limiter (blocks if quota exhausted)
      return await vertexLimiter.schedule(fn);
    } catch (error: any) {
      // Extract error code from various error formats
      const code = error?.code || error?.statusCode || error?.response?.status;
      const retryAfterHeader = Number(error?.response?.headers?.['retry-after']) || 0;

      // Only retry 429 (rate limit) and 5xx (server errors)
      const isRetriable = code === 429 || (code >= 500 && code < 600);

      if (!isRetriable || attempt >= maxRetries) {
        jobLog(`❌ ${context}: Non-retriable error or max retries reached (${attempt}/${maxRetries}), code=${code}`);
        throw error;
      }

      // Calculate backoff: respect Retry-After header, else exponential + jitter
      const backoffMs = retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : (2 ** attempt) * 1000 + Math.floor(Math.random() * 400); // Exponential + jitter

      jobLog(`⏳ ${context}: Retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms (code=${code})`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}
