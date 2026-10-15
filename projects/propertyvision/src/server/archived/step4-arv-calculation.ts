import { ComparableProperty } from './step3-find-comparables';
import { jobLog } from '../utils/jobLogger';

interface ARVResult {
  arv: number;
  slope?: number; // Price per square foot (for regression methods)
  intercept?: number; // Y-intercept for full regression
  r2?: number; // Coefficient of determination (for regression methods)
  method: string; // Calculation method used
  dataPoints: number;
  confidence: 'high' | 'medium' | 'low';
}

class ARVCalculationService {
  
  /**
   * Calculate ARV using zero-intercept linear regression (y = mx)
   * This finds the best-fit line through the origin using comparable sales data
   */
  calculateARV(
    comparables: ComparableProperty[],
    subjectSqft: number,
    subjectBaths?: number | null
  ): ARVResult {
    if (comparables.length === 0) {
      return {
        arv: 0,
        slope: 0,
        r2: 0,
        dataPoints: 0,
        confidence: 'low',
        method: 'no-data'
      };
    }

    jobLog(`📊 ARV Calculation: ${comparables.length} total comparables`);

    // Step 1: Use comparables as-is (no outlier filtering)
    const filteredComparables = comparables;
    
    if (filteredComparables.length === 0) {
      jobLog(`⚠️ All comparables filtered out as outliers, using original set`);
      // If all are outliers, use original set but flag as low confidence
    }

    // Apply bathroom adjustments when subject has fewer baths than comps
    const subjectBathsNormalized = Number.isFinite(subjectBaths as any)
      ? Number(subjectBaths)
      : null;
    const finalComparables = (filteredComparables.length > 0 ? filteredComparables : comparables);
    
    let dataPoints: any[];
    
    // Check if we need bathroom adjustments (only if subject bath count is known)
    const needsBathAdjustments = subjectBathsNormalized != null
      && finalComparables.some(comp => Number.isFinite(comp.baths as any) && comp.baths > (subjectBathsNormalized as number));
    if (needsBathAdjustments) {
      jobLog(`🚿 Applying bathroom adjustments where comps exceed subject baths (${subjectBathsNormalized})...`);
      
      // Estimate second bathroom premium
      const bathPremium = this.estimateSecondBathPremium(subjectSqft, finalComparables);
      
      // Apply penalties and create adjusted data points
      const adjustedComparables = finalComparables.map(comp => {
        const compBaths = Number(comp.baths);
        if (Number.isFinite(compBaths) && subjectBathsNormalized != null && compBaths > subjectBathsNormalized) {
          const adjustedPrice = this.applyBathPenaltyToIndication(subjectSqft, subjectBathsNormalized, comp, bathPremium);
          return {
            ...comp,
            price: adjustedPrice,
            originalPrice: comp.price,
            bathroomAdjusted: true
          };
        }
        return comp;
      });
      
      // Prepare data points with bathroom adjustments
      dataPoints = adjustedComparables.map(comp => ({
        x: comp.sqft,
        y: comp.price,
        address: comp.address,
        originalPrice: (comp as any).originalPrice || comp.price,
        bathroomAdjusted: (comp as any).bathroomAdjusted || false
      }));
    } else {
      // No bathroom adjustments needed
      dataPoints = finalComparables.map(comp => ({
        x: comp.sqft,
        y: comp.price,
        address: comp.address
      }));
    }

    jobLog(`📊 Final ARV Calculation: ${dataPoints.length} data points (after outlier filtering)`);
    dataPoints.forEach(point => {
      jobLog(`   ${point.address}: ${point.x} sqft → $${point.y.toLocaleString()}`);
    });

    // Calculate ARV using direct comparable analysis
    const arvResult = this.calculateARVFromComps(dataPoints, subjectSqft);

    jobLog(`📈 Comparable-based ARV calculation:`);
    jobLog(`   Method: ${arvResult.method}`);
    jobLog(`   ARV: $${arvResult.arv.toLocaleString()}`);
    jobLog(`   Confidence: ${arvResult.confidence}`);

    return arvResult;
  }

