// LRU Geocode Cache - Avoid redundant Google Maps API calls
// Caches normalized address → {lat, lon} mappings

import { getRedisCache } from './redisCache';
import { jobLog } from '../utils/jobLogger';

interface GeoLocation {
  lat: number;
  lon: number;
  locationType?: string;
  cached: boolean;
}

export class GeocodeCache {
  private get redis() {
    return getRedisCache(); // Get fresh instance each time to survive HMR
  }
  private readonly KEY_PREFIX = 'geocode:';

  /**
   * Get cached geocode result
   */
  async get(address: string): Promise<GeoLocation | null> {
    try {
      const key = this.KEY_PREFIX + this.normalizeAddress(address);
      const redis = this.redis;
      await redis.ensureConnected();

      const cached = await redis.get(key);
      if (!cached) {
        jobLog(`🗺️  GEOCODE CACHE MISS: ${address}`);
        return null;
      }

      const parsed = JSON.parse(cached);
      jobLog(`🗺️  GEOCODE CACHE HIT: ${address} → (${parsed.lat}, ${parsed.lon})`);
      return { ...parsed, cached: true };
    } catch (error) {
      console.error(`❌ GEOCODE CACHE GET ERROR for "${address}":`, error);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      return null; // On error, treat as cache miss
    }
  }

  /**
   * Store geocode result in cache
   */
  async set(address: string, lat: number, lon: number, locationType?: string): Promise<void> {
    try {
      const key = this.KEY_PREFIX + this.normalizeAddress(address);
      const redis = this.redis;
      await redis.ensureConnected();

      const value = JSON.stringify({ lat, lon, locationType });
      await redis.set(key, value);

      jobLog(`🗺️  GEOCODE CACHED: ${address} → (${lat}, ${lon}) [${locationType || 'unknown'}]`);
    } catch (error) {
      console.error(`❌ GEOCODE CACHE SET ERROR for "${address}":`, error);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      // Continue even if caching fails
    }
  }

  /**
   * Normalize address for cache key consistency
   */
  private normalizeAddress(address: string): string {
    return address
      .toLowerCase()
      .trim()
      // Remove punctuation except commas
      .replace(/[^\w\s,]/g, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      // Remove extra commas
      .replace(/,+/g, ',')
      .trim();
  }

  /**
   * Get cache stats
   */
  async getStats(): Promise<{ totalKeys: number }> {
    try {
      await this.redis.ensureConnected();
      const keys = await this.redis.keys(`${this.KEY_PREFIX}*`);
      return { totalKeys: keys.length };
    } catch (error) {
      console.error(`❌ GEOCODE CACHE STATS ERROR:`, error);
      return { totalKeys: 0 };
    }
  }

  /**
   * Clear all cached geocodes (for testing/maintenance)
   */
  async clear(): Promise<number> {
    try {
      await this.redis.ensureConnected();
      const keys = await this.redis.keys(`${this.KEY_PREFIX}*`);

      if (keys.length === 0) {
        jobLog(`🧹 GEOCODE CACHE: No keys to clear`);
        return 0;
      }

      await this.redis.del(...keys);
      jobLog(`🧹 GEOCODE CACHE: Cleared ${keys.length} entries`);
      return keys.length;
    } catch (error) {
      console.error(`❌ GEOCODE CACHE CLEAR ERROR:`, error);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }
}

// Export singleton
export const geocodeCache = new GeocodeCache();
