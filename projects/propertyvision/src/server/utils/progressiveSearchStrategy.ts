// Progressive Expansion Search Strategy
// Replaces redundant identical searches with intelligent expansion

import { getRedisCache } from './redisCache';
import { jobLog } from './jobLogger';
import { updateJobProgress, isJobCancelled, PHASES } from './jobProgress';

interface SearchLevel {
  level: number;
  name: string;
  criteria: {
    radius: number; // miles
    timeWindow: number; // months
    subdivision: boolean;
    sizeVariance: number; // percentage
    bedsVariance: number; // +/- beds
    bathsVariance: number; // +/- baths
    maxResults: number;
  };
  targetComps: number;
  description: string;
}

interface SearchResult {
  level: SearchLevel;
  properties: any[];
  qualified: any[];
  rawComps: any[]; // Raw unfiltered comps from this level
  searchTime: number;
  success: boolean;
  cacheHit?: boolean;
}

interface ProgressiveSearchResult {
  finalProperties: any[];
  searchHistory: SearchResult[];
  stoppedAtLevel: number;
  summary: {
    totalSearches: number;
    totalTime: number;
    cacheHits: number;
    finalCount: number;
    qualityScore: 'excellent' | 'good' | 'fair' | 'poor';
  };
}

export class ProgressiveSearchStrategy {
  // Global raw comps cache - stores ALL raw comps from every search run, keyed by subject address
  private static globalRawCompsCache = new Map<string, any[]>(); // key: subject address, value: array of all raw comps with full property details
  private redisCache = getRedisCache();

  constructor() {
    // Global cache persists across all instances and requests
    // Redis cache provides persistence across server restarts
  }

  /**
   * Define search levels with progressive expansion
   */
  private getSearchLevels(hasSubdivision: boolean): SearchLevel[] {
    const levels: SearchLevel[] = [
      {
        level: 1,
        name: 'Tight Local',
        criteria: {
          radius: 1.0,
          timeWindow: 12,
          subdivision: hasSubdivision,
          sizeVariance: 20,
          bedsVariance: 1,
          bathsVariance: 1,
          maxResults: 30
        },
        targetComps: 6,
        description: hasSubdivision ? 'Same subdivision, 1 mile, 12 months, ±1 beds/baths' : 'Local area, 1 mile, 12 months, ±1 beds/baths'
      },
      {
        level: 2,
        name: 'Extended Local',
        criteria: {
          radius: 2.0,
          timeWindow: 15,
          subdivision: hasSubdivision,
          sizeVariance: 20,
          bedsVariance: 1,
          bathsVariance: 1,
          maxResults: 40
        },
        targetComps: 4,
        description: hasSubdivision ? 'Same subdivision, 2 miles, 15 months, ±1 beds/baths' : 'Local area, 2 miles, 15 months, ±1 beds/baths'
      },
      {
        level: 3,
        name: 'Broader Market',
        criteria: {
          radius: 3.0,
          timeWindow: 18,
          subdivision: false,
          sizeVariance: 25,
          bedsVariance: 2,
          bathsVariance: 2,
          maxResults: 50
        },
        targetComps: 3,
        description: 'Market area, 3 miles, 18 months, ±2 beds/baths, no subdivision filter'
      },
      {
        level: 4,
        name: 'Extended Market',
        criteria: {
          radius: 5.0,
          timeWindow: 24,
          subdivision: false,
          sizeVariance: 30,
          bedsVariance: 3,
          bathsVariance: 3,
          maxResults: 75
        },
        targetComps: 2,
        description: 'Extended market, 5 miles, 24 months, ±3 beds/baths, relaxed criteria'
      }
    ];

    return levels;
  }