  /**
   * Calculate ARV directly from comparable data
   */
  private calculateARVFromComps(dataPoints: Array<{x: number, y: number, address: string}>, subjectSqft: number): ARVResult {
    const n = dataPoints.length;
    
    if (n === 0) {
      return {
        arv: 0,
        method: 'No comparables',
        dataPoints: 0,
        confidence: 'low'
      };
    }

    // Calculate PPSF for each comp
    const ppsfData = dataPoints.map(point => ({
      address: point.address,
      sqft: point.x,
      price: point.y,
      ppsf: point.y / point.x
    }));

    jobLog(`📊 PPSF Analysis:`);
    ppsfData.forEach(comp => {
      jobLog(`   ${comp.address}: $${comp.price.toLocaleString()} ÷ ${comp.sqft} = $${comp.ppsf.toFixed(2)}/sqft`);
    });

    // Calculate statistics
    const ppsfValues = ppsfData.map(comp => comp.ppsf);
    const meanPpsf = ppsfValues.reduce((sum, ppsf) => sum + ppsf, 0) / n;
    const medianPpsf = this.calculatePercentile(ppsfValues.sort((a, b) => a - b), 50);

    jobLog(`📊 PPSF Statistics:`);
    jobLog(`   Mean PPSF: $${meanPpsf.toFixed(2)}/sqft`);
    jobLog(`   Median PPSF: $${medianPpsf.toFixed(2)}/sqft`);

    // Use median PPSF for ARV calculation (more robust than mean)
    const arv = Math.round(medianPpsf * subjectSqft);

    // Determine confidence
    let confidence: 'high' | 'medium' | 'low';
    if (n >= 4) {
      confidence = 'high';
    } else if (n >= 3) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    return {
      arv,
      method: `Median PPSF (${medianPpsf.toFixed(2)}/sqft)`,
      dataPoints: n,
      confidence
    };
  }

  /**
   * Zero-intercept linear regression: y = mx
   * Minimizes sum of squared residuals: Σ(y - mx)²
   */
  private zeroInterceptLinearRegression(dataPoints: Array<{x: number, y: number}>): {slope: number, r2: number} {
    const n = dataPoints.length;
    
    if (n === 0) {
      return { slope: 0, r2: 0 };
    }

    // Calculate slope: m = Σ(xy) / Σ(x²)
    const sumXY = dataPoints.reduce((sum, point) => sum + (point.x * point.y), 0);
    const sumX2 = dataPoints.reduce((sum, point) => sum + (point.x * point.x), 0);
    
    const slope = sumXY / sumX2;

    // Calculate R² (coefficient of determination)
    const sumY = dataPoints.reduce((sum, point) => sum + point.y, 0);
    const meanY = sumY / n;
    
    // Total sum of squares
    const totalSumSquares = dataPoints.reduce((sum, point) => sum + Math.pow(point.y - meanY, 2), 0);
    
    // Sum of squared residuals
    const residualSumSquares = dataPoints.reduce((sum, point) => {
      const predicted = slope * point.x;
      return sum + Math.pow(point.y - predicted, 2);
    }, 0);
    
    // R² = 1 - (SS_res / SS_tot)
    const r2 = 1 - (residualSumSquares / totalSumSquares);

    return { slope, r2 };
  }

