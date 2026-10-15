import Redis from 'ioredis';
import { jobLog } from '../utils/jobLogger';

/**
 * Redis Cache Client for Raw Comps
 * Provides persistent caching across server restarts
 */
export class RedisCache {
  private client: Redis | null = null;
  private isConnected = false;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private reconnectCallbacks: Array<() => void> = [];
  private connectionPromise: Promise<void> | null = null;

  constructor() {
    this.initialize();
  }

  private initialize() {
    try {
      // Support both REDIS_URL and REDIS_HOST/REDIS_PORT env vars
      const redisUrl = process.env.REDIS_URL ||
        (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || '6379'}` : 'redis://localhost:6379');

      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 10) {
            console.warn('⚠️  Redis connection failed after 10 retries');
            return null; // Stop retrying
          }
          const delay = Math.min(times * 1000, 5000); // Max 5s between retries
          jobLog(`🔄 Redis retry ${times}/10 in ${delay}ms`);
          return delay;
        },
        lazyConnect: true,
        enableReadyCheck: true,
        keepAlive: 30000, // TCP keepalive every 30s
        connectTimeout: 10000,
        enableOfflineQueue: true,
      });

      this.client.on('connect', () => {
        jobLog('✅ Redis connected');
        this.isConnected = true;
        this.startKeepalive();
      });

      this.client.on('ready', () => {
        jobLog('✅ Redis ready');
        this.isConnected = true;
        // Trigger reconnect callbacks for workers
        this.reconnectCallbacks.forEach(cb => cb());
      });

      this.client.on('error', (err) => {
        console.warn('⚠️  Redis connection error:', err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        jobLog('🔌 Redis connection closed');
        this.isConnected = false;
        this.stopKeepalive();
      });

      this.client.on('reconnecting', () => {
        jobLog('🔄 Redis reconnecting...');
        this.isConnected = false;
      });

      // Attempt to connect and store promise
      this.connectionPromise = this.client.connect()
        .then(() => {
          jobLog('🔗 Redis connection established');
        })
        .catch((err) => {
          console.warn('⚠️  Redis connection failed:', err.message);
          this.isConnected = false;
          throw err;
        });
    } catch (error) {
      console.warn('⚠️  Failed to initialize Redis client:', error);
      this.client = null;
      this.connectionPromise = Promise.reject(error);
    }
  }

  /**
   * Ensure Redis connection is established before operations
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectionPromise) {
      try {
        await this.connectionPromise;
      } catch (error) {
        console.error('❌ Redis connection failed:', error);
        throw new Error('Redis connection failed');
      }
    } else {
      throw new Error('Redis client not initialized');
    }
  }

  /**
   * Start keepalive ping to prevent connection timeout
   */
  private startKeepalive() {
    if (this.keepaliveInterval) {
      return;
    }

    this.keepaliveInterval = setInterval(async () => {
      if (this.client && this.isConnected) {
        try {
          await this.client.ping();
        } catch (error) {
          console.warn('⚠️  Keepalive ping failed');
        }
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop keepalive ping
   */
  private stopKeepalive() {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Register callback for reconnection events (for workers)
   */
  onReconnect(callback: () => void) {
    this.reconnectCallbacks.push(callback);
  }

  /**
   * Get cached raw comps for an address
   */
  async getRawComps(address: string): Promise<any[]> {
    if (!this.client || !this.isConnected) {
      return [];
    }

    try {
      const key = this.getCacheKey(address);
      const data = await this.client.get(key);

      if (!data) {
        return [];
      }

      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('❌ Redis GET error:', error);
      return [];
    }
  }

  /**
   * Update cached raw comps for an address
   */
  async updateRawComps(address: string, newComps: any[]): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const key = this.getCacheKey(address);

      // Get existing cache
      const existing = await this.getRawComps(address);

      // Create a set of existing addresses for fast lookup
      const existingAddresses = new Set(existing.map(comp => comp.address?.toLowerCase()));

      // Find new comps not in cache
      const uniqueNewComps = newComps.filter(comp =>
        comp.address && !existingAddresses.has(comp.address.toLowerCase())
      );

      if (uniqueNewComps.length > 0) {
        const updated = [...existing, ...uniqueNewComps];
        await this.client.set(key, JSON.stringify(updated));
        jobLog(`   💾 Redis cache updated: Added ${uniqueNewComps.length} new comps. Total cached: ${updated.length}`);
      } else {
        jobLog(`   💾 Redis cache unchanged: No new comps found. Total cached: ${existing.length}`);
      }
    } catch (error) {
      console.error('❌ Redis SET error:', error);
    }
  }

  /**
   * Clear cache for an address
   */
  async clearAddress(address: string): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const key = this.getCacheKey(address);
      await this.client.del(key);
      jobLog(`   🗑️  Redis cache cleared for ${address}`);
    } catch (error) {
      console.error('❌ Redis DEL error:', error);
    }
  }

  /**
   * Clear all cached data
   */
  async clearAll(): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const keys = await this.client.keys('rawComps:*');
      if (keys.length > 0) {
        await this.client.del(...keys);
        jobLog(`   🗑️  Redis cache cleared: ${keys.length} addresses removed`);
      }
    } catch (error) {
      console.error('❌ Redis CLEAR ALL error:', error);
    }
  }

  /**
   * Store job status in Redis with race condition prevention
   */
  async setJob(jobId: string, jobData: any, ttlSeconds: number = 3600): Promise<void> {
    if (!this.client || !this.isConnected) {
      console.error(`❌ CRITICAL: Redis not connected, job ${jobId} will NOT be persisted!`);
      return;
    }

    try {
      const key = `job:${jobId}`;

      // Get current job to check for race conditions
      const currentJob = await this.getJob(jobId);

      if (currentJob) {
        const currentStatus = currentJob.status;
        const newStatus = jobData.status;

        // RACE PREVENTION #1: Protect terminal states from being overwritten
        if ((currentStatus === 'completed' || currentStatus === 'failed') && newStatus === 'processing') {
          jobLog(`⚠️  RACE PREVENTED: Job ${jobId} is ${currentStatus}, blocking stale processing update`);
          return;
        }

        // RACE PREVENTION #2: Prevent backwards progress updates
        if (currentStatus === 'processing' && newStatus === 'processing') {
          const currentProgress = currentJob.progress || 0;
          const newProgress = jobData.progress || 0;

          if (newProgress < currentProgress) {
            jobLog(`⚠️  RACE PREVENTED: Job ${jobId} progress backwards ${currentProgress}% -> ${newProgress}%`);
            return;
          }
        }

        // RACE PREVENTION #3: Block stale updates using timestamp comparison
        const currentTime = currentJob.lastHeartbeat || currentJob.createdAt || 0;
        const newTime = jobData.lastHeartbeat || Date.now();

        // Allow 10 second tolerance for clock skew and async operations
        if (newTime < currentTime - 10000) {
          const ageSeconds = Math.round((currentTime - newTime) / 1000);
          jobLog(`⚠️  RACE PREVENTED: Job ${jobId} update is stale (${ageSeconds}s old)`);
          return;
        }
      }

      const dataStr = JSON.stringify(jobData);
      await this.client.set(key, dataStr, 'EX', ttlSeconds);
      jobLog(`✅ Job ${jobId} saved to Redis: status=${jobData.status}, progress=${jobData.progress}`);
    } catch (error) {
      console.error(`❌ Redis SET JOB error for ${jobId}:`, error);
      throw error; // Re-throw so caller knows it failed
    }
  }

  /**
   * Get job status from Redis
   */
  async getJob(jobId: string): Promise<any | null> {
    jobLog(`🔍 REDIS getJob: jobId=${jobId}, connected=${this.isConnected}, client=${!!this.client}`);
    if (!this.client) {
      jobLog(`❌ REDIS getJob: NO CLIENT - returning null`);
      return null;
    }

    // Ensure connection is ready before reading
    await this.ensureConnected();

    try {
      const key = `job:${jobId}`;
      const data = await this.client.get(key);
      jobLog(`🔍 REDIS getJob: key=${key}, found=${!!data}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('❌ Redis GET JOB error:', error);
      return null;
    }
  }

