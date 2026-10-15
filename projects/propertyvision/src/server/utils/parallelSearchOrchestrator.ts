// Parallel Search Orchestrator
// Coordinates parallel execution of all search levels with progressive qualification

import { BoundedQueue } from './boundedQueue';
import { redisSemaphore } from './redisSemaphore';
import { geocodeCache } from './geocodeCache';
import { GoogleMapsGeocoder } from './googleMapsGeocoder';
import { getRedisCache } from './redisCache';
import { topK } from './minHeap';
import {
  ComparableProperty,
  SubjectProperty,
  dedupeKey,
  scoreComparable,
  mergeComparables
} from './compScoring';
import { parallelSearchConfig } from './parallelSearchConfig';
import { isSamePropertyAddress } from './addressNormalizer';
import { VertexComparableSearchService } from '../step3-find-comparables';
import { jobLog } from '../utils/jobLogger';

export interface SearchLevelResult {
  level: number;
  rawComps: ComparableProperty[];
  searchTime: number;
  success: boolean;
  error?: string;
}

export interface ParallelSearchResult {
  qualifiedComps: ComparableProperty[];
  searchMetadata: {
    totalSearchTime: number;
    levelsRun: number[];
    earlyStopAtLevel?: number;
    totalRawComps: number;
    cacheHits: number;
    metrics: {
      [key: string]: any;
    };
  };
}

export class ParallelSearchOrchestrator {
  private vertexQueue: BoundedQueue;
  private geocodeQueue: BoundedQueue;
  private geocoder: GoogleMapsGeocoder;
  private compService: VertexComparableSearchService;
  private abortController: AbortController;
  private dataVersion = 0; // Incremented when new level results land
  private lastTriedVersion: Record<number, number> = { 1: -1, 2: -1, 3: -1, 4: -1 };

  constructor() {
    const config = parallelSearchConfig;
    this.vertexQueue = new BoundedQueue(config.vertexLocalConcurrency);
    this.geocodeQueue = new BoundedQueue(config.geocodeConcurrency);
    this.geocoder = new GoogleMapsGeocoder(process.env.GOOGLE_MAPS_API_KEY || '');
    this.compService = new VertexComparableSearchService();
    this.abortController = new AbortController();

    jobLog(`🚀 PARALLEL SEARCH ORCHESTRATOR initialized:`);
    jobLog(`   Vertex concurrency: ${config.vertexLocalConcurrency}`);
    jobLog(`   Geocode concurrency: ${config.geocodeConcurrency}`);
    jobLog(`   Levels: ${config.levels.join(',')}`);
  }