  /**
   * Full linear regression (with intercept): y = mx + b
   */
  private fullLinearRegression(dataPoints: Array<{x: number, y: number}>): {slope: number, intercept: number, r2: number} {
    const n = dataPoints.length;
    
    if (n === 0) {
      return { slope: 0, intercept: 0, r2: 0 };
    }

    // Calculate means
    const meanX = dataPoints.reduce((sum, point) => sum + point.x, 0) / n;
    const meanY = dataPoints.reduce((sum, point) => sum + point.y, 0) / n;

    // Calculate slope: m = Σ((x - x̄)(y - ȳ)) / Σ((x - x̄)²)
    const numerator = dataPoints.reduce((sum, point) => 
      sum + ((point.x - meanX) * (point.y - meanY)), 0);
    const denominator = dataPoints.reduce((sum, point) => 
      sum + Math.pow(point.x - meanX, 2), 0);
    
    const slope = denominator === 0 ? 0 : numerator / denominator;
    
    // Calculate intercept: b = ȳ - m * x̄
    const intercept = meanY - slope * meanX;

    // Calculate R² (coefficient of determination)
    // Total sum of squares
    const totalSumSquares = dataPoints.reduce((sum, point) => 
      sum + Math.pow(point.y - meanY, 2), 0);
    
    // Sum of squared residuals
    const residualSumSquares = dataPoints.reduce((sum, point) => {
      const predicted = slope * point.x + intercept;
      return sum + Math.pow(point.y - predicted, 2);
    }, 0);
    
    // R² = 1 - (SS_res / SS_tot)
    const r2 = totalSumSquares === 0 ? 0 : 1 - (residualSumSquares / totalSumSquares);

    return { slope, intercept, r2 };
  }

  /**
   * Alternative ARV calculation using weighted regression
   * Weights comps by inverse distance (closer comps have more influence)
   */
  calculateWeightedARV(comparables: ComparableProperty[], subjectSqft: number): ARVResult {
    if (comparables.length === 0) {
      return {
        arv: 0,
        slope: 0,
        r2: 0,
        dataPoints: 0,
        confidence: 'low',
        method: 'weighted-no-data'
      };
    }

    // Prepare weighted data points
    const dataPoints = comparables.map(comp => ({
      x: comp.sqft,
      y: comp.price,
      weight: 1 / (comp.distance + 0.1), // +0.1 to avoid division by zero
      address: comp.address
    }));

    jobLog(`📊 Weighted ARV Calculation: ${dataPoints.length} data points`);
    dataPoints.forEach(point => {
      jobLog(`   ${point.address}: ${point.x} sqft → $${point.y.toLocaleString()} (weight: ${point.weight.toFixed(2)})`);
    });

    // Calculate weighted zero-intercept linear regression
    const regression = this.weightedZeroInterceptLinearRegression(dataPoints);
    
    const arv = Math.round(regression.slope * subjectSqft);
    
    let confidence: 'high' | 'medium' | 'low';
    if (dataPoints.length >= 4 && regression.r2 >= 0.8) {
      confidence = 'high';
    } else if (dataPoints.length >= 3 && regression.r2 >= 0.6) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    jobLog(`📈 Weighted zero-intercept regression results:`);
    jobLog(`   Slope (PPSF): $${regression.slope.toFixed(2)}`);
    jobLog(`   R²: ${regression.r2.toFixed(3)}`);
    jobLog(`   ARV: $${arv.toLocaleString()}`);
    jobLog(`   Confidence: ${confidence}`);

    return {
      arv,
      slope: regression.slope,
      r2: regression.r2,
      dataPoints: dataPoints.length,
      confidence,
      method: 'weighted-regression'
    };
  }

  /**
   * Weighted zero-intercept linear regression
   */
  private weightedZeroInterceptLinearRegression(dataPoints: Array<{x: number, y: number, weight: number}>): {slope: number, r2: number} {
    const n = dataPoints.length;
    
    if (n === 0) {
      return { slope: 0, r2: 0 };
    }

    // Calculate weighted slope: m = Σ(w*xy) / Σ(w*x²)
    const sumWXY = dataPoints.reduce((sum, point) => sum + (point.weight * point.x * point.y), 0);
    const sumWX2 = dataPoints.reduce((sum, point) => sum + (point.weight * point.x * point.x), 0);
    
    const slope = sumWXY / sumWX2;

    // Calculate weighted R²
    const sumWY = dataPoints.reduce((sum, point) => sum + (point.weight * point.y), 0);
    const sumW = dataPoints.reduce((sum, point) => sum + point.weight, 0);
    const weightedMeanY = sumWY / sumW;
    
    // Weighted total sum of squares
    const weightedTotalSumSquares = dataPoints.reduce((sum, point) => 
      sum + (point.weight * Math.pow(point.y - weightedMeanY, 2)), 0);
    
    // Weighted sum of squared residuals
    const weightedResidualSumSquares = dataPoints.reduce((sum, point) => {
      const predicted = slope * point.x;
      return sum + (point.weight * Math.pow(point.y - predicted, 2));
    }, 0);
    
    const r2 = 1 - (weightedResidualSumSquares / weightedTotalSumSquares);

    return { slope, r2 };
  }

