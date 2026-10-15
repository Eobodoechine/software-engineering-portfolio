// Distance Validation and Geocoding Cache
// Fixes inconsistent distance calculations and geocoding issues

import https from 'https';

interface Coordinates {
  lat: number;
  lon: number;
  confidence: 'high' | 'medium' | 'low';
  source: 'google_maps' | 'cached' | 'estimated';
  timestamp: number;
}

interface DistanceCalculation {
  address1: string;
  address2: string;
  distance: number;
  method: 'haversine' | 'estimated';
  confidence: 'high' | 'medium' | 'low';
  coords1: Coordinates;
  coords2: Coordinates;
}

interface GeocodeResult {
  address: string;
  coords: Coordinates | null;
  success: boolean;
  error?: string;
  fromCache: boolean;
}

export class DistanceValidator {
  private geocodeCache = new Map<string, Coordinates>();
  private distanceCache = new Map<string, DistanceCalculation>();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly googleMapsApiKey: string;
  private failedAddresses = new Set<string>();

  constructor() {
    this.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!this.googleMapsApiKey) {
      console.log('⚠️  No Google Maps API key - using estimated coordinates');
    }
  }

  /**
   * Normalize address for consistent cache keys
   */
  private normalizeAddress(address: string): string {
    return address
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s,]/g, ''); // Keep commas for state/zip
  }

  /**
   * Estimate coordinates based on address patterns (fallback)
   */
  private estimateCoordinates(address: string): Coordinates | null {
    // Simple estimation for Georgia addresses (fallback only)
    const georgiaPattern = /georgia|ga\s*\d{5}/i;
    const fayettevillePattern = /fayetteville/i;

    if (fayettevillePattern.test(address)) {
      // Fayetteville, GA approximate center with some randomization
      const baseLat = 33.4484;
      const baseLon = -84.4555;
      const offset = 0.02; // ~1.4 mile radius

      return {
        lat: baseLat + (Math.random() - 0.5) * offset,
        lon: baseLon + (Math.random() - 0.5) * offset,
        confidence: 'low',
        source: 'estimated',
        timestamp: Date.now()
      };
    } else if (georgiaPattern.test(address)) {
      // Georgia approximate center
      return {
        lat: 33.76 + (Math.random() - 0.5) * 2, // ±1 degree
        lon: -84.39 + (Math.random() - 0.5) * 2,
        confidence: 'low',
        source: 'estimated',
        timestamp: Date.now()
      };
    }

    return null;
  }

  /**
   * Geocode address using Google Maps API
   */
  private async geocodeWithGoogle(address: string): Promise<Coordinates | null> {
    if (!this.googleMapsApiKey) {
      return this.estimateCoordinates(address);
    }

    return new Promise((resolve) => {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${this.googleMapsApiKey}`;

      const timeout = setTimeout(() => {
        console.log(`⏰ Geocoding timeout for ${address}`);
        resolve(this.estimateCoordinates(address));
      }, 5000);

      https.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const data = JSON.parse(body);

            if (data.status === 'OK' && data.results?.[0]) {
              const location = data.results[0].geometry.location;
              const locationType = data.results[0].geometry.location_type;

              // Determine confidence based on location type
              let confidence: 'high' | 'medium' | 'low' = 'medium';
              if (locationType === 'ROOFTOP') {
                confidence = 'high';
              } else if (locationType === 'RANGE_INTERPOLATED') {
                confidence = 'medium';
              } else {
                confidence = 'low';
              }

              resolve({
                lat: location.lat,
                lon: location.lng,
                confidence,
                source: 'google_maps',
                timestamp: Date.now()
              });
            } else {
              console.log(`❌ Geocoding failed for ${address}: ${data.status}`);
              resolve(this.estimateCoordinates(address));
            }
          } catch (e) {
            console.log(`❌ Geocoding parse error for ${address}:`, e);
            resolve(this.estimateCoordinates(address));
          }
        });
      }).on('error', () => {
        clearTimeout(timeout);
        console.log(`❌ Geocoding network error for ${address}`);
        resolve(this.estimateCoordinates(address));
      });
    });
  }

  /**
   * Get coordinates for address (with caching)
   */
  async geocodeAddress(address: string): Promise<GeocodeResult> {
    const normalizedAddress = this.normalizeAddress(address);

    // Check if we've failed this address recently
    if (this.failedAddresses.has(normalizedAddress)) {
      return {
        address,
        coords: this.estimateCoordinates(address),
        success: false,
        error: 'Previously failed - using estimation',
        fromCache: false
      };
    }

    // Check cache first
    const cached = this.geocodeCache.get(normalizedAddress);
    if (cached) {
      const isExpired = Date.now() - cached.timestamp > this.CACHE_TTL;
      if (!isExpired) {
        return {
          address,
          coords: cached,
          success: true,
          fromCache: true
        };
      } else {
        this.geocodeCache.delete(normalizedAddress);
      }
    }

    // Geocode and cache
    const coords = await this.geocodeWithGoogle(address);

    if (coords) {
      this.geocodeCache.set(normalizedAddress, coords);
      return {
        address,
        coords,
        success: true,
        fromCache: false
      };
    } else {
      this.failedAddresses.add(normalizedAddress);
      return {
        address,
        coords: null,
        success: false,
        error: 'Geocoding failed completely',
        fromCache: false
      };
    }
  }

  /**
   * Calculate distance using Haversine formula
   */
  private calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  /**
   * Calculate distance between two addresses
   */
  async calculateDistance(address1: string, address2: string): Promise<DistanceCalculation | null> {
    const cacheKey = `${this.normalizeAddress(address1)}|${this.normalizeAddress(address2)}`;

    // Check distance cache
    const cached = this.distanceCache.get(cacheKey);
    if (cached && Date.now() - cached.coords1.timestamp < this.CACHE_TTL) {
      return cached;
    }

    // Geocode both addresses
    const [result1, result2] = await Promise.all([
      this.geocodeAddress(address1),
      this.geocodeAddress(address2)
    ]);

    if (!result1.coords || !result2.coords) {
      console.log(`❌ Cannot calculate distance: missing coordinates for ${address1} or ${address2}`);
      return null;
    }

    // Calculate distance
    const distance = this.calculateHaversineDistance(
      result1.coords.lat, result1.coords.lon,
      result2.coords.lat, result2.coords.lon
    );

    // Determine overall confidence
    const confidenceScore = {
      'high': 3,
      'medium': 2,
      'low': 1
    };

    const avgConfidence = (confidenceScore[result1.coords.confidence] + confidenceScore[result2.coords.confidence]) / 2;
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    if (avgConfidence >= 2.5) confidence = 'high';
    else if (avgConfidence >= 1.5) confidence = 'medium';
    else confidence = 'low';

    const calculation: DistanceCalculation = {
      address1,
      address2,
      distance,
      method: 'haversine',
      confidence,
      coords1: result1.coords,
      coords2: result2.coords
    };

    // Cache the calculation
    this.distanceCache.set(cacheKey, calculation);

    return calculation;
  }

  /**
   * Validate distances for multiple comparables
   */
  async validateComparableDistances(
    subjectAddress: string,
    comparables: any[],
    maxDistance: number = 2.0
  ): Promise<{
    validated: any[];
    rejected: any[];
    validationSummary: {
      totalProcessed: number;
      validCount: number;
      rejectedCount: number;
      avgDistance: number;
      geocodingErrors: number;
      cacheHits: number;
    };
  }> {
    console.log(`📍 Validating distances for ${comparables.length} comparables...`);
    console.log(`   🎯 Max distance: ${maxDistance} miles from ${subjectAddress}`);

    const validated: any[] = [];
    const rejected: any[] = [];
    const validationDetails: any[] = [];

    let geocodingErrors = 0;
    let cacheHits = 0;

    // Process comparables in parallel batches to avoid API rate limits
    const batchSize = 5;
    for (let i = 0; i < comparables.length; i += batchSize) {
      const batch = comparables.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (comp) => {
          const distanceCalc = await this.calculateDistance(subjectAddress, comp.address);

          if (!distanceCalc) {
            geocodingErrors++;
            return {
              comp,
              distance: null,
              error: 'geocoding_failed',
              valid: false
            };
          }

          if (distanceCalc.coords1.source === 'cached' || distanceCalc.coords2.source === 'cached') {
            cacheHits++;
          }

          const valid = distanceCalc.distance <= maxDistance;
          const result = {
            comp: {
              ...comp,
              distance: distanceCalc.distance,
              distanceConfidence: distanceCalc.confidence,
              geocodingSource: `${distanceCalc.coords1.source}/${distanceCalc.coords2.source}`
            },
            distance: distanceCalc.distance,
            valid,
            confidence: distanceCalc.confidence
          };

          if (valid) {
            validated.push(result.comp);
          } else {
            rejected.push({
              ...result.comp,
              rejectionReason: `Too far (${distanceCalc.distance.toFixed(2)}mi > ${maxDistance}mi limit)`
            });
          }

          return result;
        })
      );

      validationDetails.push(...batchResults);

      // Add small delay between batches to be nice to the API
      if (i + batchSize < comparables.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Calculate summary statistics
    const validDistances = validationDetails
      .filter(v => v.valid && v.distance !== null)
      .map(v => v.distance);

    const avgDistance = validDistances.length > 0
      ? validDistances.reduce((sum, d) => sum + d, 0) / validDistances.length
      : 0;

    const validationSummary = {
      totalProcessed: comparables.length,
      validCount: validated.length,
      rejectedCount: rejected.length,
      avgDistance,
      geocodingErrors,
      cacheHits
    };

    console.log(`✅ Distance validation complete:`);
    console.log(`   📊 ${validationSummary.validCount}/${validationSummary.totalProcessed} passed validation`);
    console.log(`   📍 Average distance: ${avgDistance.toFixed(2)} miles`);
    console.log(`   💾 Cache hits: ${cacheHits}`);
    console.log(`   ❌ Geocoding errors: ${geocodingErrors}`);

    // Log rejected properties
    if (rejected.length > 0) {
      console.log(`   🚫 Rejected properties:`);
      rejected.forEach(r => {
        console.log(`      ${r.address}: ${r.rejectionReason}`);
      });
    }

    return {
      validated,
      rejected,
      validationSummary
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    geocodeEntries: number;
    distanceEntries: number;
    failedAddresses: number;
    oldestEntry: number;
  } {
    const now = Date.now();
    let oldestEntry = now;

    for (const coords of this.geocodeCache.values()) {
      if (coords.timestamp < oldestEntry) {
        oldestEntry = coords.timestamp;
      }
    }

    return {
      geocodeEntries: this.geocodeCache.size,
      distanceEntries: this.distanceCache.size,
      failedAddresses: this.failedAddresses.size,
      oldestEntry: now - oldestEntry
    };
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.geocodeCache.clear();
    this.distanceCache.clear();
    this.failedAddresses.clear();
    console.log('🗑️  Distance validation caches cleared');
  }

  /**
   * Export debug information
   */
  getDebugInfo(): {
    geocodeCache: Array<{ address: string; coords: Coordinates }>;
    distanceCache: Array<DistanceCalculation>;
    failedAddresses: string[];
  } {
    return {
      geocodeCache: Array.from(this.geocodeCache.entries()).map(([address, coords]) => ({
        address,
        coords
      })),
      distanceCache: Array.from(this.distanceCache.values()),
      failedAddresses: Array.from(this.failedAddresses)
    };
  }
}