import crypto from 'crypto';
import { redis } from './redisClient';
import { probe } from './probe';

const DEFAULT_TTL_SEC = Number(process.env.PV_VERTEX_CACHE_TTL ?? 604800); // 7 days

/**
 * Generate stable hash from input data
 * @param data Any serializable data
 * @returns 16-character hex hash
 */
export function hashKey(data: any): string {
  const input = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Normalize prompt text for consistent hashing
 * @param prompt Raw prompt string
 * @returns Normalized prompt (trimmed, single-spaced)
 */
function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

/**
 * Normalize genConfig to ensure deterministic JSON.stringify()
 * Explicit field ordering and conditional inclusion
 */
function normalizeConfig(opts: any) {
  const config: any = {
    temperature: opts.temperature ?? 0,
    seed: opts.seed ?? 12345,
    maxOutputTokens: opts.maxOutputTokens ?? 8192,
  };

  // Conditionally add optional fields (in order)
  if (opts.responseMimeType) {
    config.responseMimeType = opts.responseMimeType;
  }
  if (opts.responseSchema) {
    config.responseSchema = opts.responseSchema;
  }

  return config;
}

/**
 * Build stable cache key for Vertex API result
 *
 * Cache key structure:
 *   vertex:result:{hash(model+grounded+config+promptHash+version)}
 *
 * @param opts Cache key parameters
 * @returns Redis key string
 */
export function buildCacheKey(opts: {
  prompt: string;
  model: string;
  grounded?: boolean;
  temperature?: number;
  seed?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: any;
}): string {
  const promptHash = hashKey(normalizePrompt(opts.prompt));

  const keyPayload = {
    model: opts.model,
    grounded: opts.grounded ?? false,
    config: normalizeConfig(opts),
    promptHash,
    v: 1, // Version for cache invalidation
  };

  return `vertex:result:${hashKey(JSON.stringify(keyPayload))}`;
}

/**
 * Get cached Vertex result from Redis
 * @param key Cache key from buildCacheKey()
 * @returns Parsed JSON object or null if miss/corrupt
 */
export async function getCachedResult(key: string) {
  probe({ probe: 'VERTEX_RESULT_CACHE_CHECK', key });

  const val = await redis.get(key);
  if (val) {
    probe({ probe: 'VERTEX_RESULT_CACHE_HIT', key, bytes: val.length });
    try {
      return JSON.parse(val);
    } catch (e: any) {
      probe({ probe: 'VERTEX_RESULT_CACHE_CORRUPT', level: 'WARN', key, msg: String(e) });
      await redis.del(key);
    }
  } else {
    probe({ probe: 'VERTEX_RESULT_CACHE_MISS', key });
  }

  return null;
}

/**
 * Store Vertex result in Redis
 * @param key Cache key from buildCacheKey()
 * @param obj Result object to cache
 * @param ttlSec Time-to-live in seconds (default: 7 days)
 */
export async function setCachedResult(key: string, obj: any, ttlSec = DEFAULT_TTL_SEC) {
  const s = JSON.stringify(obj);
  await redis.setEx(key, ttlSec, s);
  probe({ probe: 'VERTEX_RESULT_CACHE_SET', key, bytes: s.length, ttlSec });
}