  /**
   * REMOVED: Outlier detection disabled - use all comparables as-is
   */
  private detectAndFilterOutliers(comparables: ComparableProperty[], subjectSqft: number): ComparableProperty[] {
    jobLog(`📊 Outlier detection disabled - using all ${comparables.length} comparables`);
    return comparables; // Return all comparables without filtering
  }



  /**
   * Complex escalation process with multiple steps
   * This implements the full escalation method: Timeline → GLA → Bathroom → Distance → Municipal
   */
  private applyComplexEscalation(
    originalComparables: ComparableProperty[], 
    subjectSqft: number,
    escalationStep: number = 1
  ): ComparableProperty[] {
    jobLog(`🔄 ESCALATION STEP ${escalationStep}: Starting complex escalation process...`);
    
    let currentComps = [...originalComparables];
    let stepName = "";
    
    switch (escalationStep) {
      case 1:
        stepName = "Timeline Expansion (18 months)";
        jobLog(`   ⚠️ Timeline expansion requires re-searching - handled at full-analysis level`);
        jobLog(`   📋 Proceeding to Step 2: GLA Bucket Expansion`);
        return this.applyComplexEscalation(originalComparables, subjectSqft, 2);
        
      case 2:
        stepName = "GLA Bucket Expansion (±25%)";
        jobLog(`🔄 Step 2: Expanding GLA bucket to ±25%...`);
        currentComps = this.applyExpandedGLABucketing(originalComparables, subjectSqft);
        break;
        
      case 3:
        stepName = "Bathroom Escalation (Allow 2-bath comps)";
        jobLog(`🔄 Step 3: Allowing 2-bath comparables with penalty system...`);
        currentComps = this.applyBathroomEscalation(currentComps, subjectSqft);
        break;
        
      case 4:
        stepName = "Distance Expansion (Same Municipality)";
        jobLog(`🔄 Step 4: Expanding search radius within same municipality...`);
        jobLog(`   ⚠️ Distance expansion requires re-searching - handled at full-analysis level`);
        jobLog(`   📋 Proceeding to Step 5: Municipal Boundary Expansion`);
        return this.applyComplexEscalation(originalComparables, subjectSqft, 5);
        
      case 5:
        stepName = "Municipal Boundary Expansion (Last Resort)";
        jobLog(`🔄 Step 5: Crossing municipal boundaries with down-weighting...`);
        jobLog(`   ⚠️ Municipal expansion requires re-searching - handled at full-analysis level`);
        jobLog(`   🚨 CRITICAL: All escalation options exhausted`);
        return originalComparables; // Return what we have
        
      default:
        jobLog(`   🚨 ERROR: Invalid escalation step ${escalationStep}`);
        return originalComparables;
    }
    
    jobLog(`   📊 ${stepName} found: ${currentComps.length} comps`);
    
    if (currentComps.length >= 3) {
      jobLog(`   🔄 Re-applying complete analysis pipeline to escalated set...`);
      
      // Apply complete analysis pipeline (GLA + outlier detection + bathroom analysis)
      const reFilteredComps = this.applyCompleteAnalysisPipeline(currentComps, subjectSqft);
      
      jobLog(`   📊 Complete analysis results: ${reFilteredComps.length} valid comps`);
      
      if (reFilteredComps.length >= 3) {
        jobLog(`   ✅ ${stepName} successful: ${reFilteredComps.length} valid comps for ARV`);
        return reFilteredComps;
      } else {
        jobLog(`   ⚠️ After ${stepName}: Still insufficient comps (${reFilteredComps.length} < 3)`);
        jobLog(`   📋 NEXT STEP: ${escalationStep + 1}`);
        return this.applyComplexEscalation(originalComparables, subjectSqft, escalationStep + 1);
      }
    } else {
      jobLog(`   🚨 CRITICAL: ${stepName} insufficient comps (${currentComps.length} < 3)`);
      jobLog(`   📋 NEXT STEP: ${escalationStep + 1}`);
      return this.applyComplexEscalation(originalComparables, subjectSqft, escalationStep + 1);
    }
  }