  /**
   * Generate cache key for search parameters
   */
  private generateCacheKey(
    address: string,
    level: SearchLevel,
    subjectDetails?: { sqft: number; beds: number; baths: number; yearBuilt: number }
  ): string {
    const key = [
      address.toLowerCase().trim(),
      level.level,
      level.criteria.radius,
      level.criteria.timeWindow,
      level.criteria.subdivision ? 'sub' : 'nosub',
      level.criteria.sizeVariance,
      subjectDetails ? `${subjectDetails.sqft}_${subjectDetails.beds}_${subjectDetails.baths}` : 'nosubject'
    ].join('|');

    return key;
  }

  /**
   * Get cached raw comps for a specific subject address
   */
  private async getCachedRawComps(subjectAddress: string): Promise<any[]> {
    // Try Redis first
    const redisComps = await this.redisCache.getRawComps(subjectAddress);
    if (redisComps.length > 0) {
      jobLog(`   💾 Found ${redisComps.length} cached raw comps from Redis for ${subjectAddress}`);
      // Sync to in-memory cache
      ProgressiveSearchStrategy.globalRawCompsCache.set(subjectAddress, redisComps);
      return redisComps;
    }

    // Fallback to in-memory cache
    const cached = ProgressiveSearchStrategy.globalRawCompsCache.get(subjectAddress);
    if (!cached) {
      jobLog(`   💾 No cache found for ${subjectAddress}`);
      return [];
    }
    jobLog(`   💾 Found ${cached.length} cached raw comps from in-memory for ${subjectAddress}`);
    return cached;
  }

  /**
   * Update global cache with new raw comps found in this run
   */
  private async updateGlobalCache(subjectAddress: string, allRawCompsFromRun: any[]): Promise<void> {
    // Try Redis first
    await this.redisCache.updateRawComps(subjectAddress, allRawCompsFromRun);

    // Also update in-memory cache for immediate access
    const existingCache = ProgressiveSearchStrategy.globalRawCompsCache.get(subjectAddress) || [];

    // Create a map of existing cached comps by address for fast lookup
    const existingAddresses = new Set(existingCache.map(comp => comp.address?.toLowerCase()));

    // Find new comps not in cache
    const newComps = allRawCompsFromRun.filter(comp =>
      comp.address && !existingAddresses.has(comp.address.toLowerCase())
    );

    if (newComps.length > 0) {
      const updatedCache = [...existingCache, ...newComps];
      ProgressiveSearchStrategy.globalRawCompsCache.set(subjectAddress, updatedCache);
      jobLog(`   💾 In-memory cache updated: Added ${newComps.length} new comps. Total cached: ${updatedCache.length}`);
    } else {
      jobLog(`   💾 In-memory cache unchanged: No new comps found. Total cached: ${existingCache.length}`);
    }
  }

