// Direct Google Maps Geocoding API Integration
// Bypasses Vertex AI for 100% accurate coordinates

import { jobLog } from './jobLogger';
import { geocodeCache } from './geocodeCache';
import { parallelSearchConfig } from './parallelSearchConfig';

interface GoogleMapsGeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  locationType: 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE';
  addressComponents: any[];
}

interface GoogleMapsResponse {
  status: 'OK' | 'ZERO_RESULTS' | 'OVER_QUERY_LIMIT' | 'REQUEST_DENIED' | 'INVALID_REQUEST';
  results: Array<{
    formatted_address: string;
    geometry: {
      location: { lat: number; lng: number };
      location_type: string;
    };
    address_components: any[];
  }>;
  error_message?: string;
}

export class GoogleMapsGeocoder {
  private apiKey: string;
  private baseUrl = 'https://maps.googleapis.com/maps/api/geocode/json';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.GOOGLE_MAPS_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('Google Maps API key is required');
    }
  }

  /**
   * Geocode a single address using Google Maps API
   */
  async geocodeAddress(
    address: string,
    maxAttempts: number = parallelSearchConfig.geocodeMaxAttempts
  ): Promise<GoogleMapsGeocodeResult | null> {
    // Check cache first
    const cached = await geocodeCache.get(address);
    if (cached) {
      return {
        lat: cached.lat,
        lng: cached.lon,
        formattedAddress: address,
        locationType: (cached.locationType || 'APPROXIMATE') as any,
        addressComponents: []
      };
    }

    jobLog(`🗺️  Direct Google Maps geocoding: ${address}`);

    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();

      try {
        const encodedAddress = encodeURIComponent(address);
        const url = `${this.baseUrl}?address=${encodedAddress}&key=${this.apiKey}`;

        const response = await fetch(url);
        const data: GoogleMapsResponse = await response.json();

        jobLog(`🗺️  Google Maps API status: ${data.status}`);

        if (data.status === 'OK' && data.results.length > 0) {
          const result = data.results[0];
          const location = result.geometry.location;

          jobLog(`🎯 Direct Google Maps result: ${location.lat}, ${location.lng}`);
          jobLog(`📍 Location type: ${result.geometry.location_type}`);
          jobLog(`📮 Formatted address: ${result.formatted_address}`);

          // Save to cache
          await geocodeCache.set(address, location.lat, location.lng, result.geometry.location_type);

          return {
            lat: location.lat,
            lng: location.lng,
            formattedAddress: result.formatted_address,
            locationType: result.geometry.location_type as any,
            addressComponents: result.address_components
          };
        }

        // OVER_QUERY_LIMIT is Google's own throttle, so it is the only retryable status.
        // Everything else is terminal: retrying it would hold the STEP 6 fast-fail open
        // for seconds on an address that can never geocode.
        if (data.status === 'OVER_QUERY_LIMIT') {
          if (attempt < maxAttempts) {
            const delayMs = this.retryDelayMs(attempt);
            jobLog(`🔁 GEOCODE RETRY ATTEMPT ${attempt + 1}/${maxAttempts}: status=${data.status}, elapsed=${Date.now() - t0}ms, delayMs=${delayMs}, address=${address}`);
            await this.sleep(delayMs);
            continue;
          }
          jobLog(`❌ GEOCODE RETRY_EXHAUSTED: attempts=${maxAttempts}, lastStatus=${data.status}, address=${address}`);
          return null;
        }

        jobLog(`❌ Google Maps geocoding failed: ${data.status}`);
        jobLog(`❌ GEOCODE TERMINAL STATUS: ${data.status} attempt=${attempt}/${maxAttempts}, address=${address}`);
        if (data.error_message) {
          jobLog(`❌ Error: ${data.error_message}`);
        }
        return null;
      } catch (error) {
        if (attempt < maxAttempts) {
          const delayMs = this.retryDelayMs(attempt);
          jobLog(`🔁 GEOCODE RETRY ATTEMPT ${attempt + 1}/${maxAttempts}: status=REQUEST_ERROR, elapsed=${Date.now() - t0}ms, delayMs=${delayMs}, address=${address}`);
          console.error(`⚠️  Google Maps API request error (will retry):`, error);
          await this.sleep(delayMs);
          continue;
        }
        jobLog(`❌ GEOCODE RETRY_EXHAUSTED: attempts=${maxAttempts}, lastStatus=REQUEST_ERROR, address=${address}`);
        console.error(`❌ Google Maps API error:`, error);
        return null;
      }
    }
  }

  /** Exponential backoff + jitter: base 500ms -> 500, 1000, 2000 (from v10 geocode retry test). */
  private retryDelayMs(attempt: number): number {
    const { geocodeRetryBaseMs, geocodeRetryJitterMs } = parallelSearchConfig;
    return Math.round(geocodeRetryBaseMs * 2 ** (attempt - 1) + Math.random() * geocodeRetryJitterMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Geocode multiple addresses in parallel
   */
  async geocodeAddresses(addresses: string[]): Promise<Map<string, GoogleMapsGeocodeResult>> {
    jobLog(`🗺️  Geocoding ${addresses.length} addresses with Google Maps API`);

    const results = new Map<string, GoogleMapsGeocodeResult>();

    // Geocode all addresses in parallel
    const promises = addresses.map(async (address) => {
      const result = await this.geocodeAddress(address, 1);
      if (result) {
        results.set(address, result);
      }
      return { address, result };
    });

    await Promise.all(promises);

    jobLog(`🗺️  Successfully geocoded ${results.size}/${addresses.length} addresses`);
    return results;
  }

  /**
   * Test coordinate accuracy against known reference
   */
  async testAccuracy(address: string, referenceLat: number, referenceLng: number): Promise<void> {
    const result = await this.geocodeAddress(address, 1);

    if (result) {
      // Calculate distance error using Haversine formula
      const R = 3959; // Earth's radius in miles
      const dLat = (result.lat - referenceLat) * Math.PI / 180;
      const dLon = (result.lng - referenceLng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(referenceLat * Math.PI / 180) * Math.cos(result.lat * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;

      jobLog(`\n🎯 ACCURACY TEST: ${address}`);
      jobLog(`📍 Reference: ${referenceLat}, ${referenceLng}`);
      jobLog(`📍 Google Maps: ${result.lat}, ${result.lng}`);
      jobLog(`📏 Distance error: ${distance.toFixed(6)} miles (${(distance * 5280).toFixed(1)} feet)`);
      jobLog(`✅ Location type: ${result.locationType}`);
    } else {
      jobLog(`❌ Failed to geocode: ${address}`);
    }
  }
}