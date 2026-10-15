/**
 * Feature Flags for V12 Rollout
 * Based on v12.1 spec:
 * - NEW_ORCHESTRATOR_V12: Enable new parallel search orchestrator
 * - USE_VERTEX_PROXY: Route Vertex calls through proxy service
 * - USE_VERTEX_CLIENT: Use optimized Vertex client with keep-alive and retries
 * - VERTEX_CONCURRENCY: Max concurrent Vertex requests
 */

export interface FeatureFlags {
  newOrchestratorV12: boolean;
  useVertexProxy: boolean;
  useVertexClient: boolean;
  vertexConcurrency: number;
  geocodeNegativeCacheTTL: number;
  enableStructuredLogging: boolean;
  enableMetrics: boolean;
}

class FeatureFlagManager {
  private flags: FeatureFlags;

  constructor() {
    this.flags = this.loadFlags();
    this.logFlagStatus();
  }

  private loadFlags(): FeatureFlags {
    return {
      // V12 orchestrator (default: enabled in staging, disabled in prod)
      newOrchestratorV12: this.parseBoolean('NEW_ORCHESTRATOR_V12', true),

      // Vertex proxy (default: disabled after diagnosis showed it was broken)
      useVertexProxy: this.parseBoolean('USE_VERTEX_PROXY', false),

      // Vertex client with keep-alive and retries (default: enabled)
      useVertexClient: this.parseBoolean('USE_VERTEX_CLIENT', true),

      // Vertex concurrency limit (default: 6)
      vertexConcurrency: this.parseInt('VERTEX_CONCURRENCY', 6),

      // Geocode negative cache TTL in seconds (default: 1800 = 30 min)
      geocodeNegativeCacheTTL: this.parseInt('GEOCODE_NEGATIVE_CACHE_TTL_SECONDS', 1800),

      // Structured logging (default: enabled)
      enableStructuredLogging: this.parseBoolean('ENABLE_STRUCTURED_LOGGING', true),

      // Metrics collection (default: enabled)
      enableMetrics: this.parseBoolean('ENABLE_METRICS', true),
    };
  }

  private parseBoolean(envVar: string, defaultValue: boolean): boolean {
    const value = process.env[envVar];
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
  }

  private parseInt(envVar: string, defaultValue: number): number {
    const value = process.env[envVar];
    if (value === undefined) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  private logFlagStatus() {
    jobLog('🚩 Feature Flags Status:');
    jobLog(`   NEW_ORCHESTRATOR_V12: ${this.flags.newOrchestratorV12}`);
    jobLog(`   USE_VERTEX_PROXY: ${this.flags.useVertexProxy}`);
    jobLog(`   USE_VERTEX_CLIENT: ${this.flags.useVertexClient}`);
    jobLog(`   VERTEX_CONCURRENCY: ${this.flags.vertexConcurrency}`);
    jobLog(`   GEOCODE_NEGATIVE_CACHE_TTL: ${this.flags.geocodeNegativeCacheTTL}s`);
    jobLog(`   ENABLE_STRUCTURED_LOGGING: ${this.flags.enableStructuredLogging}`);
    jobLog(`   ENABLE_METRICS: ${this.flags.enableMetrics}`);
  }

  /**
   * Get all flags
   */
  getFlags(): Readonly<FeatureFlags> {
    return this.flags;
  }

  /**
   * Check if new orchestrator is enabled
   */
  isNewOrchestratorEnabled(): boolean {
    return this.flags.newOrchestratorV12;
  }

  /**
   * Check if Vertex proxy is enabled
   */
  isVertexProxyEnabled(): boolean {
    return this.flags.useVertexProxy;
  }

  /**
   * Check if Vertex client is enabled
   */
  isVertexClientEnabled(): boolean {
    return this.flags.useVertexClient;
  }

  /**
   * Get Vertex concurrency limit
   */
  getVertexConcurrency(): number {
    return this.flags.vertexConcurrency;
  }

  /**
   * Get geocode negative cache TTL
   */
  getGeocodeNegativeCacheTTL(): number {
    return this.flags.geocodeNegativeCacheTTL;
  }

  /**
   * Check if structured logging is enabled
   */
  isStructuredLoggingEnabled(): boolean {
    return this.flags.enableStructuredLogging;
  }

  /**
   * Check if metrics collection is enabled
   */
  isMetricsEnabled(): boolean {
    return this.flags.enableMetrics;
  }

  /**
   * Update flag at runtime (for testing/rollout)
   */
  setFlag(key: keyof FeatureFlags, value: any) {
    console.warn(`⚠️  Runtime flag update: ${key} = ${value}`);
    (this.flags as any)[key] = value;
  }

  /**
   * Reload flags from environment
   */
  reload() {
    jobLog('🔄 Reloading feature flags from environment...');
    this.flags = this.loadFlags();
    this.logFlagStatus();
  }
}

// Singleton instance
export const featureFlags = new FeatureFlagManager();

/**
 * Rollout helper: Gradual percentage-based rollout
 */
export function shouldEnableForRequest(
  requestId: string,
  rolloutPercentage: number
): boolean {
  if (rolloutPercentage >= 100) return true;
  if (rolloutPercentage <= 0) return false;

  // Hash request ID to get consistent result for same request
  const hash = requestId.split('').reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);

  const bucket = Math.abs(hash) % 100;
  return bucket < rolloutPercentage;
}

/**
 * Canary deployment helper
 */
export function isCanaryRequest(requestId: string): boolean {
  // Route 10% of traffic to canary
  return shouldEnableForRequest(requestId, 10);
}
