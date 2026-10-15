/**
 * Global Vertex AI Rate Limiter
 *
 * Process-wide singleton that ALL Vertex API calls must use.
 * Enforces strict isolation for S0 falsifier test (inflight=1).
 */

import pLimit from 'p-limit';

// Process-wide singleton state
let globalLimiter: ReturnType<typeof pLimit> | null = null;
let limiterCallCount = 0;
let lastAttemptEndMs = 0;
let inflightCounter = 0;

/**
 * Get or create the global Vertex limiter
 */
export function getGlobalVertexLimiter() {
  if (!globalLimiter) {
    const limit = parseInt(process.env.VERTEX_CONCURRENCY_LIMIT || '1', 10);
    globalLimiter = pLimit(limit);

    console.log(JSON.stringify({
      t: Date.now(),
      kind: 'VERTEX_LIMITER_INIT',
      capacity: limit,
      pid: process.pid
    }));
  }
  return globalLimiter;
}

/**
 * Wrapper for ALL Vertex API calls - prevents bypasses
 *
 * Features:
 * - Process-wide rate limiting
 * - Pacing with jitter
 * - Pre/post inflight tracking
 * - S0 strict fail-fast (pre=0, post=1)
 * - Actual gap measurement
 * - Structured logging
 */
export async function withVertexLimiter<T>(
  caller: string,
  jobId: string,
  fn: () => Promise<T>
): Promise<T> {
  const limiter = getGlobalVertexLimiter();
  const PACING_MS = parseInt(process.env.VERTEX_PACING_MS || '0', 10);
  const JITTER_MS = parseInt(process.env.VERTEX_PACING_JITTER_MS || '0', 10);

  return limiter(async () => {
    limiterCallCount++;

    // Track pre/post inflight
    const preInflight = inflightCounter;
    inflightCounter++;
    const postInflight = inflightCounter;

    // S0 STRICT FAIL-FAST: pre must be 0, post must be 1
    // This ensures zero overlap between attempts
    if (process.env.RUN_LABEL?.startsWith('S0')) {
      if (preInflight !== 0 || postInflight !== 1) {
        const violation = JSON.stringify({
          t: Date.now(),
          kind: 'S0_VIOLATION',
          pre_inflight: preInflight,
          post_inflight: postInflight,
          caller
        });
        console.error(violation);
        throw new Error(`S0 violated: pre=${preInflight}, post=${postInflight}`);
      }
    }

    // Measure actual gap from PREVIOUS attempt end
    const now = Date.now();
    const actualGapMs = lastAttemptEndMs > 0 ? now - lastAttemptEndMs : null;

    // Log attempt start
    console.log(JSON.stringify({
      t: now,
      kind: 'ATTEMPT_START',
      schema_version: 'v2',
      job_id: jobId,
      run_label: process.env.RUN_LABEL,
      caller,
      pre_inflight: preInflight,
      post_inflight: postInflight,
      actual_gap_ms: actualGapMs,
      expected_gap_ms: PACING_MS
    }));

    try {
      // Apply pacing before Vertex call
      if (PACING_MS > 0) {
        const delay = PACING_MS + (Math.random() * JITTER_MS);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Execute actual Vertex call
      const callStart = Date.now();
      const result = await fn();
      const callEnd = Date.now();

      // Update state
      inflightCounter--;
      lastAttemptEndMs = callEnd; // For next attempt's gap measurement

      // Log attempt end
      console.log(JSON.stringify({
        t: callEnd,
        kind: 'ATTEMPT_END',
        schema_version: 'v2',
        job_id: jobId,
        caller,
        pre_inflight: postInflight,
        post_inflight: inflightCounter,
        latency_ms: callEnd - callStart,
        success: true
      }));

      return result;
    } catch (error: any) {
      // Update state on error
      inflightCounter--;
      lastAttemptEndMs = Date.now();

      // Log attempt end with error
      console.log(JSON.stringify({
        t: Date.now(),
        kind: 'ATTEMPT_END',
        schema_version: 'v2',
        job_id: jobId,
        caller,
        pre_inflight: postInflight,
        post_inflight: inflightCounter,
        success: false,
        error: error.message
      }));

      throw error;
    }
  });
}

/**
 * Get total number of calls through the limiter
 * Used for integrity checks at job end
 */
export function getLimiterCallCount(): number {
  return limiterCallCount;
}
