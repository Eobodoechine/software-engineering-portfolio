/**
 * Error Handling Policy for V10 Parallel Search
 * Based on v12.1 spec:
 * - Vertex: retry 3×; on failure mark level "0 comps", continue
 * - Redis: log & continue (treat as miss)
 * - Geocode: cache negative with TTL; skip that address this run
 * - ARV: if below targets after passes, return best available with LOW_CONFIDENCE + reason
 */

import { logStructured, metrics } from './metrics';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ErrorContext {
  jobId?: string;
  reqId?: string;
  phase?: string;
  level?: number;
  address?: string;
  [key: string]: any;
}

/**
 * Handle Vertex API errors
 * Policy: Retry 3×; on failure mark level "0 comps", continue
 */
export function handleVertexError(
  error: Error,
  context: ErrorContext,
  attemptNumber: number
): { shouldRetry: boolean; shouldContinue: boolean } {
  const isRetryableError =
    error.message?.includes('ETIMEDOUT') ||
    error.message?.includes('ECONNRESET') ||
    error.message?.includes('ENOTFOUND') ||
    error.message?.includes('socket hang up') ||
    error.message?.includes('retryable') ||
    error.message?.includes('429') ||
    error.message?.includes('503') ||
    error.message?.includes('500');

  const shouldRetry = isRetryableError && attemptNumber < 3;

  logStructured(
    'ERROR',
    `Vertex API error (attempt ${attemptNumber}/3)`,
    context,
    {
      error: error.message,
      stack: error.stack,
      retryable: isRetryableError,
      willRetry: shouldRetry,
    }
  );

  metrics.recordVertexCall(context.phase || 'unknown', false, attemptNumber - 1);

  return {
    shouldRetry,
    shouldContinue: !shouldRetry, // Continue if out of retries
  };
}

/**
 * Handle Redis errors
 * Policy: Log & continue (treat as miss)
 */
export function handleRedisError(error: Error, operation: string, context: ErrorContext): void {
  logStructured('WARN', `Redis ${operation} error - treating as miss`, context, {
    error: error.message,
    stack: error.stack,
  });

  metrics.recordRedisOp(false);
}

/**
 * Handle geocode errors
 * Policy: Cache negative with TTL; skip that address this run
 */
export async function handleGeocodeError(
  error: Error,
  address: string,
  context: ErrorContext,
  geocodeCache: any
): Promise<void> {
  logStructured('WARN', `Geocode error for address - caching failure`, context, {
    address,
    error: error.message,
    stack: error.stack,
  });

  // Cache negative result with TTL (handled by geocodeCache.setFailure)
  try {
    await geocodeCache.setFailure(address, error.message);
  } catch (cacheError) {
    // Ignore cache errors
    logStructured('WARN', 'Failed to cache geocode failure', context, {
      address,
      cacheError: cacheError instanceof Error ? cacheError.message : String(cacheError),
    });
  }
}

/**
 * Determine confidence level based on results
 */
export function determineConfidence(
  qualifiedComps: any[],
  passLevel: number,
  target: number,
  totalRawComps: number
): { confidence: ConfidenceLevel; reason?: string } {
  // No comps at all
  if (qualifiedComps.length === 0) {
    return {
      confidence: 'NONE',
      reason: 'NO_COMPS_IN_MARKET',
    };
  }

  // Met or exceeded target with Pass 1 or 2 (strictest criteria)
  if (passLevel <= 2 && qualifiedComps.length >= target) {
    return { confidence: 'HIGH' };
  }

  // Met or exceeded target with Pass 3 (moderate criteria)
  if (passLevel === 3 && qualifiedComps.length >= target) {
    return { confidence: 'MEDIUM' };
  }

  // Met or exceeded target with Pass 4 (relaxed criteria)
  if (passLevel === 4 && qualifiedComps.length >= target) {
    return { confidence: 'MEDIUM' };
  }

  // Below target but have some comps
  if (qualifiedComps.length < target && qualifiedComps.length > 0) {
    return {
      confidence: 'LOW',
      reason: `BELOW_TARGET (${qualifiedComps.length}/${target} comps from Pass ${passLevel})`,
    };
  }

  // Fallback: Very few raw comps available
  if (totalRawComps < 10) {
    return {
      confidence: 'LOW',
      reason: 'LIMITED_MARKET_DATA',
    };
  }

  return { confidence: 'LOW', reason: 'UNKNOWN' };
}

/**
 * Format error result for API response
 */
export interface ErrorResult {
  qualifiedComps: any[];
  searchMetadata: {
    confidence: ConfidenceLevel;
    reason?: string;
    error?: string;
    totalRawComps: number;
    levelsRun: number[];
    totalSearchTime: number;
  };
}

export function formatErrorResult(
  bestComps: any[],
  passLevel: number,
  target: number,
  totalRawComps: number,
  levelsRun: number[],
  totalSearchTime: number,
  error?: string
): ErrorResult {
  const { confidence, reason } = determineConfidence(
    bestComps,
    passLevel,
    target,
    totalRawComps
  );

  return {
    qualifiedComps: bestComps,
    searchMetadata: {
      confidence,
      reason,
      error,
      totalRawComps,
      levelsRun,
      totalSearchTime,
    },
  };
}

/**
 * Wrap async operation with error handling
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  fallback: T,
  errorHandler: (error: Error) => void
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    errorHandler(error instanceof Error ? error : new Error(String(error)));
    return fallback;
  }
}
