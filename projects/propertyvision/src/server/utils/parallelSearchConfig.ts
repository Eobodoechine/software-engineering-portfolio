// Parallel Search Configuration
// Environment variables and feature flags for parallel comparable search

export interface ParallelSearchConfig {
  enabled: boolean;
  levels: number[];
  vertexLocalConcurrency: number;
  vertexGlobalConcurrency: number;
  geocodeConcurrency: number;
  topKPerPass: number;
  targetComps: number;
  minCompsThreshold: number;
  geocodeMaxAttempts: number;
  geocodeRetryBaseMs: number;
  geocodeRetryJitterMs: number;
  phase1Levels: number[];
  phase2Levels: number[];
}

export function getParallelSearchConfig(): ParallelSearchConfig {
  // V10 is now the default - set PV_PARALLEL_SEARCH=off to disable
  const enabled = process.env.PV_PARALLEL_SEARCH !== 'off';

  // Parse levels from CSV (e.g., "1,2,3,4")
  const levelsStr = process.env.PV_LEVELS || '1,2,3,4';
  const levels = levelsStr.split(',').map(Number).filter(n => n >= 1 && n <= 4);

  return {
    enabled,
    levels,
    // High concurrency for true parallelism - all 4 levels × ~18 searches each = 72 concurrent
    vertexLocalConcurrency: Number(process.env.PV_VERTEX_LOCAL_CONC || 80),
    vertexGlobalConcurrency: Number(process.env.PV_VERTEX_GLOBAL_CONC || 80),
    geocodeConcurrency: Number(process.env.PV_GEOCODE_CONC || 20),
    topKPerPass: Number(process.env.PV_TOPK_PER_PASS || 16),
    targetComps: Number(process.env.PV_TARGET_COMPS || 6),
    minCompsThreshold: Number(process.env.PV_MIN_COMPS_THRESHOLD || 3),
    // Geocode front-door retry (shape from v10:test-geocode-improvements.ts)
    geocodeMaxAttempts: Number(process.env.PV_GEOCODE_MAX_ATTEMPTS || 3),
    geocodeRetryBaseMs: Number(process.env.PV_GEOCODE_RETRY_BASE_MS || 500),
    geocodeRetryJitterMs: Number(process.env.PV_GEOCODE_RETRY_JITTER_MS || 400),
    phase1Levels: [1, 2],
    phase2Levels: [3, 4],
  };
}

// Export singleton config
export const parallelSearchConfig = getParallelSearchConfig();
