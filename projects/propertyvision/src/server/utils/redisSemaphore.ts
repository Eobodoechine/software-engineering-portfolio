// Redis-based Semaphore for Cluster-wide Concurrency Control
// Only used when WORKER_COUNT > 1 (multiple workers)

import { getRedisCache } from './redisCache';
import { jobLog } from '../utils/jobLogger';

export class RedisSemaphore {
  private redis = getRedisCache();
  private readonly KEY_PREFIX = 'semaphore:';
  private readonly enabled: boolean;

  constructor() {
    // Only enable for multiple workers
    const workerCount = Number(process.env.WORKER_COUNT || 1);
    this.enabled = workerCount > 1;

    if (this.enabled) {
      jobLog(`🔐 Redis Semaphore enabled (${workerCount} workers)`);
    }
  }

  /**
   * Acquire n tokens from the semaphore
   * Returns true if acquired, false if would exceed limit
   */
  async acquire(name: string, tokens: number, opts?: { ttlMs?: number }): Promise<boolean> {
    // If single worker, always allow (no coordination needed)
    if (!this.enabled) return true;

    const key = `${this.KEY_PREFIX}${name}`;
    const limit = this.getLimit(name);
    const ttl = opts?.ttlMs || 30000; // 30s default TTL

    await this.redis.ensureConnected();

    // Use Lua script for atomic check-and-increment
    const script = `
      local key = KEYS[1]
      local tokens = tonumber(ARGV[1])
      local limit = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])

      local current = tonumber(redis.call('get', key) or '0')
      local new_value = current + tokens

      if new_value <= limit then
        redis.call('incrby', key, tokens)
        redis.call('pexpire', key, ttl)
        return 1
      else
        return 0
      end
    `;

    try {
      const result = await this.redis.eval(script, [key], [tokens.toString(), limit.toString(), ttl.toString()]);
      return result === 1;
    } catch (error) {
      console.error(`❌ Semaphore acquire failed for ${name}:`, error);
      // On error, allow the operation (fail open to avoid blocking all work)
      return true;
    }
  }

  /**
   * Release n tokens back to the semaphore
   */
  async release(name: string, tokens: number): Promise<void> {
    // If single worker, nothing to release
    if (!this.enabled) return;

    const key = `${this.KEY_PREFIX}${name}`;

    await this.redis.ensureConnected();

    // Use Lua script to ensure non-negative count
    const script = `
      local key = KEYS[1]
      local tokens = tonumber(ARGV[1])

      local current = tonumber(redis.call('get', key) or '0')
      local new_value = math.max(0, current - tokens)

      if new_value == 0 then
        redis.call('del', key)
      else
        redis.call('set', key, new_value)
      end

      return new_value
    `;

    try {
      await this.redis.eval(script, [key], [tokens.toString()]);
    } catch (error) {
      console.error(`❌ Semaphore release failed for ${name}:`, error);
      // Continue even if release fails
    }
  }

  /**
   * Get current count for a semaphore
   */
  async getCount(name: string): Promise<number> {
    if (!this.enabled) return 0;

    const key = `${this.KEY_PREFIX}${name}`;
    await this.redis.ensureConnected();

    try {
      const value = await this.redis.get(key);
      return value ? parseInt(value) : 0;
    } catch (error) {
      console.error(`❌ Semaphore getCount failed for ${name}:`, error);
      return 0;
    }
  }

  /**
   * Get the configured limit for a semaphore
   */
  private getLimit(name: string): number {
    switch (name) {
      case 'vertex':
        return Number(process.env.PV_VERTEX_GLOBAL_CONC || 24);
      case 'geocode':
        return Number(process.env.PV_GEOCODE_CONC || 15);
      default:
        return 10; // Default limit
    }
  }
}

// Export singleton
export const redisSemaphore = new RedisSemaphore();