  /**
   * Check if we have enough comps for dual ARV analysis (baseline + upgrade)
   */
  private checkDualARVRequirements(
    properties: any[],
    subjectDetails: { baths: number } | undefined
  ): { sufficient: boolean; reason: string; baseline: number; upgrade: number } {
    if (!subjectDetails) {
      return { sufficient: true, reason: 'no subject details for bathroom analysis', baseline: 0, upgrade: 0 };
    }

    const subjectBaths = subjectDetails.baths;
    const epsilon = 1e-9; // Float comparison tolerance

    // Count baseline comps (≤ subject bathrooms)
    const baselineComps = properties.filter(prop => {
      const compBaths = parseFloat(prop.baths?.toString() || 'NaN');
      return Number.isFinite(compBaths) && compBaths <= subjectBaths + epsilon;
    });

    // Count upgrade comps (2+ bathrooms) - only relevant if subject has < 2 baths
    const upgradeComps = properties.filter(prop => {
      const compBaths = parseFloat(prop.baths?.toString() || 'NaN');
      return Number.isFinite(compBaths) && compBaths >= 2;
    });

    const needsUpgradeAnalysis = subjectBaths < 2;
    const hasEnoughBaseline = baselineComps.length >= 3;
    const hasEnoughUpgrade = upgradeComps.length >= 3;

    if (!needsUpgradeAnalysis) {
      // Subject has 2+ baths - only need baseline comps
      return {
        sufficient: hasEnoughBaseline,
        reason: hasEnoughBaseline ? 'sufficient baseline comps' : `need ${3 - baselineComps.length} more baseline comps (≤${subjectBaths} baths)`,
        baseline: baselineComps.length,
        upgrade: upgradeComps.length
      };
    } else {
      // Subject has < 2 baths - need both baseline AND upgrade comps for dual ARV
      const sufficient = hasEnoughBaseline && hasEnoughUpgrade;
      let reason = 'dual ARV requirements: ';

      if (!hasEnoughBaseline && !hasEnoughUpgrade) {
        reason += `need ${3 - baselineComps.length} more baseline (≤${subjectBaths} baths) and ${3 - upgradeComps.length} more upgrade (2+ baths) comps`;
      } else if (!hasEnoughBaseline) {
        reason += `need ${3 - baselineComps.length} more baseline comps (≤${subjectBaths} baths)`;
      } else if (!hasEnoughUpgrade) {
        reason += `need ${3 - upgradeComps.length} more upgrade comps (2+ baths)`;
      } else {
        reason = 'dual ARV requirements satisfied';
      }

      return {
        sufficient,
        reason,
        baseline: baselineComps.length,
        upgrade: upgradeComps.length
      };
    }
  }