  /**
   * Execute parallel search across all configured levels
   */
  async executeParallelSearch(
    subject: SubjectProperty,
    subjectPropertyType?: string
  ): Promise<ParallelSearchResult> {
    const startTime = Date.now();
    const config = parallelSearchConfig;

    try {
      jobLog(`\n🔥 PARALLEL SEARCH START for: ${subject.address}`);
      jobLog(`   Subject: ${subject.beds}BR/${subject.baths}BA, ${subject.sqft}sqft`);
      jobLog(`   Subdivision: ${subject.subdivision || 'N/A'}`);
      jobLog(`   Running levels: ${config.levels.join(', ')}`);

      // Global state
      const pools = new Map<number, ComparableProperty[]>(); // Raw results per level
      const seenComps = new Map<string, ComparableProperty>(); // Deduplicated pool

      // ===== PHASE 1: Nearby Search (Levels 1-2) =====
      jobLog('\n🔍 PHASE 1: Searching nearby areas (1-2 miles)...');

      const phase1Promises: Promise<SearchLevelResult>[] = [];
      for (const level of config.phase1Levels) {
        jobLog(`   🚀 Launching Level ${level} search...`);
        const promise = this.executeLevelSearch(level, subject, subjectPropertyType);
        phase1Promises.push(promise);

        promise.then(result => this.onLevelReady(result, pools, seenComps, subject))
          .catch(error => {
            console.error(`❌ LEVEL ${level} FATAL ERROR:`, error);
          });
      }

      // Wait for Phase 1 to complete
      let phase1Results;
      try {
        phase1Results = await Promise.allSettled(phase1Promises);
      } catch (error) {
        console.error(`❌ [PHASE1_COORDINATION] ERROR:`, error);
        throw error;
      }

      jobLog(`\n📊 PHASE 1 COMPLETE - ${seenComps.size} unique comps accumulated`);

      // Try progressive passes on Phase 1 data
      let qualifiedComps: ComparableProperty[] = [];
      try {
        qualifiedComps = await this.tryProgressivePasses(pools, seenComps, subject, config.phase1Levels, false);
      } catch (error) {
        console.error(`❌ [PHASE1_QUALIFICATION] ERROR:`, error);
        qualifiedComps = [];
      }

      // ===== DECISION POINT: Do we need Phase 2? =====
      if (qualifiedComps.length >= config.minCompsThreshold) {
        jobLog(`\n✅ PHASE 1 SUCCESS: Found ${qualifiedComps.length} qualified comps (≥${config.minCompsThreshold})`);
        jobLog(`   ⚡ Skipping Phase 2 (levels 3-4) - early exit`);

        const totalTime = Date.now() - startTime;
        return {
          qualifiedComps: qualifiedComps.slice(0, config.targetComps),
          searchMetadata: {
            totalSearchTime: totalTime,
            levelsRun: config.phase1Levels,
            earlyStopAtLevel: 2,
            totalRawComps: seenComps.size,
            cacheHits: 0,
            metrics: {
              vertexQueueStats: this.vertexQueue.getStats(),
              geocodeQueueStats: this.geocodeQueue.getStats(),
            }
          }
        };
      }

      // ===== PHASE 2: Expanded Search (Levels 3-4) =====
      jobLog(`\n PHASE 2: Expanding search area (3-4 miles)...`);
      jobLog(`   ℹ️  Phase 1 found ${qualifiedComps.length} comps (<${config.minCompsThreshold} minimum)`);

      const phase2Promises: Promise<SearchLevelResult>[] = [];
      for (const level of config.phase2Levels) {
        jobLog(`    Launching Level ${level} search...`);
        const promise = this.executeLevelSearch(level, subject, subjectPropertyType);
        phase2Promises.push(promise);

        promise.then(result => this.onLevelReady(result, pools, seenComps, subject))
          .catch(error => {
            console.error(`❌ LEVEL ${level} FATAL ERROR:`, error);
          });
      }

      // Wait for Phase 2 to complete
      let phase2Results;
      try {
        phase2Results = await Promise.allSettled(phase2Promises);
      } catch (error) {
        console.error(`❌ [PHASE2_COORDINATION] ERROR:`, error);
        throw error;
      }

      jobLog(`\n📊 PHASE 2 COMPLETE - ${seenComps.size} total unique comps`);

      // ===== FINAL PASS: All 4 levels =====
      jobLog(`\n🔍 FINAL PASS - Progressive filtering on all accumulated comps`);
      let finalComps;
      try {
        finalComps = await this.tryProgressivePasses(pools, seenComps, subject, [...config.phase1Levels, ...config.phase2Levels], true);
      } catch (error) {
        console.error(`❌ [FINAL_PASS] ERROR:`, error);
        throw error;
      }

      const totalTime = Date.now() - startTime;

      return {
        qualifiedComps: finalComps.slice(0, config.targetComps),
        searchMetadata: {
          totalSearchTime: totalTime,
          levelsRun: [...config.phase1Levels, ...config.phase2Levels],
          totalRawComps: seenComps.size,
          cacheHits: 0, // TODO: track cache hits
          metrics: {
            vertexQueueStats: this.vertexQueue.getStats(),
            geocodeQueueStats: this.geocodeQueue.getStats(),
          }
        }
      };

    } catch (error) {
      console.error(`❌ PARALLEL SEARCH FATAL ERROR:`, error);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      throw error;
    }
  }