  /**
   * Apply complete analysis pipeline (GLA + outlier detection + bathroom analysis)
   */
  private applyCompleteAnalysisPipeline(
    comparables: ComparableProperty[], 
    subjectSqft: number
  ): ComparableProperty[] {
    // Step 1: GLA Bucketing
    const glaFilteredComps = this.applyGLABucketing(comparables, subjectSqft);
    
    // Step 2: Outlier Detection
    const outlierFilteredComps = this.applyCoreOutlierDetection(glaFilteredComps, subjectSqft);
    
    // Step 3: Bathroom Analysis & Penalties (if needed)
    // Note: This would be implemented based on subject property bathroom count
    
    return outlierFilteredComps;
  }

  /**
   * Bathroom escalation: Allow 2-bath comps with penalty system
   */
  private applyBathroomEscalation(
    originalComparables: ComparableProperty[], 
    subjectSqft: number
  ): ComparableProperty[] {
    jobLog(`   🚿 Allowing 2-bath comparables with penalty system...`);
    
    // For now, return original comps (bathroom escalation logic would be implemented here)
    // This would include:
    // 1. Remove 1-bath filtering
    // 2. Apply bathroom penalty system
    // 3. Weight 2-bath comps appropriately
    
    return originalComparables;
  }

  /**
   * REMOVED: Core outlier detection disabled
   */
  private applyCoreOutlierDetection(comparables: ComparableProperty[], subjectSqft: number): ComparableProperty[] {
    jobLog(`📊 Core outlier detection disabled - using all ${comparables.length} comparables`);
    return comparables; // Return all comparables without filtering
  }

  /**
   * Expanded GLA bucketing for thin-data escalation
   */
  private applyExpandedGLABucketing(comparables: ComparableProperty[], subjectSqft: number): ComparableProperty[] {
    const expandedRange = subjectSqft * 0.25; // ±25%
    const minSqft = subjectSqft - expandedRange;
    const maxSqft = subjectSqft + expandedRange;

    jobLog(`   📏 Expanded GLA bucket: ${minSqft.toFixed(0)} - ${maxSqft.toFixed(0)} sqft (±25%)`);

    const filtered = comparables.filter(comp => {
      const inRange = comp.sqft >= minSqft && comp.sqft <= maxSqft;
      jobLog(`   ${comp.address}: ${comp.sqft} sqft ${inRange ? '✅' : '❌'}`);
      return inRange;
    });

    return filtered;
  }