  /**
   * Calculate quality score based on results
   */
  private calculateQualityScore(
    finalProperties: any[],
    searchHistory: SearchResult[]
  ): 'excellent' | 'good' | 'fair' | 'poor' {
    const count = finalProperties.length;
    const stoppedAtLevel = Math.max(...searchHistory.map(s => s.level.level));

    // Check distance quality
    const avgDistance = finalProperties.reduce((sum, p) => sum + (p.distance || 0), 0) / count;

    // Check time quality
    const recentComps = finalProperties.filter(p => {
      if (!p.soldDate) return false;
      const soldDate = new Date(p.soldDate);
      const monthsAgo = (Date.now() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
      return monthsAgo <= 12;
    }).length;

    if (count >= 6 && stoppedAtLevel <= 2 && avgDistance <= 1.5 && recentComps >= 4) {
      return 'excellent';
    } else if (count >= 4 && stoppedAtLevel <= 3 && avgDistance <= 2.5 && recentComps >= 2) {
      return 'good';
    } else if (count >= 3 && avgDistance <= 3.5) {
      return 'fair';
    } else {
      return 'poor';
    }
  }

  /**
   * Execute search at specific level
   */
  private async executeSearchLevel(
    level: SearchLevel,
    address: string,
    subjectDetails: { sqft: number; beds: number; baths: number; yearBuilt: number } | undefined,
    searchService: any, // VertexComparableSearchService
    propertyType?: string
  ): Promise<SearchResult> {
    const startTime = Date.now();

    jobLog(`🔍 Level ${level.level}: ${level.name}`);
    jobLog(`   📐 ${level.description}`);

    try {
      // Set search parameters
      const originalSubdivision = process.env.SUBDIVISION;
      if (level.criteria.subdivision && subjectDetails) {
        // We need subdivision info - this would come from property details
        // For now, keep existing subdivision setting
      } else {
        process.env.SUBDIVISION = '';
      }

      // Execute search
      jobLog(`🔍 DEBUG LEVEL: About to call searchService.findComparables`);
      jobLog(`🔍 DEBUG LEVEL: Parameters - address="${address}", propertyType="${propertyType}", maxResults=${level.criteria.maxResults}, radius=${level.criteria.radius}, timeWindow=${level.criteria.timeWindow}`);
      const searchResult = await searchService.findComparables(
        address,
        propertyType, // Pass through the propertyType parameter
        level.criteria.maxResults,
        level.criteria.radius,
        level.criteria.timeWindow,
        subjectDetails
      );
      jobLog(`🔍 DEBUG LEVEL: searchService.findComparables completed`);
      jobLog(`🔍 DEBUG LEVEL: searchResult type:`, typeof searchResult);
      jobLog(`🔍 DEBUG LEVEL: searchResult keys:`, searchResult ? Object.keys(searchResult) : 'null');

      // 🚨 CRITICAL DEBUG CHECKPOINT: STATE DUMP FOR 1408 LYLE AVE BUG
      jobLog('\n🔍 CRITICAL STATE DUMP - executeSearchLevel');
      jobLog('===========================================');
      jobLog(`🔍 Stage: POST_SEARCH_SERVICE_CALL`);
      jobLog(`🔍 Level: ${level.level} (${level.name})`);
      jobLog(`🔍 SearchResult structure:`, JSON.stringify(searchResult, null, 2));

      if (searchResult && searchResult.comparables) {
        jobLog(`🔍 SearchResult.comparables length: ${searchResult.comparables.length}`);
        searchResult.comparables.forEach((comp, index) => {
          jobLog(`🔍   [${index}] ${comp.address || 'NO_ADDRESS'} - $${comp.price || 'NO_PRICE'} - ${comp.sqft || 'NO_SQFT'}sqft`);
        });
      } else {
        jobLog(`🚨 SearchResult.comparables is NULL or UNDEFINED`);
        jobLog(`🚨 searchResult:`, searchResult);
      }

      // Restore original subdivision
      process.env.SUBDIVISION = originalSubdivision;

      const searchTime = Date.now() - startTime;
      const qualified = searchResult.comparables || [];
      const rawComps = searchResult.all_comps || []; // Get raw unfiltered comps

      jobLog(`\n🔍 CRITICAL STATE DUMP - POST_EXTRACTION`);
      jobLog('========================================');
      jobLog(`🔍 Stage: POST_QUALIFIED_EXTRACTION`);
      jobLog(`🔍 qualified.length: ${qualified.length}`);
      jobLog(`🔍 rawComps.length: ${rawComps.length}`);
      jobLog(`🔍 qualified array:`, qualified.map(comp => `${comp.address} - $${comp.price}`));

      if (qualified.length === 0) {
        jobLog(`🚨 CRITICAL: qualified array is EMPTY despite potential searchResult.comparables`);
        jobLog(`🚨 This is the exact bug we're tracking!`);
      }


      jobLog(`   ✅ Found ${qualified.length} qualified comps and ${rawComps.length} raw comps in ${searchTime}ms`);

      return {
        level,
        properties: qualified,
        qualified,
        rawComps,
        searchTime,
        success: true,
        cacheHit: false
      };

    } catch (error: any) {
      jobLog(`   ❌ Level ${level.level} failed: ${error.message}`);

      return {
        level,
        properties: [],
        qualified: [],
        rawComps: [],
        searchTime: Date.now() - startTime,
        success: false,
        cacheHit: false
      };
    }
  }

  /**
   * Execute progressive search with early termination
   */
  async executeProgressiveSearch(
    address: string,
    subjectDetails: { sqft: number; beds: number; baths: number; yearBuilt: number; subdivision?: string } | undefined,
    searchService: any,
    subdivision?: string,
    propertyType?: string
  ): Promise<ProgressiveSearchResult> {
    jobLog('🎯 PROGRESSIVE EXPANSION SEARCH');
    jobLog('===============================');
    jobLog(`📍 Subject: ${address}`);
    jobLog(`🚨 DEBUG PROGRESSIVE SEARCH: propertyType="${propertyType}" (type: ${typeof propertyType})`);
    jobLog(`🔧 DIAG_PROGRESSIVE_ACTIVE: strategy=progressive_expansion, max_levels=4`);
    jobLog(`🔧 DIAG_SEARCH_MODE: mode=progressive (NOT legacy 6-prompt mode)`);
    if (subjectDetails) {
      jobLog(`🏠 Subject: ${subjectDetails.sqft}sqft, ${subjectDetails.beds}BR/${subjectDetails.baths}BA, built ${subjectDetails.yearBuilt}`);
    }

    const hasSubdivision = Boolean(subdivision || process.env.SUBDIVISION);
    const searchLevels = this.getSearchLevels(hasSubdivision);
    const searchHistory: SearchResult[] = [];
    const allDiscoveredComps = new Map<string, any>(); // Track ALL discovered raw comps across all levels
    let lastFilteredComps: any[] = []; // Track the last filtered result from the loop

    let stoppedAtLevel = 0;
    const startTime = Date.now();

    for (const level of searchLevels) {
      // Update progress based on level
      const progressKey = `COMPARABLE_SEARCH_L${level.level}` as keyof typeof PHASES;
      await updateJobProgress(progressKey);

      // Check if job was cancelled
      if (await isJobCancelled()) {
        jobLog(`🚫 Job cancelled at Level ${level.level}, stopping search`);
        break;
      }

      const result = await this.executeSearchLevel(level, address, subjectDetails, searchService, propertyType);
      searchHistory.push(result);
      stoppedAtLevel = level.level;

      if (result.success) {
        // Step 1: Add ALL new raw discoveries to our accumulation (no filtering at this stage)
        const newCompsAdded = result.rawComps?.length || 0;
        if (result.rawComps && result.rawComps.length > 0) {
          result.rawComps.forEach(prop => {
            const key = `${prop.address}|${prop.price}|${prop.sqft}`;
            if (!allDiscoveredComps.has(key)) {
              allDiscoveredComps.set(key, { ...prop, foundAtLevel: level.level });
            }
          });
        }

        jobLog(`   📊 Level ${level.level}: Added ${newCompsAdded} new raw comps`);
        jobLog(`   📦 Total accumulated raw comps: ${allDiscoveredComps.size}`);

        // INJECT CACHED COMPS AFTER LEVEL 1 COMPLETES
        if (level.level === 1) {
          const cachedComps = await this.getCachedRawComps(address);
          if (cachedComps.length > 0) {
            jobLog(`\n💾 Injecting ${cachedComps.length} cached raw comps from previous runs...`);
            cachedComps.forEach(cachedComp => {
              const key = `${cachedComp.address}|${cachedComp.price}|${cachedComp.sqft}`;
              if (!allDiscoveredComps.has(key)) {
                allDiscoveredComps.set(key, { ...cachedComp, foundAtLevel: 0 }); // Mark as from cache
              }
            });
            jobLog(`   📦 Total after cache injection: ${allDiscoveredComps.size}`);
          }
        }

        // Step 2: Get all accumulated comps for filtering
        const accumulatedRawComps = Array.from(allDiscoveredComps.values());

        // Step 3: Apply bedroom, size, time filtering to ALL accumulated comps
        jobLog(`\n🔍 Level ${level.level} Filtering: Bedroom, Size, Time on ${accumulatedRawComps.length} accumulated comps`);
        const beforeFiltering = accumulatedRawComps.length;
        const filteredComps = accumulatedRawComps.filter(comp => {
          // Bedroom filter: Use level's bedsVariance
          if (subjectDetails?.beds) {
            const bedroomDiff = Math.abs((comp.beds || 0) - subjectDetails.beds);
            if (bedroomDiff > level.criteria.bedsVariance) {
              jobLog(`   ❌ BEDROOM REJECTED ${comp.address}: ${comp.beds}BR vs ${subjectDetails.beds}BR (diff: ${bedroomDiff}, limit: ±${level.criteria.bedsVariance})`);
              return false;
            }
          }

          // Size filter: Use level's sizeVariance
          if (subjectDetails?.sqft) {
            const sizeVariance = Math.abs(comp.sqft - subjectDetails.sqft) / subjectDetails.sqft * 100;
            if (sizeVariance > level.criteria.sizeVariance) {
              jobLog(`   ❌ SIZE REJECTED ${comp.address}: ${sizeVariance.toFixed(1)}% variance (> ${level.criteria.sizeVariance}% limit)`);
              return false;
            }
          }

          // Time filter: Check against level's timeWindow parameter
          if (level.criteria.timeWindow && comp.soldDate) {
            try {
              const soldDate = new Date(comp.soldDate);
              const today = new Date();
              const ageInMonths = Math.floor((today.getTime() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
              if (Number.isFinite(ageInMonths) && ageInMonths > level.criteria.timeWindow) {
                jobLog(`   ❌ TIME REJECTED ${comp.address}: ${ageInMonths} months old (> ${level.criteria.timeWindow} months limit)`);
                return false;
              }
            } catch (error) {
              jobLog(`   ❌ TIME REJECTED ${comp.address}: Error parsing date`);
              return false;
            }
          }

          return true;
        });

        const afterFiltering = filteredComps.length;
        jobLog(`   📊 Bedroom/Size/Time filtering: ${beforeFiltering} → ${afterFiltering} (removed ${beforeFiltering - afterFiltering})`);

        // Step 4: Apply distance filtering to filtered comps
        jobLog(`\n📏 Level ${level.level} Filtering: Distance with radius ${level.criteria.radius}mi`);
        const beforeDistanceFilter = filteredComps.length;
        const distanceFilteredComps = filteredComps.filter((comp) => {
          if (comp.distance === null || comp.distance === undefined) {
            jobLog(`   ❌ DISTANCE REJECTED ${comp.address}: No distance calculated`);
            return false;
          }
          if (comp.distance <= level.criteria.radius) {
            jobLog(`   ✅ DISTANCE OK ${comp.address}: ${comp.distance.toFixed(2)} miles (≤ ${level.criteria.radius} miles)`);
            return true;
          } else {
            jobLog(`   ❌ DISTANCE REJECTED ${comp.address}: ${comp.distance.toFixed(2)} miles (> ${level.criteria.radius} miles)`);
            return false;
          }
        });

        const afterDistanceFilter = distanceFilteredComps.length;
        jobLog(`   📊 Distance filtering: ${beforeDistanceFilter} → ${afterDistanceFilter} (removed ${beforeDistanceFilter - afterDistanceFilter})`);

        // Store the last filtered result
        lastFilteredComps = distanceFilteredComps;

        // Termination criteria: check if we have enough qualified comps after ALL filtering
        if (afterDistanceFilter >= level.targetComps) {
          jobLog(`   🎯 Progressive search target achieved: ${afterDistanceFilter} qualified comps found (≥ ${level.targetComps} required) - stopping search`);
          break;
        } else {
          jobLog(`   ⏭️  Need ${level.targetComps - afterDistanceFilter} more qualified comps - continuing to next level`);
        }
      } else {
        jobLog(`   ⚠️  Level ${level.level} failed - continuing`);
      }
    }

    // Use the last filtered comps from the loop (already fully filtered)
    const finalProperties = lastFilteredComps.length > 0 ? lastFilteredComps : Array.from(allDiscoveredComps.values());
    jobLog(`\n✅ Final properties after progressive filtering: ${finalProperties.length}`);

    const totalTime = Date.now() - startTime;
    const cacheHits = searchHistory.filter(s => s.cacheHit).length;
    const qualityScore = this.calculateQualityScore(finalProperties, searchHistory);

    jobLog('\n📊 PROGRESSIVE SEARCH SUMMARY:');
    jobLog(`   🔍 Searches executed: ${searchHistory.length}`);
    jobLog(`   💾 Cache hits: ${cacheHits}/${searchHistory.length}`);
    jobLog(`   ⏱️  Total time: ${totalTime}ms`);
    jobLog(`   🏁 Stopped at level: ${stoppedAtLevel}`);
    jobLog(`   📈 Final count: ${finalProperties.length} properties`);
    jobLog(`   🎯 Quality score: ${qualityScore.toUpperCase()}`);

    // Log level breakdown
    jobLog('\n📋 LEVEL BREAKDOWN:');
    searchHistory.forEach(result => {
      const icon = result.success ? '✅' : '❌';
      const cache = result.cacheHit ? '💾' : '🔍';
      jobLog(`   ${icon} ${cache} Level ${result.level.level}: ${result.qualified.length} comps (${result.searchTime}ms)`);
    });

    // UPDATE GLOBAL CACHE: Add all raw comps from this run to the address-specific cache
    const allRawCompsFromRun = Array.from(allDiscoveredComps.values()).filter(comp => comp.foundAtLevel > 0); // Exclude cached comps (foundAtLevel = 0)
    if (allRawCompsFromRun.length > 0) {
      jobLog(`\n💾 Updating global cache with ${allRawCompsFromRun.length} raw comps from this run...`);
      await this.updateGlobalCache(address, allRawCompsFromRun);
    }

    return {
      finalProperties,
      searchHistory,
      stoppedAtLevel,
      summary: {
        totalSearches: searchHistory.length,
        totalTime,
        cacheHits,
        finalCount: finalProperties.length,
        qualityScore
      }
    };
  }

  /**
   * Clear global cache (useful for testing)
   */
  async clearCache(): Promise<void> {
    await this.redisCache.clearAll();
    ProgressiveSearchStrategy.globalRawCompsCache.clear();
    jobLog('🗑️  Global raw comps cache cleared (Redis + in-memory)');
  }

  /**
   * Get cache stats (for debugging)
   */
  async getCacheStats(): Promise<{ redis: { totalAddresses: number; totalComps: number }; inMemory: { totalAddresses: number; totalComps: number } }> {
    const redisStats = await this.redisCache.getCacheStats();

    const totalAddresses = ProgressiveSearchStrategy.globalRawCompsCache.size;
    let totalComps = 0;
    ProgressiveSearchStrategy.globalRawCompsCache.forEach(comps => {
      totalComps += comps.length;
    });

    return {
      redis: redisStats,
      inMemory: { totalAddresses, totalComps }
    };
  }

  /**
   * Apply all filtering criteria to accumulated raw comps using current level's criteria
   */
  private async applyAllFilteringCriteria(
    rawComps: any[],
    subjectAddress: string,
    subjectDetails: any,
    level: SearchLevel
  ): Promise<any[]> {
    if (rawComps.length === 0) return rawComps;

    jobLog(`🔄 Applying all filtering criteria to ${rawComps.length} raw comps for Level ${level.level}`);

    // For now, return all raw comps without filtering
    // TODO: Implement proper filtering logic that reuses existing comprehensive search filtering
    jobLog(`✅ Raw comp accumulation working - returning ${rawComps.length} comps (filtering to be implemented)`);

    return rawComps;
  }

  /**
   * Apply distance filtering to a single level's results
   */
  private async applyDistanceFilteringToLevel(
    properties: any[],
    subjectAddress: string,
    level: SearchLevel
  ): Promise<any[]> {
    if (properties.length === 0) return properties;

    jobLog(`\n📐 DISTANCE VALIDATION (Level ${level.level}): Checking ${properties.length} properties`);

    // Import GoogleMapsGeocoder to get subject coordinates
    const { GoogleMapsGeocoder } = await import('./googleMapsGeocoder');
    const geocoder = new GoogleMapsGeocoder();

    const subjectResult = await geocoder.geocodeAddress(subjectAddress);
    if (!subjectResult) {
      jobLog(`❌ Cannot get subject coordinates for ${subjectAddress} - skipping distance filtering`);
      return properties;
    }

    const subjectLat = subjectResult.lat;
    const subjectLng = subjectResult.lng;
    const maxRadius = level.criteria.radius;
    jobLog(`📍 Subject coordinates: ${subjectLat}, ${subjectLng} (max radius: ${maxRadius}mi)`);

    const filteredProperties: any[] = [];

    for (const property of properties) {
      // Get property coordinates
      const propResult = await geocoder.geocodeAddress(property.address);
      if (!propResult) {
        jobLog(`   ❌ Cannot geocode ${property.address} - excluding`);
        continue;
      }

      // Calculate distance
      const distance = this.calculateHaversineDistance(
        subjectLat, subjectLng, propResult.lat, propResult.lng
      );

      property.distance = distance; // Add distance to property for logging

      if (distance <= maxRadius) {
        jobLog(`   ✅ ${property.address}: ${distance.toFixed(2)} miles (≤ ${maxRadius}mi)`);
        filteredProperties.push(property);
      } else {
        jobLog(`   ❌ ${property.address}: ${distance.toFixed(2)} miles (> ${maxRadius}mi) - EXCLUDED`);
      }
    }

    jobLog(`📐 Level ${level.level} distance filtering: ${properties.length} → ${filteredProperties.length} properties`);
    return filteredProperties;
  }

  /**
   * Apply distance filtering to final results based on which level they were found at
   */
  private async applyDistanceFiltering(
    properties: any[],
    subjectAddress: string,
    searchLevels: SearchLevel[]
  ): Promise<any[]> {
    if (properties.length === 0) return properties;

    jobLog(`\n📐 DISTANCE VALIDATION: Checking ${properties.length} properties`);

    // Import GoogleMapsGeocoder to get subject coordinates
    const { GoogleMapsGeocoder } = await import('./googleMapsGeocoder');
    const geocoder = new GoogleMapsGeocoder();

    const subjectResult = await geocoder.geocodeAddress(subjectAddress);
    if (!subjectResult) {
      jobLog(`❌ Cannot get subject coordinates for ${subjectAddress} - skipping distance filtering`);
      return properties;
    }

    const subjectLat = subjectResult.lat;
    const subjectLng = subjectResult.lng;
    jobLog(`📍 Subject coordinates: ${subjectLat}, ${subjectLng}`);

    const filteredProperties: any[] = [];

    for (const property of properties) {
      // Get the level this property was found at
      const foundAtLevel = property.foundAtLevel || 1;
      const levelConfig = searchLevels.find(l => l.level === foundAtLevel);
      const maxRadius = levelConfig?.criteria.radius || 5.0; // Default fallback

      // Get property coordinates
      const propResult = await geocoder.geocodeAddress(property.address);
      if (!propResult) {
        jobLog(`   ❌ Cannot geocode ${property.address} - excluding`);
        continue;
      }

      // Calculate distance
      const distance = this.calculateHaversineDistance(
        subjectLat, subjectLng, propResult.lat, propResult.lng
      );

      property.distance = distance; // Add distance to property for logging

      if (distance <= maxRadius) {
        jobLog(`   ✅ ${property.address}: ${distance.toFixed(2)} miles (≤ ${maxRadius}mi for Level ${foundAtLevel})`);
        filteredProperties.push(property);
      } else {
        jobLog(`   ❌ ${property.address}: ${distance.toFixed(2)} miles (> ${maxRadius}mi for Level ${foundAtLevel}) - EXCLUDED`);
      }
    }

    jobLog(`📐 Distance filtering: ${properties.length} → ${filteredProperties.length} properties`);
    return filteredProperties;
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  private calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3959; // Earth's radius in miles
    const dLat = this.degreesToRadians(lat2 - lat1);
    const dLon = this.degreesToRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.degreesToRadians(lat1)) * Math.cos(this.degreesToRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return distance;
  }

  /**
   * Helper function to convert degrees to radians
   */
  private degreesToRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}