  /**
   * Handle when a search level completes
   */
  private async onLevelReady(
    result: SearchLevelResult,
    pools: Map<number, ComparableProperty[]>,
    seenComps: Map<string, ComparableProperty>,
    subject: SubjectProperty
  ): Promise<void> {
    try {
      jobLog(`\n✅ LEVEL ${result.level} READY - ${result.rawComps.length} raw comps`);

      // Store raw results
      pools.set(result.level, result.rawComps);

      // Early deduplication - add to global pool
      try {
        for (const comp of result.rawComps) {
          const key = dedupeKey(comp);
          if (seenComps.has(key)) {
            // Merge with existing
            const existing = seenComps.get(key)!;
            seenComps.set(key, mergeComparables(existing, comp));
          } else {
            seenComps.set(key, comp);
          }
        }
      } catch (error) {
        console.error(`❌ [DEDUPLICATION_LOOP] ERROR during early deduplication:`);
        console.error(`   Error type: ${typeof error}`);
        console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
        console.error(`   Context: level=${result.level}, rawCompsCount=${result.rawComps.length}, currentSeenCompsSize=${seenComps.size}`);
        // Continue execution - partial deduplication is better than none
      }

      jobLog(`   📦 Total unique comps accumulated: ${seenComps.size}`);

      // Bump data version since new data landed
      this.dataVersion++;
      jobLog(`   📊 Data version: ${this.dataVersion}`);

      // Try progressive passes based on what we have
      const availableLevels = Array.from(pools.keys()).sort();
      jobLog(`   🔍 Attempting progressive passes with levels: ${availableLevels.join(',')}`);

      const qualified = await this.tryProgressivePasses(pools, seenComps, subject, availableLevels, false);

      // Note: No early exit - we always wait for all levels and run final pass
      if (qualified.length >= parallelSearchConfig.targetComps) {
        jobLog(`   ℹ️  Found ${qualified.length} qualified comps (target: ${parallelSearchConfig.targetComps}), but continuing to gather all level data`);
      }

    } catch (error) {
      console.error(`❌ ON_LEVEL_READY ERROR for level ${result.level}:`, error);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      console.error(`   Context: dataVersion=${this.dataVersion}, seenComps=${seenComps.size}, pools=${pools.size}, rawComps=${result.rawComps.length}`);
    }
  }

