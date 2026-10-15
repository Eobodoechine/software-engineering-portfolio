// Comprehensive Comparable Search V3 - V2 with Dual ARV Analysis
// Same as V2 but with dual ARV calculation: baseline + 2-bathroom upgrade scenarios

import { VertexComparableSearchService } from './step3-find-comparables';
import { ARVCalculationService } from './step4-arv-calculation';
import { fetchPropertyDetailsViaVertex, type BasicDetails } from './vertex-details';
import { PropertyDataNormalizer } from './utils/propertyDataNormalizer';
import { VertexDeduplicator } from './utils/vertexDeduplicator';
import { ProgressiveSearchStrategy } from './utils/progressiveSearchStrategy';
import { jobLog } from './utils/jobLogger';
import { withVertexLimiter } from './vertex-limiter';

interface ComprehensiveSearchResultV3 {
  subject: SubjectSummary;
  all_comps: any[];
  qualified_comps: any[];
  consistency_scores: Map<string, number>;
  renovation_analysis: {
    likely_renovated: any[];
    likely_unrenovated: any[];
    market_average: any[];
  };
  // DUAL ARV - Key difference from V2
  arv?: {
    method: string;
    estimate: number;
    confidence: 'high' | 'medium' | 'low';
    dataPoints: number;
  };
  twoBathARV?: {
    method: string;
    estimate: number;
    confidence: 'high' | 'medium' | 'low';
    dataPoints: number;
    valueAdd: number;
    valueAddPercent: number;
    roiEstimate?: number;
  };
  bathroomAnalysis: {
    subjectBaths: number;
    recommendAction: 'hold' | 'renovate' | 'sell_as_is';
    baselineCompsUsed: number;
    upgradeCompsUsed?: number;
  };
  searchMetadata: {
    version: string;
    strategy: 'progressive_expansion';
    searchLevels: number;
    totalSearchTime: number;
    qualityScore: 'excellent' | 'good' | 'fair' | 'poor';
    cacheHits: number;
    normalizationSummary: any;
    deduplicationSummary: any;
    distanceValidationSummary: any;
  };
}

type SubjectSummary = Pick<BasicDetails,
  'address' | 'sqft' | 'beds' | 'baths' | 'yearBuilt' | 'lotSize' | 'subdivision' | 'success'
>;

export class ComprehensiveComparableSearchV3 {
  private compService: VertexComparableSearchService;
  private arvService: ARVCalculationService;
  private normalizer: PropertyDataNormalizer;
  private deduplicator: VertexDeduplicator;
  private progressiveSearch: ProgressiveSearchStrategy;
  private currentJobId: string = 'unknown'; // Track jobId for private methods
  constructor() {
    this.compService = new VertexComparableSearchService();
    this.arvService = new ARVCalculationService();
    this.normalizer = new PropertyDataNormalizer();
    this.deduplicator = new VertexDeduplicator();
    this.progressiveSearch = new ProgressiveSearchStrategy();
  }