  /**
   * Calculate percentile value from sorted array
   */
  private calculatePercentile(sortedValues: number[], percentile: number): number {
    const index = (percentile / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;

    if (upper >= sortedValues.length) {
      return sortedValues[sortedValues.length - 1];
    }

    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  /**
   * Bathroom adjustment system for 2-bath comparables
   */
  private estimateSecondBathPremium(subjectSqft: number, comps: ComparableProperty[]): { full: number; halfFactor: number } {
    jobLog(`🚿 Estimating second bathroom premium for ${subjectSqft} sqft subject...`);

    // 1) Try paired sales: find near-identical 1-bath vs 2-bath pairs
    const bucket = (c: ComparableProperty) => Math.abs(c.sqft - subjectSqft) <= subjectSqft * 0.10;
    const ones = comps.filter(c => c.baths === 1 && bucket(c));
    const twos = comps.filter(c => c.baths >= 2 && bucket(c));
    const pairs: number[] = [];

    jobLog(`   Found ${ones.length} 1-bath comps and ${twos.length} 2-bath comps in GLA bucket`);

    for (const oneBath of ones) {
      // Find nearest neighbor in 2-bath comps by sqft
      const nearest = twos.reduce<{ distance: number; premium: number } | null>((best, twoBath) => {
        const distance = Math.abs(twoBath.sqft - oneBath.sqft);
        const premium = (twoBath.price / twoBath.sqft - oneBath.price / oneBath.sqft) * subjectSqft;
        const val = { distance, premium };
        return !best || distance < best.distance ? val : best;
      }, null);
      
      if (nearest) {
        pairs.push(nearest.premium);
        jobLog(`   Pair: ${oneBath.address} (${oneBath.sqft} sqft, 1 bath) vs nearest 2-bath → $${nearest.premium.toLocaleString()} premium`);
      }
    }

    let fullPremium = NaN;
    if (pairs.length >= 2) {
      pairs.sort((x, y) => x - y);
      fullPremium = pairs.length % 2 
        ? pairs[Math.floor(pairs.length / 2)] 
        : (pairs[pairs.length / 2 - 1] + pairs[pairs.length / 2]) / 2;
      jobLog(`   ✅ Paired sales analysis: $${fullPremium.toLocaleString()} premium (${pairs.length} pairs)`);
    }

    // 2) Fallback bands if pairs are thin
    if (!Number.isFinite(fullPremium)) {
      fullPremium = subjectSqft < 1000 ? 10000 : subjectSqft < 1500 ? 14000 : 16000;
      jobLog(`   📊 Fallback premium: $${fullPremium.toLocaleString()} (based on size band)`);
    }

    return { full: fullPremium, halfFactor: 0.35 };
  }

  /**
   * Apply bathroom penalty to 2-bath comparable
   */
  private applyBathPenaltyToIndication(
    subjectSqft: number, 
    subjectBaths: number, 
    comp: ComparableProperty, 
    premium: { full: number; halfFactor: number }
  ): number {
    const ppsf = comp.price / comp.sqft;
    let adjustedIndication = ppsf * subjectSqft;
    
    const deltaFull = Math.max(0, Math.floor(comp.baths) - subjectBaths);
    const deltaHalf = Math.max(0, comp.baths - Math.floor(comp.baths)); // e.g., 1.5 -> 0.5
    
    let penalty = premium.full * deltaFull + premium.full * premium.halfFactor * deltaHalf;
    
    // Primary ensuite adds ~10-20% to second-bath premium
    if (deltaFull >= 1) {
      penalty *= 1.15; // 15% uplift for primary ensuite
    }
    
    const finalIndication = Math.max(0, adjustedIndication - penalty);
    
    jobLog(`   🚿 ${comp.address}: $${comp.price.toLocaleString()} (${comp.baths} baths)`);
    jobLog(`      Raw indication: $${adjustedIndication.toLocaleString()}`);
    jobLog(`      Bath penalty: $${penalty.toLocaleString()} (${deltaFull} full + ${deltaHalf} half baths)`);
    jobLog(`      Adjusted indication: $${finalIndication.toLocaleString()}`);
    
    return finalIndication;
  }

  /**
   * GLA (Gross Living Area) Bucketing
   * Filters comparables by similar size to ensure apples-to-apples PPSF comparisons
   */
  private applyGLABucketing(comparables: ComparableProperty[], subjectSqft: number): ComparableProperty[] {
    jobLog(`📏 Applying GLA bucketing for subject: ${subjectSqft} sqft`);

    // Determine GLA bucket based on subject size
    let bucketRange: { min: number; max: number };
    
    if (subjectSqft < 800) {
      // Very small homes: absolute band ±100-150 sf
      bucketRange = {
        min: subjectSqft - 150,
        max: subjectSqft + 150
      };
      jobLog(`🏠 Very small home: using absolute band ±150 sqft`);
    } else if (subjectSqft > 3000) {
      // Large homes: tighter ±8-10%
      const margin = Math.round(subjectSqft * 0.10);
      bucketRange = {
        min: subjectSqft - margin,
        max: subjectSqft + margin
      };
      jobLog(`🏠 Large home: using ±10% margin (${margin} sqft)`);
    } else {
      // Default houses (800-3000 sf): ±20% standard, expand to ±25% if thin inventory
      const margin20 = Math.round(subjectSqft * 0.20);
      const margin25 = Math.round(subjectSqft * 0.25);

      // Start with ±20% bucket (industry standard)
      bucketRange = {
        min: subjectSqft - margin20,
        max: subjectSqft + margin20
      };

      jobLog(`🏠 Default house: starting with ±20% bucket (${margin20} sqft)`);
      jobLog(`   ±20% bucket: ${bucketRange.min} - ${bucketRange.max} sqft`);
    }

    // Filter comparables by GLA bucket
    const glaFiltered = comparables.filter(comp => {
      const inBucket = comp.sqft >= bucketRange.min && comp.sqft <= bucketRange.max;
      jobLog(`   ${comp.address}: ${comp.sqft} sqft ${inBucket ? '✅' : '❌'} ${inBucket ? '' : `(outside ${bucketRange.min}-${bucketRange.max})`}`);
      return inBucket;
    });

    // If inventory is thin (< 3 comps), expand to ±25% for default houses
    if (glaFiltered.length < 3 && subjectSqft >= 800 && subjectSqft <= 3000) {
      jobLog(`⚠️ Thin inventory (${glaFiltered.length} comps), expanding to ±25% bucket`);

      const margin25 = Math.round(subjectSqft * 0.25);
      bucketRange = {
        min: subjectSqft - margin25,
        max: subjectSqft + margin25
      };

      jobLog(`   ±25% bucket: ${bucketRange.min} - ${bucketRange.max} sqft`);
      
      const expandedFiltered = comparables.filter(comp => {
        const inBucket = comp.sqft >= bucketRange.min && comp.sqft <= bucketRange.max;
        jobLog(`   ${comp.address}: ${comp.sqft} sqft ${inBucket ? '✅' : '❌'} ${inBucket ? '' : `(outside ${bucketRange.min}-${bucketRange.max})`}`);
        return inBucket;
      });
      
      return expandedFiltered;
    }

    jobLog(`📊 GLA Bucket Summary:`);
    jobLog(`   Subject: ${subjectSqft} sqft`);
    jobLog(`   Bucket range: ${bucketRange.min} - ${bucketRange.max} sqft`);
    jobLog(`   Comps in bucket: ${glaFiltered.length}/${comparables.length}`);

    return glaFiltered;
  }
}

// Test function
async function testARVCalculation() {
  // Get real data from previous steps
  const subjectSqftStr = process.env.SUBJECT_SQFT;
  if (!subjectSqftStr) {
    throw new Error('SUBJECT_SQFT environment variable is required');
  }
  const subjectSqft = parseInt(subjectSqftStr);
  
  const comparablesData = process.env.COMPARABLES_DATA;
  if (!comparablesData) {
    throw new Error('COMPARABLES_DATA environment variable is required');
  }
  
  let comparables: ComparableProperty[];
  try {
    comparables = JSON.parse(comparablesData);
  } catch (error) {
    throw new Error('Invalid COMPARABLES_DATA JSON format');
  }
  
  jobLog(`\n💰 STEP 4: ARV CALCULATION`);
  jobLog(`============================================================`);
  
  const arvService = new ARVCalculationService();
  
  jobLog(`\n📊 Standard Zero-Intercept Regression:`);
  const standardResult = arvService.calculateARV(comparables, subjectSqft);
  
  jobLog(`\n📊 Distance-Weighted Zero-Intercept Regression:`);
  const weightedResult = arvService.calculateWeightedARV(comparables, subjectSqft);
  
  jobLog(`\n✅ ARV Calculation Complete:`);
  jobLog(`   Standard ARV: $${standardResult.arv.toLocaleString()} (${standardResult.confidence} confidence)`);
  jobLog(`   Weighted ARV: $${weightedResult.arv.toLocaleString()} (${weightedResult.confidence} confidence)`);
  
  return { standardResult, weightedResult };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testARVCalculation().catch(console.error);
}

export { ARVCalculationService, testARVCalculation };
export type { ARVResult };