  /**
   * Try progressive qualification passes
   */
  private async tryProgressivePasses(
    pools: Map<number, ComparableProperty[]>,
    seenComps: Map<string, ComparableProperty>,
    subject: SubjectProperty,
    availableLevels: number[],
    finalRun: boolean = false
  ): Promise<ComparableProperty[]> {
    const config = parallelSearchConfig;
    let bestResult: ComparableProperty[] = [];

    jobLog(`\n   🔄 ${finalRun ? '🏁 FINAL' : '⚡ EARLY'} Progressive Pass - dataVersion=${this.dataVersion}, seenComps=${seenComps.size}, availableLevels=[${availableLevels.join(',')}]`);

    // Try each pass in order (1 → 2 → 3 → 4)
    for (const passLevel of [1, 2, 3, 4]) {
      // Skip if we've already attempted this pass at the CURRENT dataVersion (unless final run)
      if (!finalRun && this.lastTriedVersion[passLevel] === this.dataVersion) {
        jobLog(`   ⏭️  Pass ${passLevel}: Skipping (already tried for dataVersion ${this.dataVersion})`);
        continue;
      }

      // Check if we have enough data for this pass
      if (!availableLevels.includes(passLevel)) {
        jobLog(`   ⏭️  Pass ${passLevel}: Skipping (level not available yet)`);
        continue;
      }

      // Mark this pass as tried for the current dataVersion (only in early runs)
      if (!finalRun) {
        this.lastTriedVersion[passLevel] = this.dataVersion;
        jobLog(`   🔍 Trying Pass ${passLevel} (dataVersion ${this.dataVersion})...`);
      } else {
        jobLog(`   🔍 Trying Pass ${passLevel} (FINAL RUN - ignoring history)...`);
      }

      jobLog(`\n🎯 TRYING PASS ${passLevel}:`);

      // Get comps up to this pass level
      const compsForPass = this.getCompsUpToLevel(seenComps, passLevel);
      jobLog(`   📊 ${compsForPass.length} comps available for pass ${passLevel}`);

      if (compsForPass.length === 0) {
        jobLog(`   ⏭️  Pass ${passLevel}: No comps available`);
        continue;
      }

      // Top-K selection
      let topCandidates;
      try {
        topCandidates = topK(
          compsForPass,
          config.topKPerPass,
          comp => scoreComparable(comp, subject)
        );
        jobLog(`   🔝 Selected top ${topCandidates.length} candidates for geocoding`);
      } catch (error) {
        console.error(`❌ [TOP_K_SELECTION] ERROR selecting top candidates:`);
        console.error(`   Error type: ${typeof error}`);
        console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
        console.error(`   Context: passLevel=${passLevel}, compsForPassCount=${compsForPass.length}, topKPerPass=${config.topKPerPass}`);
        // Fallback to all comps if top-K selection fails
        topCandidates = compsForPass.slice(0, config.topKPerPass);
        jobLog(`   ⚠️  Using fallback: first ${topCandidates.length} comps`);
      }

      // Geocode missing lat/lon
      try {
        await this.geocodeCandidates(topCandidates, subject);
      } catch (error) {
        console.error(`❌ [GEOCODING] ERROR geocoding candidates:`);
        console.error(`   Error type: ${typeof error}`);
        console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
        console.error(`   Context: passLevel=${passLevel}, candidatesCount=${topCandidates.length}`);
        // Continue execution - some comps may already have coordinates
      }

      // Apply pass-specific filters
      let qualified: ComparableProperty[];
      try {
        qualified = this.applyPassFilters(topCandidates, subject, passLevel);
      } catch (error) {
        console.error(`❌ [PASS_FILTERS] ERROR applying pass filters:`);
        console.error(`   Error type: ${typeof error}`);
        console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
        console.error(`   Context: passLevel=${passLevel}, candidatesCount=${topCandidates.length}, subject={beds:${subject.beds},baths:${subject.baths},sqft:${subject.sqft}}`);
        // Return empty array if filtering fails
        qualified = [];
      }

      qualified = this.orderDistinctByScore(qualified, subject);

      jobLog(`   ✅ Pass ${passLevel}: ${qualified.length} qualified comps`);

      // Track best result
      if (qualified.length > bestResult.length) {
        bestResult = qualified;
      }

      if (qualified.length >= config.targetComps) {
        jobLog(`   🎯 Target met! Returning ${qualified.length} comps from Pass ${passLevel}`);
        const result = qualified.slice(0, config.targetComps);
        jobLog(`   📍 Returning comps: ${result.map(c => `${c.address}($${c.price ? (c.price/1000).toFixed(0) : '?'}k)`).join(', ')}`);
        return result;
      }
    }

    // Return best pass result (not raw union)
    if (bestResult.length > 0) {
      bestResult = this.orderDistinctByScore(bestResult, subject);
      jobLog(`   📋 No pass met target (${config.targetComps}), returning best pass result: ${bestResult.length} comps`);
      jobLog(`   📍 Best result comps: ${bestResult.map(c => `${c.address}($${c.price ? (c.price/1000).toFixed(0) : '?'}k)`).join(', ')}`);
      return bestResult;
    }

    // Last resort: return all comps if no passes produced any results
    const final = this.orderDistinctByScore(this.getCompsUpToLevel(seenComps, 4), subject);
    jobLog(`   ⚠️  All passes failed, returning all ${final.length} comps as fallback`);
    jobLog(`   📍 Fallback comps: ${final.slice(0, 10).map(c => `${c.address}($${c.price ? (c.price/1000).toFixed(0) : '?'}k)`).join(', ')}${final.length > 10 ? '...' : ''}`);
    return final;
  }

