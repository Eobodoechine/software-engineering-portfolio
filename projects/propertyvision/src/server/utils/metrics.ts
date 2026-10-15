/**
 * Metrics and Structured Logging for V10 Parallel Search
 * - Structured JSON logs with jobId, reqId, phase, level, timings
 * - In-memory metrics counters for Vertex, geocode, Redis ops
 * - SLO monitoring and alerting thresholds
 */

import { jobLog } from './jobLogger';

interface MetricsCounter {
  total: number;
  failed: number;
  retries: number;
}

interface TimingHistogram {
  samples: number[];
  count: number;
  sum: number;
  max: number;
  min: number;
}

class Metrics {
  // Vertex metrics
  private vertexCalls: MetricsCounter = { total: 0, failed: 0, retries: 0 };
  private vertexCallsByType: Map<string, MetricsCounter> = new Map();

  // Geocode metrics
  private geocodeCalls: { total: number; cacheHits: number; cacheMisses: number } = {
    total: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private geocodeBatchSizes: TimingHistogram = {
    samples: [],
    count: 0,
    sum: 0,
    max: 0,
    min: Infinity,
  };

  // Redis metrics
  private redisOps: MetricsCounter = { total: 0, failed: 0, retries: 0 };

  // Search metrics
  private searchLevelDurations: Map<number, TimingHistogram> = new Map();
  private passUsed: Map<number, number> = new Map();
  private totalJobDurations: TimingHistogram = {
    samples: [],
    count: 0,
    sum: 0,
    max: 0,
    min: Infinity,
  };

  // SLO thresholds (from v12.1 spec)
  private readonly VERTEX_FAILURE_RATE_THRESHOLD = 0.05; // 5%
  private readonly AVG_JOB_DURATION_THRESHOLD = 6 * 60 * 1000; // 6 minutes
  private readonly GEOCODE_HIT_RATE_THRESHOLD = 0.6; // 60%

  /**
   * Record Vertex API call
   */
  recordVertexCall(type: string, success: boolean, retries: number = 0) {
    this.vertexCalls.total++;
    if (!success) this.vertexCalls.failed++;
    if (retries > 0) this.vertexCalls.retries += retries;

    if (!this.vertexCallsByType.has(type)) {
      this.vertexCallsByType.set(type, { total: 0, failed: 0, retries: 0 });
    }
    const typeMetrics = this.vertexCallsByType.get(type)!;
    typeMetrics.total++;
    if (!success) typeMetrics.failed++;
    if (retries > 0) typeMetrics.retries += retries;
  }

  /**
   * Record geocode operation
   */
  recordGeocode(cacheHit: boolean) {
    this.geocodeCalls.total++;
    if (cacheHit) {
      this.geocodeCalls.cacheHits++;
    } else {
      this.geocodeCalls.cacheMisses++;
    }
  }

  /**
   * Record geocode batch size
   */
  recordGeocodeBatchSize(size: number) {
    this.addToHistogram(this.geocodeBatchSizes, size);
  }

  /**
   * Record Redis operation
   */
  recordRedisOp(success: boolean) {
    this.redisOps.total++;
    if (!success) this.redisOps.failed++;
  }

  /**
   * Record search level duration
   */
  recordSearchLevelDuration(level: number, durationMs: number) {
    if (!this.searchLevelDurations.has(level)) {
      this.searchLevelDurations.set(level, {
        samples: [],
        count: 0,
        sum: 0,
        max: 0,
        min: Infinity,
      });
    }
    this.addToHistogram(this.searchLevelDurations.get(level)!, durationMs);
  }

  /**
   * Record which pass was used for final result
   */
  recordPassUsed(passLevel: number) {
    this.passUsed.set(passLevel, (this.passUsed.get(passLevel) || 0) + 1);
  }

  /**
   * Record total job duration
   */
  recordJobDuration(durationMs: number) {
    this.addToHistogram(this.totalJobDurations, durationMs);
  }

  /**
   * Add value to histogram
   */
  private addToHistogram(hist: TimingHistogram, value: number) {
    hist.samples.push(value);
    hist.count++;
    hist.sum += value;
    hist.max = Math.max(hist.max, value);
    hist.min = Math.min(hist.min, value);

    // Keep only last 1000 samples to prevent memory leak
    if (hist.samples.length > 1000) {
      hist.samples.shift();
    }
  }

  /**
   * Calculate percentile from histogram
   */
  private calculatePercentile(hist: TimingHistogram, percentile: number): number {
    if (hist.samples.length === 0) return 0;
    const sorted = [...hist.samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    const geocodeHitRate = this.geocodeCalls.total > 0
      ? this.geocodeCalls.cacheHits / this.geocodeCalls.total
      : 0;

    const vertexFailureRate = this.vertexCalls.total > 0
      ? this.vertexCalls.failed / this.vertexCalls.total
      : 0;

    const avgJobDuration = this.totalJobDurations.count > 0
      ? this.totalJobDurations.sum / this.totalJobDurations.count
      : 0;

    return {
      vertex: {
        calls_total: this.vertexCalls.total,
        calls_failed: this.vertexCalls.failed,
        retries_total: this.vertexCalls.retries,
        failure_rate: vertexFailureRate,
        by_type: Object.fromEntries(this.vertexCallsByType),
      },
      geocode: {
        total: this.geocodeCalls.total,
        cache_hits: this.geocodeCalls.cacheHits,
        cache_misses: this.geocodeCalls.cacheMisses,
        cache_hit_rate: geocodeHitRate,
        batch_size_p50: this.calculatePercentile(this.geocodeBatchSizes, 50),
        batch_size_p95: this.calculatePercentile(this.geocodeBatchSizes, 95),
        batch_size_max: this.geocodeBatchSizes.max,
      },
      redis: {
        operations_total: this.redisOps.total,
        operations_failed: this.redisOps.failed,
      },
      search: {
        level_durations_ms: Object.fromEntries(
          Array.from(this.searchLevelDurations.entries()).map(([level, hist]) => [
            level,
            {
              p50: this.calculatePercentile(hist, 50),
              p95: this.calculatePercentile(hist, 95),
              max: hist.max,
              count: hist.count,
            },
          ])
        ),
        pass_used_distribution: Object.fromEntries(this.passUsed),
        job_duration_ms: {
          p50: this.calculatePercentile(this.totalJobDurations, 50),
          p95: this.calculatePercentile(this.totalJobDurations, 95),
          max: this.totalJobDurations.max,
          avg: avgJobDuration,
          count: this.totalJobDurations.count,
        },
      },
      slo_compliance: {
        vertex_failure_rate_ok: vertexFailureRate <= this.VERTEX_FAILURE_RATE_THRESHOLD,
        avg_job_duration_ok: avgJobDuration <= this.AVG_JOB_DURATION_THRESHOLD,
        geocode_hit_rate_ok: geocodeHitRate >= this.GEOCODE_HIT_RATE_THRESHOLD || this.geocodeCalls.total < 10,
      },
    };
  }

  /**
   * Check SLO violations and log alerts
   */
  checkSLOs() {
    const metrics = this.getMetrics();
    const alerts: string[] = [];

    if (!metrics.slo_compliance.vertex_failure_rate_ok && this.vertexCalls.total >= 10) {
      alerts.push(
        `🚨 SLO VIOLATION: Vertex failure rate ${(metrics.vertex.failure_rate * 100).toFixed(1)}% exceeds threshold ${(this.VERTEX_FAILURE_RATE_THRESHOLD * 100).toFixed(1)}%`
      );
    }

    if (!metrics.slo_compliance.avg_job_duration_ok && this.totalJobDurations.count >= 5) {
      alerts.push(
        `🚨 SLO VIOLATION: Avg job duration ${(metrics.search.job_duration_ms.avg / 1000).toFixed(1)}s exceeds threshold ${(this.AVG_JOB_DURATION_THRESHOLD / 1000).toFixed(1)}s`
      );
    }

    if (!metrics.slo_compliance.geocode_hit_rate_ok && this.geocodeCalls.total >= 10) {
      alerts.push(
        `🚨 SLO VIOLATION: Geocode hit rate ${(metrics.geocode.cache_hit_rate * 100).toFixed(1)}% below threshold ${(this.GEOCODE_HIT_RATE_THRESHOLD * 100).toFixed(1)}%`
      );
    }

    if (alerts.length > 0) {
      console.error('⚠️  SLO VIOLATIONS DETECTED:');
      alerts.forEach((alert) => console.error(`   ${alert}`));
    }

    return alerts;
  }

  /**
   * Reset all metrics (for testing)
   */
  reset() {
    this.vertexCalls = { total: 0, failed: 0, retries: 0 };
    this.vertexCallsByType.clear();
    this.geocodeCalls = { total: 0, cacheHits: 0, cacheMisses: 0 };
    this.geocodeBatchSizes = { samples: [], count: 0, sum: 0, max: 0, min: Infinity };
    this.redisOps = { total: 0, failed: 0, retries: 0 };
    this.searchLevelDurations.clear();
    this.passUsed.clear();
    this.totalJobDurations = { samples: [], count: 0, sum: 0, max: 0, min: Infinity };
  }
}

// Singleton instance
export const metrics = new Metrics();

/**
 * Structured logging helper
 */
export interface StructuredLogContext {
  jobId?: string;
  reqId?: string;
  phase?: string;
  level?: number;
  [key: string]: any;
}

export function logStructured(
  severity: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  context: StructuredLogContext = {},
  data?: any
) {
  const log = {
    timestamp: new Date().toISOString(),
    severity,
    message,
    ...context,
    ...(data ? { data } : {}),
  };

  const logStr = JSON.stringify(log);

  if (severity === 'ERROR') {
    console.error(logStr);
  } else if (severity === 'WARN') {
    console.warn(logStr);
  } else {
    jobLog(logStr);
  }
}