  async findComparables(address: string, jobId?: string): Promise<ComprehensiveSearchResultV3> {
    const effectiveJobId = jobId || address; // Use provided jobId or fallback to address
    this.currentJobId = effectiveJobId; // Store for use in private methods
    const startTime = Date.now();
    jobLog(`\n🔍 COMPREHENSIVE COMPARABLE SEARCH V3`);
    jobLog(`============================================================`);
    jobLog(`📍 Analyzing: ${address}`);
    jobLog(`📋 Job ID: ${effectiveJobId}`);

    try {
      // Step 1: Get subject property details
      jobLog(`\n📋 Step 1: Subject Property Research`);
      const subjectDetails = await fetchPropertyDetailsViaVertex(address, { jobId: effectiveJobId });

      if (!subjectDetails) {
        throw new Error('Could not fetch subject property details');
      }

      jobLog(`   ✅ Subject: ${subjectDetails.beds}BR/${subjectDetails.baths}BA, ${subjectDetails.sqft}sqft, Built ${subjectDetails.yearBuilt}`);
      if (subjectDetails.subdivision) {
        jobLog(`   🏘️  Subdivision: ${subjectDetails.subdivision}`);
      }

      // Step 2: Progressive comparable search
      jobLog(`\n🔍 Step 2: Progressive Comparable Search`);

      // Determine subject property type for filtering
      const subjectPropertyType = subjectDetails.propertyType || undefined;
      jobLog(`   🏠 Property Type: ${subjectPropertyType || 'Not specified - will match similar properties'}`);
      jobLog(`   🔍 DEBUG: subjectPropertyType exact value = "${subjectPropertyType}" (type: ${typeof subjectPropertyType})`);

      let allComps: any[] = [];
      let searchLevel = 0;
      const maxSearchLevels = 3;

      // Use progressive search strategy with subject details
      if (subjectDetails.beds && subjectDetails.baths && subjectDetails.sqft && subjectDetails.yearBuilt) {
        jobLog(`   📐 Using subject details for targeted search`);
        // Set subdivision in environment for progressive search
        if (subjectDetails.subdivision) {
          process.env.SUBDIVISION = subjectDetails.subdivision;
          jobLog(`   🏘️  Using subdivision: ${subjectDetails.subdivision}`);
        }

        const progressiveResult = await this.progressiveSearch.executeProgressiveSearch(
          address,
          subjectDetails,
          this.compService,
          subjectDetails.subdivision,
          subjectPropertyType
        );
        allComps = progressiveResult.finalProperties;
      } else {
        jobLog(`   ⚠️  Subject details incomplete; using progressive search without strict filters.`);
        // Fallback to basic progressive search
        for (searchLevel = 0; searchLevel < maxSearchLevels; searchLevel++) {
          const radius = 1.5 + (searchLevel * 0.5); // 1.5, 2.0, 2.5 miles
          const timeWindow = 12 + (searchLevel * 6); // 12, 18, 24 months
          const maxResults = 15 + (searchLevel * 5); // 15, 20, 25 results

          jobLog(`   🎯 Search Level ${searchLevel + 1}: ${radius}mi radius, ${timeWindow}mo window, max ${maxResults} results`);

          const result = await this.compService.findComparables(
            address,
            subjectPropertyType, // propertyType - match subject property type
            maxResults,
            radius,
            timeWindow,
            subjectDetails
          );

          if (result.success && result.comparables.length > 0) {
            allComps.push(...result.comparables);
            jobLog(`      ➕ Found ${result.comparables.length} comps at level ${searchLevel + 1}`);
          }

          // Stop if we have enough comparables
          if (allComps.length >= 10) {
            jobLog(`      ✅ Sufficient comparables found (${allComps.length}), stopping search`);
            break;
          }
        }
      }

      jobLog(`   📊 Total raw comparables found: ${allComps.length}`);

      if (allComps.length === 0) {
        throw new Error('No comparables found in progressive search');
      }

      // Step 3: Data normalization
      jobLog(`\n🔧 Step 3: Data Normalization`);
      const normalizationResult = this.normalizer.processProperties(allComps);
      const normalizedComps = normalizationResult.normalized;
      const normalizationSummary = normalizationResult.summary;
      jobLog(`   ✅ Normalized: ${normalizedComps.length}/${allComps.length} properties improved`);

      // Step 4: Vertex AI deduplication
      jobLog(`\n🤖 Step 4: Vertex AI Deduplication`);
      const deduplicationResult = await this.deduplicator.deduplicateProperties(normalizedComps);
      const deduplicatedComps = deduplicationResult.uniqueProperties;
      const deduplicationSummary = { duplicatesRemoved: deduplicationResult.duplicatesRemoved, mergedGroups: deduplicationResult.mergedGroups };
      jobLog(`   ✅ Deduplicated: ${deduplicatedComps.length} unique (removed ${deduplicationResult.duplicatesRemoved} duplicates)`);

      // Step 5: Distance validation with coordinate-based filtering
      jobLog(`\n📏 Step 5: Distance Validation`);

      // Get subject coordinates from the compService
      const subjectCoords = await this.getSubjectCoordinates(address);
      if (!subjectCoords) {
        throw new Error('Failed to get subject property coordinates');
      }
      jobLog(`   📍 Subject coordinates: ${subjectCoords.lat}, ${subjectCoords.lon}`);

      // Extract coordinates for filtered comparables and calculate distances
      const distanceValidationResult = await this.validateDistances(deduplicatedComps, subjectCoords, 2.0);
      const distanceValidatedComps = distanceValidationResult.validated;
      const distanceValidationSummary = {
        validated: distanceValidatedComps.length,
        rejected: distanceValidationResult.rejected.length
      };
      jobLog(`   ✅ Distance validated: ${distanceValidatedComps.length}/${deduplicatedComps.length} within 2 miles (rejected ${distanceValidationResult.rejected.length})`);

      // Step 6: High-tier property selection based on PPSF analysis
      jobLog(`\n🎯 Step 6: High-Tier Property Selection`);
      const highTierResult = this.selectHighTierProperties(distanceValidatedComps);
      const qualifiedComps = highTierResult.selectedComps;

      jobLog(`   ✅ High-tier selection: ${qualifiedComps.length}/${distanceValidatedComps.length} properties selected`);
      if (highTierResult.droppedHighNoSupport.length > 0) {
        jobLog(`   📊 Dropped high-tier (no support): ${highTierResult.droppedHighNoSupport.length} properties`);
      }

      // Log detailed analysis
      highTierResult.analysisLog.forEach(logLine => {
        jobLog(`   ${logLine}`);
      });

      // Step 7: Renovation analysis
      jobLog(`\n🔨 Step 7: Renovation Analysis`);
      const renovationAnalysis = this.analyzeRenovationLevels(qualifiedComps);

      // Step 8: Bathroom Analysis and Dual ARV Calculation
      jobLog(`\n🚿 Step 8: Bathroom Analysis & Dual ARV Calculation`);
      const subjectBaths = this.computeSubjectBathrooms(subjectDetails);
      jobLog(`   🏠 Subject Bathrooms: ${subjectBaths}`);

      // BASELINE ARV (same as V2)
      let arvResult = undefined;
      let twoBathARV = undefined;
      let bathroomAnalysis: {
        subjectBaths: number;
        recommendAction: 'hold' | 'renovate' | 'sell_as_is';
        baselineCompsUsed: number;
        upgradeCompsUsed?: number;
      } = {
        subjectBaths,
        recommendAction: 'sell_as_is',
        baselineCompsUsed: 0
      };

      if (qualifiedComps.length >= 3 && subjectDetails.sqft) {
        // Baseline ARV calculation
        const baselineComps = this.filterComparablesForBaseline(qualifiedComps, subjectBaths, subjectDetails);
        jobLog(`   📊 Baseline comps (≤${subjectBaths} baths): ${baselineComps.length}`);

        if (baselineComps.length >= 3) {
          // Apply market-based bathroom adjustments to comparables
          const adjustedComps = this.applyMarketBathroomAdjustments(baselineComps, subjectBaths);
          const baselineARV = this.arvService.calculateARV(adjustedComps, subjectDetails.sqft);
          arvResult = {
            method: 'comprehensive_v3_baseline',
            estimate: baselineARV.arv,
            confidence: baselineARV.confidence,
            dataPoints: baselineComps.length
          };
          bathroomAnalysis.baselineCompsUsed = baselineComps.length;
          jobLog(`   ✅ Baseline ARV: $${arvResult.estimate.toLocaleString()} (${arvResult.confidence} confidence, ${arvResult.dataPoints} comps)`);
        }

        // TWO-BATHROOM ARV (only if subject has < 2 baths AND we have sufficient baseline comps)
        if (subjectBaths < 2 && arvResult) {
          jobLog(`   🛁 Calculating 2-bathroom upgrade scenario...`);
          const twoBathComps = this.filterComparablesForTwoBath(qualifiedComps, subjectDetails);
          jobLog(`   📊 Upgrade comps (2+ baths): ${twoBathComps.length}`);

          if (twoBathComps.length >= 3 && baselineComps.length >= 3) {
            const upgradeARV = this.arvService.calculateARV(twoBathComps, subjectDetails.sqft);
            const baselineEstimate = arvResult ? arvResult.estimate : upgradeARV.arv * 0.85; // Fallback if no baseline
            const valueAdd = upgradeARV.arv - baselineEstimate;
            const valueAddPercent = (valueAdd / baselineEstimate) * 100;

            // ROI Calculation
            const estimatedRenovationCost = 12000;
            const netGain = valueAdd - estimatedRenovationCost;
            const roi = (netGain / estimatedRenovationCost) * 100;

            twoBathARV = {
              method: 'comprehensive_v3_upgrade',
              estimate: upgradeARV.arv,
              confidence: upgradeARV.confidence,
              dataPoints: twoBathComps.length,
              valueAdd,
              valueAddPercent,
              roiEstimate: roi
            };

            bathroomAnalysis.upgradeCompsUsed = twoBathComps.length;
            bathroomAnalysis.recommendAction = this.generateRecommendation(
              arvResult.estimate,
              upgradeARV.arv,
              arvResult.confidence
            );

            jobLog(`   ✅ 2-Bath ARV: $${twoBathARV.estimate.toLocaleString()} (${twoBathARV.confidence} confidence, ${twoBathARV.dataPoints} comps)`);
            jobLog(`   💰 Value Add: $${valueAdd.toLocaleString()} (${valueAddPercent.toFixed(1)}%)`);
            jobLog(`   📈 ROI Estimate: ${roi.toFixed(1)}%`);
          } else {
            jobLog(`   ⚠️  Insufficient comps for dual ARV analysis:`);
            jobLog(`       • Baseline comps (≤${subjectBaths} baths): ${baselineComps.length}/3 needed`);
            jobLog(`       • Upgrade comps (2+ baths): ${twoBathComps.length}/3 needed`);
          }
        } else {
          jobLog(`   ℹ️  Subject has ${subjectBaths} bathrooms - no upgrade scenario needed`);
        }
      } else {
        jobLog(`   ⚠️  Insufficient data for reliable ARV calculation (need ≥3 comps, have ${qualifiedComps.length})`);
      }

      jobLog(`   🎯 Recommendation: ${bathroomAnalysis.recommendAction.toUpperCase().replace('_', ' ')}`);

      // Calculate quality score based on count and distance only
      const qualityScore = this.assessOverallQuality(qualifiedComps.length);
      const totalSearchTime = Date.now() - startTime;

      jobLog(`\n📊 COMPREHENSIVE SEARCH V3 COMPLETE`);
      jobLog(`   Quality Score: ${qualityScore}`);
      jobLog(`   Total Time: ${totalSearchTime}ms`);
      jobLog(`   Final Comps: ${qualifiedComps.length}`);
      jobLog(`============================================================\n`);

      const subjectSummary = this.buildSubjectSummary(address, subjectDetails);

      return {
        subject: subjectSummary,
        all_comps: allComps,
        qualified_comps: qualifiedComps,
        consistency_scores: new Map(), // Empty map since we removed quality filtering
        renovation_analysis: renovationAnalysis,
        arv: arvResult,
        twoBathARV,
        bathroomAnalysis,
        searchMetadata: {
          version: 'v3.0',
          strategy: 'progressive_expansion',
          searchLevels: searchLevel + 1,
          totalSearchTime,
          qualityScore,
          cacheHits: 0, // Could be implemented
          normalizationSummary,
          deduplicationSummary,
          distanceValidationSummary
        }
      };

    } catch (error: any) {
      console.error(`   ❌ Comprehensive search failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enhanced bathroom computation derived from legacy CLI tooling
   */
  private computeSubjectBathrooms(subjectDetails: any): number {
    // Direct baths field from subjectDetails (already parsed)
    const directBaths = Number(subjectDetails.baths);
    if (Number.isFinite(directBaths) && directBaths > 0) {
      return directBaths;
    }

    // Fallback: try description if available
    if (subjectDetails?.description) {
      const desc = subjectDetails.description;
      const descBaths = Number(desc.baths);
      if (Number.isFinite(descBaths) && descBaths > 0) {
        return descBaths;
      }

      // Calculated approach (full + half baths)
      const fullCalc = Number(desc.baths_full_calc) || 0;
      const halfCalc = Number(desc.baths_partial_calc) || 0;
      const full = Number(desc.baths_full) || 0;
      const half = Number(desc.baths_half) || 0;

      let total = 0;
      total += (fullCalc || full);
      total += 0.5 * (halfCalc || half);

      if (total > 0) return total;
    }

    return 1; // Default fallback
  }

  /**
   * BASELINE filtering - Allow bathroom differences with market-based adjustments
   */
  private filterComparablesForBaseline(comps: any[], subjectBaths: number, subjectDetails?: any): any[] {
    const epsilon = 1e-9; // Float comparison tolerance

    return comps.filter(comp => {
      const compBaths = parseFloat(comp.baths?.toString() || 'NaN');

      // Must have valid bathroom count
      if (!Number.isFinite(compBaths)) return false;

      // Allow bathroom differences up to ±1 (relaxed from conservative ≤ subject)
      const bathDiff = Math.abs(compBaths - subjectBaths);
      if (bathDiff > 1.0 + epsilon) return false;

      // Additional quality filters
      if (!Number.isFinite(comp.price) || !Number.isFinite(comp.sqft)) return false;
      if (comp.price <= 0 || comp.sqft <= 0) return false;

      // MISSING FILTERS ADDED:

      // Size compatibility (±20% from subject) - CRITICAL MISSING CHECK
      if (subjectDetails?.sqft) {
        const sizeVariance = Math.abs(comp.sqft - subjectDetails.sqft) / subjectDetails.sqft;
        if (sizeVariance > 0.20) return false;
      }

      // Bedroom filtering (±1 bedroom)
      if (subjectDetails?.beds && Number.isFinite(comp.beds)) {
        const bedroomDiff = Math.abs(comp.beds - subjectDetails.beds);
        if (bedroomDiff > 1) return false;
      }

      // Year built filtering (adjacent age groups only)
      if (subjectDetails?.yearBuilt && Number.isFinite(comp.yearBuilt)) {
        const subjectAgeGroup = this.getAgeGroup(subjectDetails.yearBuilt);
        const compAgeGroup = this.getAgeGroup(comp.yearBuilt);
        if (!this.isAdjacentAgeGroup(subjectAgeGroup, compAgeGroup)) return false;
      }

      return true;
    });
  }

  /**
   * TWO-BATHROOM filtering - Upgrade scenario using 2+ bathroom comps
   */
  private filterComparablesForTwoBath(comps: any[], subjectDetails: any): any[] {
    return comps.filter(comp => {
      const compBaths = parseFloat(comp.baths?.toString() || 'NaN');

      // Must have 2-3 bathrooms for upgrade scenario
      if (!Number.isFinite(compBaths) || compBaths < 2 || compBaths > 3) return false;

      // Quality filters
      if (!Number.isFinite(comp.price) || !Number.isFinite(comp.sqft)) return false;
      if (comp.price <= 0 || comp.sqft <= 0) return false;

      // Size compatibility (±20% from subject) - CRITICAL FILTER
      if (subjectDetails?.sqft) {
        const sizeVariance = Math.abs(comp.sqft - subjectDetails.sqft) / subjectDetails.sqft;
        if (sizeVariance > 0.20) return false;
      }

      // Bedroom filtering (±1 bedroom) - CRITICAL FILTER
      if (subjectDetails?.beds && Number.isFinite(comp.beds)) {
        const bedroomDiff = Math.abs(comp.beds - subjectDetails.beds);
        if (bedroomDiff > 1) return false;
      }

      // Year built filtering (adjacent age groups only) - CRITICAL FILTER
      if (subjectDetails?.yearBuilt && Number.isFinite(comp.yearBuilt)) {
        const subjectAgeGroup = this.getAgeGroup(subjectDetails.yearBuilt);
        const compAgeGroup = this.getAgeGroup(comp.yearBuilt);
        if (!this.isAdjacentAgeGroup(subjectAgeGroup, compAgeGroup)) return false;
      }

      return true;
    });
  }

  /**
   * Apply market-based bathroom adjustments to comparables
   */
  private applyMarketBathroomAdjustments(comps: any[], subjectBaths: number): any[] {
    // Group comparables by bathroom count to analyze market premiums
    const bathGroups = new Map<number, any[]>();
    comps.forEach(comp => {
      const compBaths = parseFloat(comp.baths?.toString() || '0');
      if (!bathGroups.has(compBaths)) {
        bathGroups.set(compBaths, []);
      }
      bathGroups.get(compBaths)!.push(comp);
    });

    // Calculate average PPSF for each bathroom group
    const bathPremiums = new Map<number, number>();
    bathGroups.forEach((groupComps, bathCount) => {
      const avgPpsf = groupComps.reduce((sum, comp) => sum + (comp.price / comp.sqft), 0) / groupComps.length;
      bathPremiums.set(bathCount, avgPpsf);
    });

    // Calculate market-based adjustment per bathroom difference
    let bathroomAdjustmentPerSqft = 0;
    if (bathPremiums.size >= 2) {
      // Use linear regression to estimate bathroom premium per sqft
      const bathCounts = Array.from(bathPremiums.keys()).sort((a, b) => a - b);
      const ppsfValues = bathCounts.map(count => bathPremiums.get(count)!);

      if (bathCounts.length >= 2) {
        // Simple slope calculation between min and max bathroom counts
        const minIdx = 0;
        const maxIdx = bathCounts.length - 1;
        const bathDiff = bathCounts[maxIdx] - bathCounts[minIdx];
        const ppsfDiff = ppsfValues[maxIdx] - ppsfValues[minIdx];

        if (bathDiff > 0) {
          bathroomAdjustmentPerSqft = ppsfDiff / bathDiff;
        }
      }
    }

    jobLog(`   🛁 Market bathroom adjustment: $${bathroomAdjustmentPerSqft.toFixed(2)}/sqft per bathroom difference`);

    // Apply adjustments to each comparable
    return comps.map(comp => {
      const compBaths = parseFloat(comp.baths?.toString() || '0');
      const bathDiff = compBaths - subjectBaths;

      if (Math.abs(bathDiff) < 1e-9) {
        // No adjustment needed for exact bathroom match
        return { ...comp };
      }

      // Calculate adjustment based on market analysis
      const adjustment = -bathDiff * bathroomAdjustmentPerSqft * comp.sqft;
      const adjustedPrice = comp.price + adjustment;

      jobLog(`      ${comp.address}: ${compBaths} baths → ${subjectBaths} baths (${bathDiff > 0 ? '-' : '+'}$${Math.abs(adjustment).toLocaleString()})`);

      return {
        ...comp,
        price: Math.max(adjustedPrice, comp.price * 0.5), // Floor at 50% of original price
        originalPrice: comp.price,
        bathroomAdjustment: adjustment
      };
    });
  }

  /**
   * Age group classification for year built filtering
   */
  private getAgeGroup(yearBuilt: number): string {
    if (yearBuilt >= 2020) return '2020+';
    if (yearBuilt >= 2016) return '2016-2019';
    if (yearBuilt >= 2010) return '2010-2015';
    if (yearBuilt >= 2000) return '2000-2009';
    if (yearBuilt >= 1980) return '1980-1999';
    if (yearBuilt >= 1960) return '1960-1979';
    if (yearBuilt >= 1940) return '1940-1959';
    return 'Pre-1940';
  }

  /**
   * Check if two age groups are adjacent (same or neighboring groups)
   */
  private isAdjacentAgeGroup(group1: string, group2: string): boolean {
    const groups = ['Pre-1940', '1940-1959', '1960-1979', '1980-1999', '2000-2009', '2010-2015', '2016-2019', '2020+'];
    const index1 = groups.indexOf(group1);
    const index2 = groups.indexOf(group2);
    return Math.abs(index1 - index2) <= 1; // Same group or adjacent
  }

  /**
   * Generate renovation recommendation based on analysis
   */
  private generateRecommendation(
    baselineARV: number,
    twoBathARV?: number,
    confidence?: 'high' | 'medium' | 'low'
  ): 'hold' | 'renovate' | 'sell_as_is' {

    if (!twoBathARV) return 'sell_as_is'; // No upgrade scenario available

    const valueAdd = twoBathARV - baselineARV;
    const estimatedRenovationCost = 12000; // Typical bathroom addition cost
    const netGain = valueAdd - estimatedRenovationCost;
    const roi = (netGain / estimatedRenovationCost) * 100;

    // Decision logic
    if (confidence === 'high' && roi > 25) return 'renovate';
    if (confidence === 'medium' && roi > 40) return 'renovate';
    if (confidence === 'low' && roi > 60) return 'renovate';

    if (baselineARV > 200000) return 'hold'; // Good value, hold for appreciation
    return 'sell_as_is';
  }


  private analyzeRenovationLevels(properties: any[]): {
    likely_renovated: any[];
    likely_unrenovated: any[];
    market_average: any[];
  } {
    const ppsf = properties
      .map(p => p.price / p.sqft)
      .filter(p => !isNaN(p) && p > 0);

    if (ppsf.length === 0) {
      return {
        likely_renovated: [],
        likely_unrenovated: [],
        market_average: properties
      };
    }

    // Calculate median PPSF
    const sortedPpsf = ppsf.sort((a, b) => a - b);
    const medianPpsf = sortedPpsf[Math.floor(sortedPpsf.length / 2)];
    const threshold = medianPpsf * 1.075; // 7.5% above median

    const likely_renovated = properties.filter(p => {
      const propPpsf = p.price / p.sqft;
      return propPpsf >= threshold;
    });

    const likely_unrenovated = properties.filter(p => {
      const propPpsf = p.price / p.sqft;
      return propPpsf < threshold * 0.9; // Below 90% of threshold
    });

    const market_average = properties.filter(p => {
      const propPpsf = p.price / p.sqft;
      return propPpsf >= threshold * 0.9 && propPpsf < threshold;
    });

    jobLog(`   🔧 Renovation analysis:`);
    jobLog(`      Likely renovated: ${likely_renovated.length} (≥$${threshold.toFixed(2)}/sqft)`);
    jobLog(`      Market average: ${market_average.length}`);
    jobLog(`      Likely unrenovated: ${likely_unrenovated.length}`);

    return {
      likely_renovated,
      likely_unrenovated,
      market_average
    };
  }

  private assessOverallQuality(compCount: number): 'excellent' | 'good' | 'fair' | 'poor' {
    // Simplified quality assessment based on comparable count only
    if (compCount >= 8) return 'excellent';
    if (compCount >= 5) return 'good';
    if (compCount >= 3) return 'fair';
    return 'poor';
  }

  /**
   * High-tier property selection based on PPSF analysis and clustering validation
   */
  private selectHighTierProperties(properties: any[]): {
    selectedComps: any[];
    droppedHighNoSupport: any[];
    analysisLog: string[];
  } {
    const log: string[] = [];

    if (properties.length === 0) {
      return { selectedComps: [], droppedHighNoSupport: [], analysisLog: ['No properties to analyze'] };
    }

    log.push(`🎯 High-tier selection starting with ${properties.length} properties`);

    // Step 1: Compute PPSF for each comp
    const ppsfData = properties.map(comp => {
      const sqft = comp.sqft >= 1 ? comp.sqft : 1; // Guard against sqft < 1
      return {
        comp,
        ppsf: comp.price / sqft,
        price: comp.price
      };
    }).filter(item => item.ppsf > 0); // Skip invalid PPSF

    if (ppsfData.length === 0) {
      log.push('❌ No valid PPSF data available');
      return { selectedComps: [], droppedHighNoSupport: [], analysisLog: log };
    }

    log.push(`📊 PPSF calculated for ${ppsfData.length} properties`);

    // Step 2: Robust z-score on PPSF (MAD-based)
    const ppsfValues = ppsfData.map(item => item.ppsf).sort((a, b) => a - b);
    const median = this.calculateMedian(ppsfValues);

    // Calculate MAD
    const deviations = ppsfData.map(item => Math.abs(item.ppsf - median));
    const mad = this.calculateMedian(deviations.sort((a, b) => a - b));

    log.push(`📈 Median PPSF: $${median.toFixed(2)}, MAD: ${mad.toFixed(6)}`);

    // Calculate z-scores
    const dataWithZ = ppsfData.map(item => {
      let zScore: number;

      if (mad > 0) {
        // Standard MAD-based z-score
        zScore = 0.6745 * (item.ppsf - median) / mad;
      } else {
        // MAD = 0 fallback: use IQR scaling
        const q1 = this.calculatePercentile(ppsfValues, 25);
        const q3 = this.calculatePercentile(ppsfValues, 75);
        const iqr = q3 - q1;
        const scale = Math.max(1e-9, iqr / 1.349);
        zScore = 0.6745 * (item.ppsf - median) / scale;

        if (mad === 0) {
          log.push(`🔄 MAD = 0, using IQR fallback: IQR=${iqr.toFixed(6)}, scale=${scale.toFixed(9)}`);
        }
      }

      return { ...item, zScore };
    });

    // Step 3: High-tier candidates (z ≥ 1.0)
    const highTierCandidates = dataWithZ.filter(item => item.zScore >= 1.0);
    log.push(`🎯 High-tier candidates (z ≥ 1.0): ${highTierCandidates.length}/${dataWithZ.length}`);

    if (highTierCandidates.length === 0) {
      log.push('🔄 No high-tier candidates found, triggering Pair-High Fallback');
      return this.pairHighFallback(dataWithZ, log);
    }

    // Step 4: Support requirement (cluster ≥ 1 other high candidate)
    const supportedHighTier: typeof highTierCandidates = [];
    const droppedHighNoSupport: typeof highTierCandidates = [];

    for (const candidate of highTierCandidates) {
      let hasSupport = false;

      for (const other of highTierCandidates) {
        if (candidate === other) continue;

        // Check PPSF-close: |z_i - z_j| ≤ 0.5
        const zDiff = Math.abs(candidate.zScore - other.zScore);
        const ppsfClose = zDiff <= 0.5;

        // Check Price-close: |price_i - price_j| / min(price_i, price_j) ≤ 0.075
        const priceDiff = Math.abs(candidate.price - other.price);
        const minPrice = Math.min(candidate.price, other.price);
        const priceClose = (priceDiff / minPrice) <= 0.075;

        if (ppsfClose && priceClose) {
          hasSupport = true;
          log.push(`✅ ${candidate.comp.address} supported by ${other.comp.address} (z-diff: ${zDiff.toFixed(3)}, price-diff: ${(priceDiff/minPrice*100).toFixed(1)}%)`);
          break;
        }
      }

      if (hasSupport) {
        supportedHighTier.push(candidate);
      } else {
        droppedHighNoSupport.push(candidate);
        log.push(`❌ ${candidate.comp.address} dropped (no support) - z: ${candidate.zScore.toFixed(3)}, PPSF: $${candidate.ppsf.toFixed(2)}`);
      }
    }

    log.push(`📊 Final selection: ${supportedHighTier.length} supported high-tier properties`);

    // CRITICAL FIX: Always trigger fallback when no supported high-tier properties
    if (supportedHighTier.length === 0) {
      log.push('🔄 TRIGGERING FALLBACK: No supported high-tier properties found');
      log.push(`🔍 FALLBACK: Calling pairHighFallback with ${dataWithZ.length} properties`);
      const fallbackResult = this.pairHighFallback(dataWithZ, log);
      log.push(`🔍 FALLBACK: Returned ${fallbackResult.selectedComps.length} properties`);
      return fallbackResult;
    }

    return {
      selectedComps: supportedHighTier.map(item => item.comp),
      droppedHighNoSupport: droppedHighNoSupport.map(item => item.comp),
      analysisLog: log
    };
  }

  /**
   * Pair-High Fallback: Select two highest-price comps if they're close in PPSF and price
   */
  private pairHighFallback(dataWithZ: any[], log: string[]): {
    selectedComps: any[];
    droppedHighNoSupport: any[];
    analysisLog: string[];
  } {
    log.push('🔄 Executing Outlier Removal Fallback ARV');
    log.push(`🔍 FALLBACK DEBUG: Input dataWithZ.length = ${dataWithZ.length}`);

    // Debug: Log each input property
    dataWithZ.forEach((item, index) => {
      log.push(`🔍 FALLBACK DEBUG ${index + 1}/${dataWithZ.length}:`);
      log.push(`   - address: ${item.comp?.address || 'MISSING'}`);
      log.push(`   - price: ${item.price || 'MISSING'}`);
      log.push(`   - ppsf: ${item.ppsf || 'MISSING'}`);
      log.push(`   - zScore: ${item.zScore || 'MISSING'}`);
      log.push(`   - comp object exists: ${!!item.comp}`);
    });

    if (dataWithZ.length < 3) {
      log.push('❌ Insufficient properties for fallback (need ≥3)');
      return { selectedComps: [], droppedHighNoSupport: [], analysisLog: log };
    }

    // Step 1: Drop low outliers (z ≤ -1.0)
    log.push(`🔍 STEP 1: Filtering low outliers (z ≤ -1.0)`);
    const afterLowOutlierRemoval = dataWithZ.filter(item => item.zScore > -1.0);
    const droppedLowOutliers = dataWithZ.filter(item => item.zScore <= -1.0);

    log.push(`📊 Step 1 Results: ${afterLowOutlierRemoval.length} kept, ${droppedLowOutliers.length} dropped`);

    // Log kept properties
    afterLowOutlierRemoval.forEach((item, index) => {
      log.push(`   ✅ KEPT ${index + 1}: ${item.comp?.address || 'NO ADDRESS'} z=${item.zScore?.toFixed(3) || 'NO Z'}`);
    });

    // Log dropped properties
    droppedLowOutliers.forEach(item => {
      log.push(`   ❌ DROPPED: ${item.comp?.address || 'NO ADDRESS'} z=${item.zScore?.toFixed(3) || 'NO Z'}`);
    });

    if (afterLowOutlierRemoval.length < 3) {
      log.push('❌ Too few properties remain after low outlier removal');
      return { selectedComps: [], droppedHighNoSupport: [], analysisLog: log };
    }

    // Step 2: Drop lone high-price outliers (7.5% price isolation rule)
    log.push(`🔍 STEP 2: Price isolation check (7.5% threshold)`);
    const finalProperties = [];
    const droppedIsolated = [];

    for (const candidate of afterLowOutlierRemoval) {
      log.push(`🔍 Checking isolation for ${candidate.comp?.address || 'NO ADDRESS'} ($${candidate.price?.toLocaleString() || 'NO PRICE'})`);
      let hasNeighbor = false;
      let closestNeighbor = null;
      let closestRatio = Infinity;

      for (const other of afterLowOutlierRemoval) {
        if (candidate === other) continue;

        const priceDiff = Math.abs(candidate.price - other.price);
        const minPrice = Math.min(candidate.price, other.price);
        const priceRatio = priceDiff / minPrice;

        if (priceRatio < closestRatio) {
          closestRatio = priceRatio;
          closestNeighbor = other;
        }

        if (priceRatio <= 0.075) {
          hasNeighbor = true;
          log.push(`   ✅ Found neighbor: ${other.comp?.address || 'NO ADDRESS'} ($${other.price?.toLocaleString() || 'NO PRICE'}), ratio=${(priceRatio*100).toFixed(1)}%`);
          break;
        }
      }

      if (hasNeighbor) {
        finalProperties.push(candidate);
      } else {
        droppedIsolated.push(candidate);
        log.push(`   ❌ ISOLATED: ${candidate.comp?.address || 'NO ADDRESS'} ($${candidate.price?.toLocaleString() || 'NO PRICE'}), closest neighbor ratio=${(closestRatio*100).toFixed(1)}%`);
      }
    }

    log.push(`📊 Step 2 Results: ${finalProperties.length} kept, ${droppedIsolated.length} isolated outliers dropped`);
    finalProperties.forEach((item, index) => {
      log.push(`   ✅ FINAL ${index + 1}: ${item.comp?.address || 'NO ADDRESS'} $${item.price?.toLocaleString() || 'NO PRICE'}`);
    });

    if (finalProperties.length < 3) {
      log.push('❌ Too few properties remain for reliable ARV');
      return { selectedComps: [], droppedHighNoSupport: [], analysisLog: log };
    }

    // Step 3: Optional trimming if >4 properties
    let arvProperties = finalProperties;
    if (finalProperties.length > 4) {
      // Sort by PPSF and trim 1 lowest + 1 highest
      const sortedByPpsf = finalProperties.slice().sort((a, b) => a.ppsf - b.ppsf);
      arvProperties = sortedByPpsf.slice(1, -1); // Remove first and last
      log.push(`📊 Trimmed 1 lowest + 1 highest PPSF, using ${arvProperties.length} for ARV`);
    }

    log.push(`✅ Fallback ARV will use ${arvProperties.length} properties`);
    arvProperties.forEach(item => {
      log.push(`   ✅ ${item.comp.address}: $${item.price.toLocaleString()}, PPSF=$${item.ppsf.toFixed(2)}`);
    });

    return {
      selectedComps: arvProperties.map(item => item.comp),
      droppedHighNoSupport: [...droppedLowOutliers, ...droppedIsolated].map(item => item.comp),
      analysisLog: log
    };
  }

  /**
   * Calculate median of an array
   */
  private calculateMedian(values: number[]): number {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      return sorted[mid];
    }
  }

  /**
   * Calculate percentile of an array
   */
  private calculatePercentile(values: number[], percentile: number): number {
    const sorted = values.slice().sort((a, b) => a - b);
    const index = (percentile / 100) * (sorted.length - 1);

    if (Number.isInteger(index)) {
      return sorted[index];
    } else {
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;
      return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }
  }

  private buildSubjectSummary(address: string, details: any): SubjectSummary {
    const toNumber = (value: any): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    return {
      address: (details?.address as string) || address,
      sqft: toNumber(details?.sqft),
      beds: toNumber(details?.beds),
      baths: toNumber(details?.baths),
      yearBuilt: toNumber(details?.yearBuilt),
      lotSize: toNumber(details?.lotSize),
      subdivision: details?.subdivision ?? null,
      success: details?.success ?? true,
    };
  }

  // Get subject coordinates from the compService
  private async getSubjectCoordinates(address: string): Promise<{ lat: number; lon: number } | null> {
    try {
      jobLog(`   🔍 Getting subject coordinates for: ${address}`);

      // Access the geocoding method from the compService
      const subjectCoords = await (this.compService as any).geocodeWithTimeout(address, 5000);

      if (subjectCoords && subjectCoords.lat && subjectCoords.lon) {
        jobLog(`   📍 Subject coordinates retrieved: ${subjectCoords.lat}, ${subjectCoords.lon}`);
        return subjectCoords;
      } else {
        jobLog(`   ❌ Failed to get subject coordinates`);
        return null;
      }
    } catch (error: any) {
      jobLog(`   ❌ Error getting subject coordinates: ${error.message}`);
      return null;
    }
  }

  // Validate distances using coordinate-based calculation
  private async validateDistances(
    properties: any[],
    subjectCoords: { lat: number; lon: number },
    maxDistanceMiles: number
  ): Promise<{ validated: any[]; rejected: any[] }> {
    jobLog(`   🔍 Extracting coordinates for ${properties.length} comparables...`);

    const validated: any[] = [];
    const rejected: any[] = [];

    // Extract coordinates using Vertex AI batch processing
    const coordinatesMap = await this.extractCoordinatesBatch(properties);

    jobLog(`   📊 Successfully extracted coordinates for ${coordinatesMap.size}/${properties.length} properties`);

    // Calculate distances and filter
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      const propCoords = coordinatesMap.get(i);

      if (propCoords) {
        const distance = this.calculateHaversineDistance(
          subjectCoords.lat,
          subjectCoords.lon,
          propCoords.lat,
          propCoords.lon
        );

        if (distance <= maxDistanceMiles) {
          // Add distance to property for future reference
          property.distanceFromSubject = distance;
          validated.push(property);
          jobLog(`   ✅ ${property.address}: ${distance.toFixed(2)} miles (within ${maxDistanceMiles} miles)`);
        } else {
          rejected.push(property);
          jobLog(`   ❌ ${property.address}: ${distance.toFixed(2)} miles (exceeds ${maxDistanceMiles} miles)`);
        }
      } else {
        // If we can't get coordinates, reject the property
        rejected.push(property);
        jobLog(`   ❌ ${property.address}: Could not extract coordinates`);
      }
    }

    return { validated, rejected };
  }

  // Extract coordinates for a batch of properties using Vertex AI
  private async extractCoordinatesBatch(properties: any[]): Promise<Map<number, { lat: number; lon: number }>> {
    const coordinatesMap = new Map<number, { lat: number; lon: number }>();

    try {
      // Import vertex generation function and ADC helpers
      const { vertexGenerate, resolveProjectId, getAccessTokenViaAuth } = await import('./vertex-freeform');

      // Use Application Default Credentials (ADC)
      const projectId = await resolveProjectId();
      const token = await getAccessTokenViaAuth();
      const location = process.env.VERTEX_LOCATION || 'us-central1';
      const model = process.env.VERTEX_MODEL || 'gemini-2.5-pro';

      // Create batch prompt for coordinate extraction
      const addressList = properties.map((prop, index) => `${index + 1}. "${prop.address}"`).join('\n');

      const prompt = `You are a geocoding assistant. Given U.S. street addresses, return precise WGS84 coordinates.

Rules:
- Search authoritative sources only (Google Maps, county GIS, USPS/US Census TIGER, state/city GIS, assessor/parcel maps)
- Prefer rooftop or parcel centroid points over street interpolation
- If multiple candidates exist, pick the one that matches city + ZIP; otherwise return the best within the same city and note a lower precision
- If you cannot verify a single match from authoritative sources, return "status":"NO_MATCH" and do not guess

Addresses to geocode:
${addressList}

For each address, return a JSON object with exactly these fields:
{
"status": "OK" | "NO_MATCH" | "AMBIGUOUS",
"formatted_address": "string",
"latitude": number,
"longitude": number,
"precision": "rooftop" | "parcel_centroid" | "interpolated" | "city_centroid",
"source": "google_maps" | "county_gis" | "state_gis" | "usps" | "other_gis",
"notes": "string"
}

Quality checks:
- Coordinates must be decimal degrees (WGS84)
- Do not round more than 6 decimal places
- If the result is not at least parcel-level, set precision accordingly and explain in notes

Output format:
ADDRESS 1:
[JSON object]

ADDRESS 2:
[JSON object]

(Continue for all ${properties.length} addresses)`;

      jobLog(`   🤖 Requesting coordinates for ${properties.length} properties from Vertex AI...`);

      // S0-v2: Wrap vertexGenerate with limiter
      const response = await withVertexLimiter(
        'v3:extractCoordinatesBatch',
        this.currentJobId,
        () => vertexGenerate({
          token,
          projectId,
          location,
          model,
          prompt,
          grounded: true,
          json: false,
          timeoutMs: 60000
        })
      );

      if (response && response.trim().length > 0) {
        // Parse the batch response with new JSON format
        const sections = response.split(/ADDRESS \d+:/);

        for (let i = 0; i < properties.length; i++) {
          const section = sections[i + 1]; // Skip first empty element

          if (section) {
            try {
              // Extract JSON from the section
              const jsonMatch = section.match(/\{[\s\S]*?\}/);
              if (jsonMatch) {
                const geocodeResult = JSON.parse(jsonMatch[0]);

                if (geocodeResult.status === 'OK' && geocodeResult.latitude && geocodeResult.longitude) {
                  const lat = parseFloat(geocodeResult.latitude);
                  const lon = parseFloat(geocodeResult.longitude);

                  if (!isNaN(lat) && !isNaN(lon)) {
                    coordinatesMap.set(i, { lat, lon });
                    jobLog(`   📍 Property ${i + 1}: ${lat}, ${lon} (${geocodeResult.precision}, ${geocodeResult.source})`);
                  } else {
                    jobLog(`   ❌ Property ${i + 1}: Invalid coordinates in response`);
                  }
                } else {
                  jobLog(`   ❌ Property ${i + 1}: ${geocodeResult.status} - ${geocodeResult.notes || 'No coordinates found'}`);
                }
              } else {
                jobLog(`   ❌ Property ${i + 1}: No JSON found in response section`);
              }
            } catch (error: any) {
              jobLog(`   ❌ Property ${i + 1}: JSON parse error - ${error.message}`);
            }
          } else {
            jobLog(`   ❌ Property ${i + 1}: No response section found`);
          }
        }
      } else {
        jobLog(`   ❌ Empty or invalid response from Vertex AI`);
      }

    } catch (error: any) {
      jobLog(`   ❌ Batch coordinate extraction failed: ${error.message}`);
    }

    return coordinatesMap;
  }

  // Calculate distance between two coordinates using Haversine formula
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

  // Helper function to convert degrees to radians
  private degreesToRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

// Test function
async function testComprehensiveSearchV3() {
  const address = process.env.ADDRESS;
  if (!address) {
    console.error('❌ ADDRESS environment variable is required');
    process.exit(1);
  }

  try {
    const service = new ComprehensiveComparableSearchV3();
    const result = await service.findComparables(address);

    jobLog(`✅ Search completed successfully!`);
    jobLog(`   All Comps: ${result.all_comps.length}`);
    jobLog(`   Qualified: ${result.qualified_comps.length}`);
    jobLog(`   Renovated: ${result.renovation_analysis.likely_renovated.length}`);
    jobLog(`   Quality: ${result.searchMetadata.qualityScore}`);
    jobLog(`   Subject Baths: ${result.bathroomAnalysis.subjectBaths}`);
    jobLog(`   Recommendation: ${result.bathroomAnalysis.recommendAction}`);

    if (result.arv) {
      jobLog(`   Baseline ARV: $${result.arv.estimate.toLocaleString()}`);
    }

    if (result.twoBathARV) {
      jobLog(`   2-Bath ARV: $${result.twoBathARV.estimate.toLocaleString()}`);
      jobLog(`   Value Add: $${result.twoBathARV.valueAdd.toLocaleString()} (${result.twoBathARV.valueAddPercent.toFixed(1)}%)`);
      jobLog(`   ROI: ${result.twoBathARV.roiEstimate?.toFixed(1)}%`);
    }

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testComprehensiveSearchV3().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}