  /**
   * Delete job from Redis
   */
  async deleteJob(jobId: string): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const key = `job:${jobId}`;
      await this.client.del(key);
    } catch (error) {
      console.error('❌ Redis DEL JOB error:', error);
    }
  }

  // ==================== Redis Streams Methods ====================

  /**
   * Add entry to Redis Stream
   */
  async xadd(stream: string, fields: Record<string, string>): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const args = [stream, 'MAXLEN', '~', '50000', '*'];
      for (const [key, value] of Object.entries(fields)) {
        args.push(key, value);
      }
      return await (this.client.xadd as any)(...args);
    } catch (error) {
      console.error('❌ Redis XADD error:', error);
      return null;
    }
  }

  /**
   * Create consumer group (idempotent)
   */
  async xgroupCreate(stream: string, group: string, id: string = '$'): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      await this.client.xgroup('CREATE', stream, group, id, 'MKSTREAM');
    } catch (error: any) {
      if (!/BUSYGROUP/.test(error.message)) {
        console.error('❌ Redis XGROUP CREATE error:', error);
      }
    }
  }

  /**
   * Read from stream as consumer group
   */
  async xreadGroup(group: string, consumer: string, stream: string, count: number, block: number = 15000): Promise<any[]> {
    if (!this.client || !this.isConnected) {
      console.warn(`⚠️  Redis not connected, cannot read from stream ${stream}`);
      return [];
    }

    try {
      const result = await this.client.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', count,
        'BLOCK', block,
        'STREAMS', stream, '>'
      );
      return result || [];
    } catch (error) {
      console.error('❌ Redis XREADGROUP error:', error);
      return [];
    }
  }

  /**
   * Acknowledge message
   */
  async xack(stream: string, group: string, id: string): Promise<void> {
    if (!this.client || !this.isConnected) {
      console.error(`❌ CRITICAL: Cannot XACK - Redis not connected! Stream: ${stream}, ID: ${id}`);
      return;
    }

    try {
      const result = await this.client.xack(stream, group, id);
      jobLog(`✅ XACK successful: stream=${stream}, id=${id}, result=${result}`);
    } catch (error) {
      console.error(`❌ Redis XACK error for ${id}:`, error);
      throw error; // Re-throw so caller knows it failed
    }
  }

  /**
   * Auto-claim idle messages (for reaping stuck jobs)
   */
  async xautoclaim(stream: string, group: string, consumer: string, minIdleTime: number, start: string = '0-0', count: number = 50): Promise<[string, any[]]> {
    if (!this.client || !this.isConnected) {
      return ['0-0', []];
    }

    try {
      const result = await this.client.xautoclaim(
        stream, group, consumer, minIdleTime, start, 'COUNT', count
      );
      return result as [string, any[]];
    } catch (error) {
      console.error('❌ Redis XAUTOCLAIM error:', error);
      return ['0-0', []];
    }
  }

  // ==================== 🔧 PHASE 4: Distributed Locks ====================

  /**
   * Acquire a distributed lock using Redis SET NX EX pattern
   * Returns true if lock was acquired, false if already locked
   *
   * IMPORTANT: Lock is automatically released after ttlSeconds
   * Always call releaseLock() in a finally block to avoid holding locks unnecessarily
   *
   * Example:
   *   const lockAcquired = await redis.acquireLock('lock:job:123', 'worker-1', 300);
   *   if (lockAcquired) {
   *     try {
   *       // Process job
   *     } finally {
   *       await redis.releaseLock('lock:job:123', 'worker-1');
   *     }
   *   }
   */
  async acquireLock(lockKey: string, lockValue: string, ttlSeconds: number): Promise<boolean> {
    console.log('🔒 LOCK ACQUISITION ATTEMPT');
    console.log(`   Lock Key: ${lockKey}`);
    console.log(`   Lock Value: ${lockValue}`);
    console.log(`   TTL: ${ttlSeconds}s`);
    console.log(`   Redis Connected: ${this.isConnected}`);

    if (!this.client || !this.isConnected) {
      console.error('❌ LOCK FAILED: Redis not connected');
      return false;
    }

    try {
      // SET NX (Not eXists) EX (EXpiry) - atomic check-and-set
      // Only sets the key if it doesn't exist, prevents race conditions
      const result = await this.client.set(lockKey, lockValue, 'NX', 'EX', ttlSeconds);

      if (result === 'OK') {
        console.log('✅ LOCK ACQUIRED');
        console.log(`   ${lockKey} = ${lockValue}`);
        console.log(`   Auto-expires in ${ttlSeconds}s`);
        return true;
      } else {
        // Lock already held by another worker
        const currentLockValue = await this.client.get(lockKey);
        console.log('❌ LOCK ALREADY HELD');
        console.log(`   ${lockKey} = ${currentLockValue || 'unknown'}`);
        console.log(`   Cannot acquire - another worker is processing this job`);
        return false;
      }
    } catch (error) {
      console.error('❌ LOCK ACQUISITION ERROR:', error);
      return false;
    }
  }

  /**
   * Release a distributed lock using Lua script for atomic check-and-delete
   * Only releases if lockValue matches (prevents releasing another worker's lock)
   *
   * Returns true if lock was released, false if lock didn't match or didn't exist
   */
  async releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    console.log('🔓 LOCK RELEASE ATTEMPT');
    console.log(`   Lock Key: ${lockKey}`);
    console.log(`   Lock Value: ${lockValue}`);

    if (!this.client || !this.isConnected) {
      console.error('❌ LOCK RELEASE FAILED: Redis not connected');
      return false;
    }

    try {
      // Lua script for atomic check-and-delete
      // IMPORTANT: Only delete if value matches (prevents releasing another worker's lock)
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.client.eval(luaScript, 1, lockKey, lockValue) as number;

      if (result === 1) {
        console.log('✅ LOCK RELEASED');
        console.log(`   ${lockKey} deleted successfully`);
        return true;
      } else {
        const currentLockValue = await this.client.get(lockKey);
        console.log('⚠️  LOCK NOT RELEASED');
        console.log(`   Current value: ${currentLockValue || 'none (already expired?)'}`);
        console.log(`   Expected value: ${lockValue}`);
        console.log(`   Lock may have already expired or was held by another worker`);
        return false;
      }
    } catch (error) {
      console.error('❌ LOCK RELEASE ERROR:', error);
      return false;
    }
  }

  /**
   * Renew a distributed lock TTL using Lua script for atomic check-and-expire
   * Only renews if lockValue matches (prevents renewing another worker's lock)
   *
   * Returns true if TTL was renewed, false if lock didn't match or didn't exist
   */
  async renewLock(lockKey: string, lockValue: string, ttlSeconds: number): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      console.error('❌ LOCK RENEW FAILED: Redis not connected');
      return false;
    }

    try {
      // Lua script for atomic check-and-expire
      // IMPORTANT: Only renew if value matches (prevents renewing another worker's lock)
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await this.client.eval(luaScript, 1, lockKey, lockValue, String(ttlSeconds)) as number;

      if (result === 1) {
        jobLog(`✅ LOCK RENEWED: ${lockKey} TTL reset to ${ttlSeconds}s`);
        return true;
      } else {
        console.warn(`⚠️  LOCK RENEW FAILED: ${lockKey} not owned by ${lockValue}`);
        return false;
      }
    } catch (error) {
      console.error('❌ LOCK RENEW ERROR:', error);
      return false;
    }
  }

  // ==================== Hybrid Cache: Global Comp Storage ====================

  /**
   * Get global comp by address (canonical comp data)
   */
  async getGlobalComp(address: string): Promise<any | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const key = `comp:${this.normalizeAddress(address)}`;
      const data = await this.client.get(key);

      if (!data) {
        return null;
      }

      return JSON.parse(data);
    } catch (error) {
      console.error(`❌ Redis GET GLOBAL COMP error for "${address}":`, error);
      return null;
    }
  }

  /**
   * Set global comp by address (upsert - always uses latest data)
   */
  async setGlobalComp(address: string, compData: any): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const key = `comp:${this.normalizeAddress(address)}`;
      const value = JSON.stringify({
        ...compData,
        lastUpdated: new Date().toISOString()
      });
      await this.client.set(key, value);
    } catch (error) {
      console.error(`❌ Redis SET GLOBAL COMP error for "${address}":`, error);
    }
  }

  /**
   * Get multiple global comps in parallel
   */
  async getGlobalComps(addresses: string[]): Promise<Map<string, any>> {
    if (!this.client || !this.isConnected) {
      return new Map();
    }

    try {
      const keys = addresses.map(addr => `comp:${this.normalizeAddress(addr)}`);
      const results = await this.client.mget(...keys);

      const compMap = new Map<string, any>();
      results.forEach((data, i) => {
        if (data) {
          try {
            compMap.set(addresses[i], JSON.parse(data));
          } catch (error) {
            console.error(`❌ Failed to parse comp data for "${addresses[i]}":`, error);
          }
        }
      });

      return compMap;
    } catch (error) {
      console.error(`❌ Redis MGET GLOBAL COMPS error:`, error);
      return new Map();
    }
  }

  /**
   * Set multiple global comps in parallel (pipeline)
   */
  async setGlobalComps(comps: any[]): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const pipeline = this.client.pipeline();
      const timestamp = new Date().toISOString();

      for (const comp of comps) {
        if (comp.address) {
          const key = `comp:${this.normalizeAddress(comp.address)}`;
          const value = JSON.stringify({
            ...comp,
            lastUpdated: timestamp
          });
          pipeline.set(key, value);
        }
      }

      await pipeline.exec();
    } catch (error) {
      console.error(`❌ Redis SET GLOBAL COMPS (pipeline) error:`, error);
    }
  }

  // ==================== Hybrid Cache: Subject-Comp Junction ====================

  /**
   * Get subject's comp references (junction table)
   */
  async getSubjectCompRefs(subjectAddress: string): Promise<Array<{compAddress: string, distanceMi: number, foundAt: string}>> {
    if (!this.client || !this.isConnected) {
      return [];
    }

    try {
      const key = `subjects:${this.normalizeAddress(subjectAddress)}`;
      const data = await this.client.get(key);

      if (!data) {
        return [];
      }

      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error(`❌ Redis GET SUBJECT COMP REFS error for "${subjectAddress}":`, error);
      return [];
    }
  }

  /**
   * Update subject's comp references (merge with existing)
   */
  async updateSubjectCompRefs(
    subjectAddress: string,
    newRefs: Array<{compAddress: string, distanceMi: number}>
  ): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      const key = `subjects:${this.normalizeAddress(subjectAddress)}`;
      const existing = await this.getSubjectCompRefs(subjectAddress);

      // Create map of existing refs by address
      const existingMap = new Map(
        existing.map(ref => [ref.compAddress.toLowerCase(), ref])
      );

      // Add/update refs
      const timestamp = new Date().toISOString();
      for (const newRef of newRefs) {
        const normalizedAddr = newRef.compAddress.toLowerCase();
        existingMap.set(normalizedAddr, {
          compAddress: normalizedAddr,
          distanceMi: newRef.distanceMi,
          foundAt: existingMap.has(normalizedAddr)
            ? existingMap.get(normalizedAddr)!.foundAt
            : timestamp
        });
      }

      const updated = Array.from(existingMap.values());
      await this.client.set(key, JSON.stringify(updated));
    } catch (error) {
      console.error(`❌ Redis UPDATE SUBJECT COMP REFS error for "${subjectAddress}":`, error);
    }
  }

  /**
   * Normalize address for cache keys
   */
  private normalizeAddress(address: string): string {
    return address
      .toLowerCase()
      .trim()
      .replace(/[^\w\s,]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/,+/g, ',')
      .trim();
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{ totalAddresses: number; totalComps: number }> {
    if (!this.client || !this.isConnected) {
      return { totalAddresses: 0, totalComps: 0 };
    }

    try {
      const keys = await this.client.keys('rawComps:*');
      let totalComps = 0;

      for (const key of keys) {
        const data = await this.client.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          totalComps += Array.isArray(parsed) ? parsed.length : 0;
        }
      }

      return {
        totalAddresses: keys.length,
        totalComps
      };
    } catch (error) {
      console.error('❌ Redis STATS error:', error);
      return { totalAddresses: 0, totalComps: 0 };
    }
  }

  /**
   * Check if Redis is connected
   */
  isReady(): boolean {
    return this.isConnected;
  }

  // ==================== Generic Redis Methods (for GeocodeCache) ====================

  /**
   * Generic GET operation
   */
  async get(key: string): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      return await this.client.get(key);
    } catch (error) {
      console.error(`❌ Redis GET error for key "${key}":`, error);
      return null;
    }
  }

  /**
   * Generic SET operation (set without expiry)
   */
  async set(key: string, value: string): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      await this.client.set(key, value);
    } catch (error) {
      console.error(`❌ Redis SET error for key "${key}":`, error);
    }
  }

  /**
   * Generic SETEX operation (set with expiry)
   */
  async setex(key: string, seconds: number, value: string): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      await this.client.setex(key, seconds, value);
    } catch (error) {
      console.error(`❌ Redis SETEX error for key "${key}":`, error);
    }
  }

  /**
   * Generic KEYS operation (get keys matching pattern)
   */
  async keys(pattern: string): Promise<string[]> {
    if (!this.client || !this.isConnected) {
      return [];
    }

    try {
      return await this.client.keys(pattern);
    } catch (error) {
      console.error(`❌ Redis KEYS error for pattern "${pattern}":`, error);
      return [];
    }
  }

  /**
   * Generic DEL operation (delete keys)
   */
  async del(...keys: string[]): Promise<void> {
    if (!this.client || !this.isConnected) {
      return;
    }

    try {
      await this.client.del(...keys);
    } catch (error) {
      console.error(`❌ Redis DEL error for keys:`, keys, error);
    }
  }

  /**
   * Generate cache key for an address
   */
  private getCacheKey(address: string): string {
    return `rawComps:${address.toLowerCase().trim()}`;
  }

  /**
   * Close Redis connection
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }
}

// Declare global type for development mode hot reload persistence
declare global {
  var __redisCache: RedisCache | undefined;
}

// Singleton instance
let redisCacheInstance: RedisCache | null = null;

export function getRedisCache(): RedisCache {
  // In development, use globalThis to persist across hot reloads
  if (process.env.NODE_ENV !== 'production') {
    if (!global.__redisCache) {
      global.__redisCache = new RedisCache();
    }
    return global.__redisCache;
  }

  // In production, use regular singleton
  if (!redisCacheInstance) {
    redisCacheInstance = new RedisCache();
  }
  return redisCacheInstance;
}