  /**
   * Comparable searches resolve in arrival order and topK pops from a heap, so an unordered pool
   * made the target slice depend on API latency. One sale also arrives under several search
   * spellings ("Audubon Dr NE" vs "Audubon Dr"), and those duplicates consumed target slots,
   * handing the ARV fewer unique houses than it reported and dropping it onto the 3-comp path.
   */
  private orderDistinctByScore(
    comps: ComparableProperty[],
    subject: SubjectProperty
  ): ComparableProperty[] {
    const sorted = [...comps].sort((a, b) =>
      scoreComparable(b, subject) - scoreComparable(a, subject) ||
      (a.distanceMi ?? a.distance ?? 0) - (b.distanceMi ?? b.distance ?? 0) ||
      (a.address ?? '').localeCompare(b.address ?? '')
    );

    const distinct = new Map<string, ComparableProperty>();
    for (const comp of sorted) {
      const lng = (comp as any).lng ?? (comp as any).lon;
      const key = comp.lat && lng
        ? `coord:${Math.round(comp.lat * 1e6)},${Math.round(lng * 1e6)}`
        : `addr:${(comp.address || '').toLowerCase()}`;
      if (!distinct.has(key)) distinct.set(key, comp);
    }

    return Array.from(distinct.values());
  }

  /**
   * Execute search for a specific level
   */
  private async executeLevelSearch(
    level: number,
    subject: SubjectProperty,
    propertyType?: string
  ): Promise<SearchLevelResult> {
    const startTime = Date.now();

    try {
      jobLog(`🔍 LEVEL ${level} SEARCH STARTING...`);

      // Load cached comps from Redis (hybrid cache: junction + global comps)
      const redisCache = getRedisCache();
      const cachedRefs = await redisCache.getSubjectCompRefs(subject.address);

      let cachedComps: any[] = [];
      if (cachedRefs.length > 0) {
        jobLog(`   💾 Found ${cachedRefs.length} cached comp references`);

        // Load global comp data in parallel
        const compAddresses = cachedRefs.map(ref => ref.compAddress);
        const globalCompsMap = await redisCache.getGlobalComps(compAddresses);

        // Merge with subject-specific data (distance)
        // The subject's own record is not a comparable: left in, it pins ARV to
        // whatever the subject is listed or last sold at.
        cachedComps = cachedRefs
          .map(ref => {
            const globalData = globalCompsMap.get(ref.compAddress);
            if (globalData) {
              return {
                ...globalData,
                distanceMi: ref.distanceMi  // Subject-specific distance
              };
            }
            return null;
          })
          .filter((comp): comp is any => comp !== null && !isSamePropertyAddress(comp.address, subject.address));

        jobLog(`   💾 Loaded ${cachedComps.length}/${cachedRefs.length} cached comps from Redis`);
      }

      // Acquire semaphore tokens (if multi-worker)
      const tokensNeeded = 20; // Estimate for concurrent searches per level
      await redisSemaphore.acquire('vertex', tokensNeeded, { ttlMs: 120000 });

      try {
        // Define level-specific search criteria
        const criteria = this.getLevelCriteria(level, subject.subdivision != null);
        const levelPropertyType = criteria.relaxPropertyType ? undefined : propertyType;

        jobLog(`   Level ${level} criteria: ${criteria.radius}mi, ${criteria.timeWindow}mo, ${criteria.maxResults} max, propertyType=${levelPropertyType || 'RELAXED (dropped)'}`);

        // Execute search via bounded queue
        let result;
        try {
          result = await this.vertexQueue.run(async () => {
            return await this.compService.findComparables(
              subject.address,
              levelPropertyType,
              criteria.maxResults,
              criteria.radius,
              criteria.timeWindow,
              {
                sqft: subject.sqft || 0,
                beds: subject.beds || 0,
                baths: subject.baths || 0,
                yearBuilt: subject.yearBuilt || 0,
              },
              { subdivision: subject.subdivision }
            );
          }, this.abortController.signal);
        } catch (error) {
          console.error(`❌ [VERTEX_QUEUE] ERROR executing Vertex API call:`);
          console.error(`   Error type: ${typeof error}`);
          console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
          console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
          console.error(`   Context: level=${level}, address=${subject.address}, radius=${criteria.radius}, timeWindow=${criteria.timeWindow}, maxResults=${criteria.maxResults}`);
          throw error; // Re-throw to be caught by outer try-catch
        }

        const searchTime = Date.now() - startTime;

        jobLog(`✅ LEVEL ${level} SEARCH COMPLETE: ${result.comparables?.length || 0} comps in ${searchTime}ms`);

        const rawLiveComps = result.comparables || [];
        const subjectOnly = rawLiveComps.filter(c => isSamePropertyAddress(c.address, subject.address));
        // Filtered before both the merge and the cache write, so a hit on the subject's
        // own listing cannot get stored and replayed on the next run for this address.
        const liveComps = rawLiveComps.filter(c => !isSamePropertyAddress(c.address, subject.address));
        if (subjectOnly.length > 0) {
          jobLog(`🚫 [SUBJECT_SELF_COMP] Excluded ${subjectOnly.length} listing(s) of the subject itself at level ${level}: ${subjectOnly.map(c => c.address).join(' | ')}`);
        }

        // Merge cached comps with live search results
        const allComps = [...cachedComps, ...liveComps];

        // Deduplicate by address (prefer live comps over cached)
        const uniqueComps = new Map<string, any>();
        for (const comp of allComps) {
          const key = comp.address?.toLowerCase();
          if (key && !uniqueComps.has(key)) {
            uniqueComps.set(key, comp);
          }
        }
        const rawComps = Array.from(uniqueComps.values());

        jobLog(`   📦 Total comps: ${rawComps.length} (${liveComps.length} live + ${cachedComps.length} cached)`);

        // Update hybrid cache with new comps (fire-and-forget)
        if (liveComps.length > 0) {
          const redisCache = getRedisCache();

          // 1. Update global comp cache (canonical data)
          redisCache.setGlobalComps(liveComps).catch((err: unknown) => {
            console.error(`⚠️  Failed to update global comp cache for level ${level}:`, err);
          });

          // 2. Update subject-comp junction (references + distance)
          const compRefs = liveComps.map((comp: any) => ({
            compAddress: comp.address,
            distanceMi: comp.distanceMi || comp.distance || this.calculateDistance(subject, comp)
          }));

          redisCache.updateSubjectCompRefs(subject.address, compRefs).catch((err: unknown) => {
            console.error(`⚠️  Failed to update subject comp refs for level ${level}:`, err);
          });

          // 3. Populate geocode cache
          this.populateGeocodeCache(liveComps).catch((err: unknown) => {
            console.error(`⚠️  Failed to populate geocode cache for level ${level}:`, err);
          });
        }

        return {
          level,
          rawComps,
          searchTime,
          success: result.success
        };

      } finally {
        // Release semaphore tokens
        try {
          await redisSemaphore.release('vertex', tokensNeeded);
        } catch (error) {
          console.error(`❌ [SEMAPHORE_RELEASE] ERROR releasing Redis semaphore:`);
          console.error(`   Error type: ${typeof error}`);
          console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
          console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
          console.error(`   Context: level=${level}, tokensNeeded=${tokensNeeded}, resource=vertex`);
          // Don't throw - semaphore cleanup failure shouldn't prevent result return
        }
      }

    } catch (error) {
      const searchTime = Date.now() - startTime;
      console.error(`❌ LEVEL ${level} SEARCH ERROR after ${searchTime}ms:`, error);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);

      return {
        level,
        rawComps: [],
        searchTime,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get search criteria for a level
   */
  private getLevelCriteria(level: number, hasSubdivision: boolean) {
    // Property type is dropped as the search expands. A mislabeled subject type
    // otherwise restricts every level identically and can starve the pool to zero.
    const criteria = {
      1: { radius: 1.0, timeWindow: 12, maxResults: 30, relaxPropertyType: false },
      2: { radius: 2.0, timeWindow: 15, maxResults: 40, relaxPropertyType: false },
      3: { radius: 3.0, timeWindow: 18, maxResults: 50, relaxPropertyType: true },
      4: { radius: 4.0, timeWindow: 24, maxResults: 60, relaxPropertyType: true },
    };

    return criteria[level as keyof typeof criteria] || criteria[1];
  }

  /**
   * Populate Redis geocode cache from comps with lat/lon
   */
  private async populateGeocodeCache(comps: any[]): Promise<void> {
    let cached = 0;
    for (const comp of comps) {
      if (comp.address && comp.lat && comp.lon) {
        try {
          await geocodeCache.set(comp.address, comp.lat, comp.lon);
          cached++;
        } catch (error) {
          console.error(`❌ Failed to cache geocode for "${comp.address}":`, error);
        }
      }
    }
    if (cached > 0) {
      jobLog(`   💾 Cached ${cached} geocodes to Redis`);
    }
  }

  /**
   * Geocode candidates in parallel
   */
  private async geocodeCandidates(
    candidates: ComparableProperty[],
    subject: SubjectProperty
  ): Promise<void> {
    // Filter for comps that need geocoding - check for truly valid coordinates
    // This catches: missing fields, null, undefined, 0, and non-numeric values
    const isValidCoordinate = (val: any): boolean => {
      return typeof val === 'number' && val !== 0 && !isNaN(val);
    };

    const toGeocode = candidates.filter(c => !isValidCoordinate(c.lat) || !isValidCoordinate(c.lon));

    if (toGeocode.length === 0) {
      jobLog(`   ✅ All candidates already have coordinates`);
      return;
    }

    jobLog(`   🗺️  Geocoding ${toGeocode.length} candidates...`);

    const geocodeTasks = toGeocode.map(comp => async () => {
      try {
        // Check cache first
        const cached = await geocodeCache.get(comp.address);
        if (cached) {
          comp.lat = cached.lat;
          comp.lon = cached.lon;
          comp.distanceMi = this.calculateDistance(subject, comp);
          return;
        }

        // Geocode via Google Maps API
        // maxAttempts=1 is deliberate: a refusal here drops the comp at the caller, so
        // retrying would re-admit comps that fail today and change the ARV.
        const result = await this.geocoder.geocodeAddress(comp.address, 1);
        if (result) {
          comp.lat = result.lat;
          // The geocoder returns `lng`; reading `lon` stored undefined, which broke distance
          // scoring and left coordinate dedup unreachable for freshly geocoded comps.
          comp.lon = result.lng;
          comp.distanceMi = this.calculateDistance(subject, comp);
        } else {
          jobLog(`   ⚠️  Could not geocode: ${comp.address}`);
        }

      } catch (error) {
        console.error(`❌ GEOCODE ERROR for "${comp.address}":`, error);
      }
    });

    await this.geocodeQueue.runMany(geocodeTasks, this.abortController.signal);
    jobLog(`   ✅ Geocoding complete`);
  }

  /**
   * Calculate distance between subject and comp
   */
  private calculateDistance(subject: SubjectProperty, comp: ComparableProperty): number {
    if (!subject.lat || !subject.lon || !comp.lat || !comp.lon) {
      return 999; // Unknown distance
    }

    // Haversine formula
    const R = 3959; // Earth radius in miles
    const dLat = this.toRad(comp.lat - subject.lat);
    const dLon = this.toRad(comp.lon - subject.lon);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(subject.lat)) * Math.cos(this.toRad(comp.lat)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Apply pass-specific filters
   */
  private applyPassFilters(
    candidates: ComparableProperty[],
    subject: SubjectProperty,
    passLevel: number
  ): ComparableProperty[] {
    // Define pass criteria
    const passCriteria = {
      1: { maxDistance: 1.0, bedsTolerance: 0, bathsTolerance: 0, sqftTolerance: 0.15 },
      2: { maxDistance: 2.0, bedsTolerance: 1, bathsTolerance: 0.5, sqftTolerance: 0.20 },
      3: { maxDistance: 3.0, bedsTolerance: 1, bathsTolerance: 1, sqftTolerance: 0.25 },
      4: { maxDistance: 4.0, bedsTolerance: 2, bathsTolerance: 1, sqftTolerance: 0.30 },
    };

    const criteria = passCriteria[passLevel as keyof typeof passCriteria];

    jobLog(`\n🔍 PASS ${passLevel} FILTER DIAGNOSTICS`);
    jobLog(`   Subject specs: ${subject.beds} beds, ${subject.baths} baths, ${subject.sqft} sqft`);
    jobLog(`   Criteria: maxDist=${criteria.maxDistance}mi, beds±${criteria.bedsTolerance}, baths±${criteria.bathsTolerance}, sqft±${criteria.sqftTolerance * 100}%`);
    jobLog(`   Filtering ${candidates.length} candidates...\n`);

    let passCount = 0;
    let failCount = 0;

    const filtered = candidates.filter(comp => {
      const reasons: string[] = [];

      // Distance filter
      const distanceToCheck = comp.distanceMi || (comp as any).distance;
      if (distanceToCheck && distanceToCheck > criteria.maxDistance) {
        reasons.push(`distance=${distanceToCheck.toFixed(2)}mi > ${criteria.maxDistance}mi`);
        failCount++;
        jobLog(`   ❌ ${comp.address}: ${reasons.join(', ')}`);
        return false;
      }

      // Bedroom filter
      if (subject.beds && comp.beds) {
        const bedDiff = Math.abs(comp.beds - subject.beds);
        if (bedDiff > criteria.bedsTolerance) {
          reasons.push(`beds=${comp.beds} (diff=${bedDiff} > tol=${criteria.bedsTolerance})`);
          failCount++;
          jobLog(`   ❌ ${comp.address}: ${reasons.join(', ')}`);
          return false;
        }
      }

      // Bathroom filter
      if (subject.baths && comp.baths) {
        const bathDiff = Math.abs(comp.baths - subject.baths);
        if (bathDiff > criteria.bathsTolerance) {
          reasons.push(`baths=${comp.baths} (diff=${bathDiff} > tol=${criteria.bathsTolerance})`);
          failCount++;
          jobLog(`   ❌ ${comp.address}: ${reasons.join(', ')}`);
          return false;
        }
      }

      // Sqft filter
      if (subject.sqft && comp.sqft) {
        const diff = Math.abs(comp.sqft - subject.sqft);
        const pct = diff / subject.sqft;
        if (pct > criteria.sqftTolerance) {
          reasons.push(`sqft=${comp.sqft} (diff=${pct.toFixed(1)}% > ${criteria.sqftTolerance * 100}%)`);
          failCount++;
          jobLog(`   ❌ ${comp.address}: ${reasons.join(', ')}`);
          return false;
        }
      }

      passCount++;
      jobLog(`   ✅ ${comp.address}: PASS (${comp.beds}bd/${comp.baths}ba/${comp.sqft}sf, ${distanceToCheck?.toFixed(2) || 'N/A'}mi)`);
      return true;
    });

    jobLog(`\n📊 Pass ${passLevel} results: ${passCount} passed, ${failCount} rejected\n`);
    return filtered;
  }

  /**
   * Get comps up to a specific level
   */
  private getCompsUpToLevel(seenComps: Map<string, ComparableProperty>, level: number): ComparableProperty[] {
    // Return all comps (filtering happens in applyPassFilters)
    return Array.from(seenComps.values());
  }
}
