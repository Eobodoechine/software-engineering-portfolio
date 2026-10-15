// Complete ARV Calculator - Implements the full valuation methodology
// Combines your original description with the strict CentralUpperChain algorithm

import { jobLog } from './utils/jobLogger';

export class ARVCalculator {

  /**
   * Main ARV calculation entry point
   */
  calculateARV(subject, comparables) {
    jobLog(`🧮 CALCULATING ARV FOR ${subject.sqft} SQFT PROPERTY`);
    jobLog(`📊 Input: ${comparables.length} comparables`);

    try {
      // Step 0: Clean & prepare
      const cleaned = this.cleanAndPrepare(comparables);
      jobLog(`📊 After cleaning: ${cleaned.length} comparables`);

      if (cleaned.length < 2) {
        return this.insufficientDataResult(cleaned, "Less than 2 valid comparables");
      }

      // Special case: Flat PPSF (all comps have same PPSF)
      const ppsfValues = cleaned.map(c => c.ppsf);
      const minPPSF = Math.min(...ppsfValues);
      const maxPPSF = Math.max(...ppsfValues);
      const nonZeroGaps = ppsfValues
        .slice(0, -1)
        .map((ppsf, i) => ppsfValues[i + 1] - ppsf)
        .filter(g => g > 0);

      const epsilon = nonZeroGaps.length > 0 ? Math.min(...nonZeroGaps) : 1;

      if (maxPPSF - minPPSF < epsilon) {
        jobLog('\n📊 SPECIAL: FLAT-PPSF MODE (all comps have same PPSF)');
        jobLog(`   Epsilon: ${epsilon.toFixed(2)}`);

        // Keep top 2 prices that are PPSF neighbors
        const sortedByPrice = [...cleaned].sort((a, b) => b.price - a.price);
        const kept = sortedByPrice.slice(0, 2);
        const dropped = cleaned
          .filter(c => !kept.some(k => k.id === c.id))
          .map(c => ({ id: c.id, reason_codes: ['flat_ppsf_excluded'] }));

        jobLog(`   Kept top 2 prices: ${kept.map(c => `${c.id}($${c.price.toLocaleString()})`).join(', ')}`);
        return this.buildResult('FlatPPSF', kept, dropped, subject.sqft, true);
      }

      // Special case: 3 comps
      if (cleaned.length === 3) {
        return this.handleThreeComps(cleaned, subject.sqft);
      }

      // Step 1: Remove isolated lows using largest gap analysis
      const afterLowFilter = this.removeObviousLows(cleaned);
      jobLog(`📊 After low filter: ${afterLowFilter.length} comparables`);

      if (afterLowFilter.length < 2) {
        return this.insufficientDataResult(afterLowFilter, "Less than 2 comps after filtering lows");
      }

      // Step 2: Try to form a supported high cluster (HighCluster)
      const highClusterResult = this.tryHighCluster(afterLowFilter);

      if (highClusterResult.success) {
        jobLog(`📊 HighCluster found: ${highClusterResult.kept.length} comps`);
        return this.formatResult('HighCluster', highClusterResult, subject.sqft);
      }

      // Step 3: Build CentralUpperChain (fallback)
      jobLog(`📊 No HighCluster found, using CentralUpperChain`);
      const chainResult = this.buildCentralUpperChain(afterLowFilter);

      if (chainResult.kept.length < 2) {
        return this.insufficientDataResult(chainResult.kept, "CentralUpperChain produced less than 2 comps");
      }

      // Step 4: Price isolation guard
      const finalResult = this.applyPriceIsolationGuard(chainResult, afterLowFilter);

      return this.formatResult('CentralUpperChain', finalResult, subject.sqft);

    } catch (error) {
      console.error('ARV Calculation Error:', error);
      return this.insufficientDataResult([], `Error: ${error.message}`);
    }
  }

  /**
   * Helper: Canonicalize street name for deduplication
   */
  canonicalizeStreet(address) {
    if (!address) return '';

    let normalized = address.toLowerCase().trim();

    // Canonicalize street types
    const streetTypes = {
      'st': 'street', 'str': 'street',
      'dr': 'drive', 'drv': 'drive',
      'rd': 'road',
      'ave': 'avenue', 'av': 'avenue',
      'ln': 'lane',
      'ct': 'court',
      'cir': 'circle',
      'blvd': 'boulevard',
      'pkwy': 'parkway',
      'pl': 'place',
      'ter': 'terrace',
      'way': 'way',
      'trl': 'trail'
    };

    // Canonicalize directionals
    const directionals = {
      'n': 'north', 'no': 'north',
      's': 'south', 'so': 'south',
      'e': 'east',
      'w': 'west',
      'ne': 'northeast',
      'nw': 'northwest',
      'se': 'southeast',
      'sw': 'southwest'
    };

    // Replace street types (word boundaries)
    for (const [abbr, full] of Object.entries(streetTypes)) {
      const regex = new RegExp(`\\b${abbr}\\b`, 'g');
      normalized = normalized.replace(regex, full);
    }

    // Replace directionals (word boundaries)
    for (const [abbr, full] of Object.entries(directionals)) {
      const regex = new RegExp(`\\b${abbr}\\b`, 'g');
      normalized = normalized.replace(regex, full);
    }

    // Remove extra spaces
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
  }

  /**
   * Helper: Generate dedup key from address components
   */
  generateDedupKey(comp) {
    // Prefer coordinates if available
    if (comp.lat && comp.lng) {
      return `coord:${Math.round(comp.lat * 1000000)},${Math.round(comp.lng * 1000000)}`;
    }

    // Parse address for line1|zip|unit format
    const address = comp.address || '';
    const parts = address.split(',').map(p => p.trim());

    // Extract components
    let line1 = parts[0] || '';
    let zip = '';
    let unit = '';

    // Try to find ZIP code (5 digits)
    const zipMatch = address.match(/\b(\d{5})\b/);
    if (zipMatch) {
      zip = zipMatch[1];
    }

    // Try to find unit/apt (simplified - look for # or Apt/Unit)
    const unitMatch = address.match(/#\s*(\S+)|(?:apt|unit)\s*(\S+)/i);
    if (unitMatch) {
      unit = (unitMatch[1] || unitMatch[2] || '').toLowerCase();
    }

    // Canonicalize the street address
    const normalized = this.canonicalizeStreet(line1);

    // Return key: normalized_line1|zip|unit
    return `addr:${normalized}|${zip}|${unit}`;
  }

  /**
   * Step 0: Clean and prepare data
   */
  cleanAndPrepare(comparables) {
    jobLog('\n🧹 STEP 0: CLEAN & PREPARE');

    // Filter valid comps (price > 0, sqft > 0)
    let cleaned = comparables.filter(comp => {
      const price = comp.price || comp.comp?.price || 0;
      const sqft = comp.sqft || comp.comp?.sqft || 0;
      return price > 0 && sqft > 0;
    });

    jobLog(`   Valid comps: ${cleaned.length}`);

    // Calculate PPSF and normalize data
    cleaned = cleaned.map((comp, index) => ({
      id: comp.id || `C${index + 1}`,
      address: comp.address || comp.comp?.address || 'Unknown Address',
      price: comp.price || comp.comp?.price,
      sqft: comp.sqft || comp.comp?.sqft,
      ppsf: (comp.price || comp.comp?.price) / (comp.sqft || comp.comp?.sqft),
      saleDate: comp.saleDate || comp.comp?.saleDate || comp.sale_date || '2025-01-01',
      lat: comp.lat || comp.comp?.lat,
      lng: comp.lng || comp.comp?.lng,
      reason: 'included'
    }));

    // Remove duplicates by address (keep most recent)
    const deduped = [];
    const addressMap = new Map();
    const dropped = [];

    for (const comp of cleaned) {
      // Generate canonical dedup key
      const key = this.generateDedupKey(comp);
      jobLog(`   Comp ${comp.id}: key = ${key}`);

      if (!addressMap.has(key)) {
        addressMap.set(key, comp);
        deduped.push(comp);
        jobLog(`   Added ${comp.id}`);
      } else {
        // Keep more recent sale
        const existing = addressMap.get(key);
        jobLog(`   Found duplicate: ${comp.id} matches existing ${existing.id}`);

        const compDate = new Date(comp.saleDate);
        const existingDate = new Date(existing.saleDate);

        if (compDate > existingDate) {
          const index = deduped.findIndex(c => this.generateDedupKey(c) === key);
          if (index !== -1) {
            dropped.push({
              id: existing.id,
              reason_codes: ['dup_address_unit']
            });
            deduped[index] = comp;
            addressMap.set(key, comp);
            jobLog(`   Replaced ${existing.id} with ${comp.id} (newer date)`);
          }
        } else {
          dropped.push({
            id: comp.id,
            reason_codes: ['dup_address_unit']
          });
          jobLog(`   Dropped ${comp.id} (older or same date)`);
        }
      }
    }

    jobLog(`   After dedup: ${deduped.length} comps`);

    // Show cleaned data
    deduped.forEach((comp, i) => {
      jobLog(`   ${i+1}. ${comp.address} - $${comp.ppsf.toFixed(2)}/sqft`);
    });

    return deduped;
  }

  /**
   * Helper: Get upper middle index for top-half floor
   */
  upperMiddleIndex(n) {
    return (n % 2 === 0) ? n / 2 : Math.floor(n / 2);
  }

  /**
   * Step 1: Remove obvious lows using largest gap analysis
   */
  removeObviousLows(comps) {
    jobLog('\n📉 STEP 1: REMOVE OBVIOUS LOWS');

    if (comps.length < 4) {
      jobLog('   Insufficient comps for low removal (need ≥4)');
      return comps;
    }

    // Sort by PPSF
    const sorted = [...comps].sort((a, b) => a.ppsf - b.ppsf);
    jobLog('   Sorted by PPSF:');
    sorted.forEach((comp, i) => {
      jobLog(`   ${i}: ${comp.address} - $${comp.ppsf.toFixed(2)}/sqft`);
    });

    // Calculate adjacent gaps
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      gaps.push(sorted[i + 1].ppsf - sorted[i].ppsf);
    }
    jobLog(`   Gaps: [${gaps.map(g => g.toFixed(2)).join(', ')}]`);

    // Find largest gap
    const maxGapValue = Math.max(...gaps);
    const maxGapIndex = gaps.indexOf(maxGapValue);
    jobLog(`   Largest gap: ${maxGapValue.toFixed(2)} at index ${maxGapIndex}`);

    // If first gap is largest, remove lowest
    if (maxGapIndex === 0) {
      jobLog(`   Removing isolated low: ${sorted[0].address}`);
      const filtered = sorted.slice(1);

      // Check again after removal
      if (filtered.length >= 4) {
        return this.removeObviousLows(filtered);
      }
      return filtered;
    }

    return sorted;
  }

  /**
   * Special handling for 3-comp case
   */
  handleThreeComps(comps, subjectSqft) {
    jobLog('\n🔥 SPECIAL: 3-COMP MODE');

    const sorted = [...comps].sort((a, b) => a.ppsf - b.ppsf);
    const [c1, c2, c3] = sorted;
    const g1 = c2.ppsf - c1.ppsf;
    const g2 = c3.ppsf - c2.ppsf;

    jobLog(`   Sorted: ${c1.id}($${c1.ppsf.toFixed(2)}), ${c2.id}($${c2.ppsf.toFixed(2)}), ${c3.id}($${c3.ppsf.toFixed(2)})`);
    jobLog(`   Gaps: g1=${g1.toFixed(2)}, g2=${g2.toFixed(2)}`);

    // Step 1: obvious low drop
    if (g1 > g2) {
      jobLog(`   First gap (${g1.toFixed(2)}) > second gap (${g2.toFixed(2)}) → drop lowest`);
      const pair = [c2, c3];
      pair.forEach(comp => comp.reason = 'tight_pair');
      const dropped = [{ ...c1, reason_codes: ['obvious_low'] }];
      return this.buildResult('CentralUpperChain', pair, dropped, subjectSqft, true);
    }

    // Step 2: choose tighter pair (tie → upper pair)
    const pair = (g2 <= g1) ? [c2, c3] : [c1, c2];
    const droppedComp = (g2 <= g1) ? c1 : c3;

    jobLog(`   Using tighter pair: ${pair.map(c => c.id).join(', ')}`);
    pair.forEach(comp => comp.reason = 'tight_pair');
    const dropped = [{ ...droppedComp, reason_codes: ['outside_tight_pair'] }];

    return this.buildResult('CentralUpperChain', pair, dropped, subjectSqft, true);
  }

  /**
   * Step 2: Try to form a supported high cluster with improved guardrails
   */
  tryHighCluster(comps) {
    jobLog('\n📈 STEP 2: TRY HIGHCLUSTER (IMPROVED)');

    if (comps.length < 3) {
      jobLog('   Insufficient comps for HighCluster');
      return { success: false };
    }

    // Sort by PPSF ascending for consistent indexing
    const sortedAsc = [...comps].sort((a, b) => a.ppsf - b.ppsf);
    const n = sortedAsc.length;

    // (A) Top-half floor: upper-middle PPSF
    const floorIdx = this.upperMiddleIndex(n);
    const ppsfFloor = sortedAsc[floorIdx].ppsf;
    jobLog(`   (A) Top-half floor: index ${floorIdx}, PPSF >= $${ppsfFloor.toFixed(2)}`);

    // Calculate all gaps
    const gaps = Array.from({length: n-1}, (_, i) => sortedAsc[i+1].ppsf - sortedAsc[i].ppsf);
    const globalLargestGap = Math.max(...gaps);
    jobLog(`   All gaps: [${gaps.map(g => g.toFixed(2)).join(', ')}]`);
    jobLog(`   (B) Global largest gap: ${globalLargestGap.toFixed(2)}`);

    // Build top block from highest PPSF downward
    const block = [];
    for (let i = n - 1; i >= 0; i--) {
      if (sortedAsc[i].ppsf < ppsfFloor) {
        jobLog(`   Stopped at top-half floor: ${sortedAsc[i].id} ($${sortedAsc[i].ppsf.toFixed(2)}) < floor ($${ppsfFloor.toFixed(2)})`);
        break;
      }

      block.push(i);
      jobLog(`   Added to block: ${sortedAsc[i].id} ($${sortedAsc[i].ppsf.toFixed(2)})`);

      // (B) Stop at global largest gap
      if (i - 1 >= 0 && gaps[i - 1] >= globalLargestGap) {
        jobLog(`   Stopped at largest gap: gaps[${i-1}]=${gaps[i-1].toFixed(2)} >= ${globalLargestGap.toFixed(2)}`);
        break;
      }
    }

    block.sort((a, b) => a - b); // ascending indices
    jobLog(`   Block indices: [${block.join(', ')}], size: ${block.length}`);

    if (block.length < 3) {
      jobLog(`   Block too small: ${block.length} comps`);
      return { success: false };
    }

    // (C) Price confirmation within block
    const inBlock = new Set(block);
    const confirmed = block.filter(i => {
      const comp = sortedAsc[i];
      // Find two comps with closest prices
      const others = sortedAsc.map((c, j) => ({ j, d: Math.abs(c.price - comp.price) }))
        .filter(o => o.j !== i);
      others.sort((a, b) => a.d - b.d);
      const a = others[0]?.j;
      const b = others[1]?.j;

      const confirmed = a != null && b != null && inBlock.has(a) && inBlock.has(b);
      jobLog(`   ${comp.id}: closest prices at indices [${a}, ${b}], both in block: ${confirmed}`);
      return confirmed;
    });

    jobLog(`   Confirmed: ${confirmed.length} of ${block.length} comps`);

    // (D) Contiguity check: indices must be sequential with no gaps
    confirmed.sort((a, b) => a - b);
    const isContiguous = confirmed.length > 0 && confirmed.every((idx, i) => {
      if (i === 0) return true;
      return idx === confirmed[i - 1] + 1;
    });

    jobLog(`   Confirmed indices: [${confirmed.join(', ')}], contiguous: ${isContiguous}`);

    if (confirmed.length >= 3 && isContiguous) {
      jobLog(`   ✅ HighCluster formed: ${confirmed.length} confirmed contiguous comps`);

      const kept = confirmed.map(i => ({ ...sortedAsc[i], reason: 'high_cluster_supported' }));
      const dropped = comps.filter(comp => !kept.some(k => k.id === comp.id))
        .map(comp => ({ id: comp.id, reason_codes: ['high_no_support'] }));

      return {
        success: true,
        kept: kept,
        dropped: dropped,
        thin: false
      };
    }

    if (!isContiguous) {
      jobLog(`   ❌ HighCluster failed: confirmed comps not contiguous`);
    } else {
      jobLog(`   ❌ HighCluster failed: only ${confirmed.length} confirmed (need >=3)`);
    }
    return { success: false };
  }

  /**
   * Step 3: Build CentralUpperChain - EXACT ALGORITHM FROM YOUR SPEC
   */
  buildCentralUpperChain(comps) {
    jobLog('\n⚡ STEP 3: CENTRALUPPERCHAIN ALGORITHM');

    // Sort by PPSF ascending
    const sorted = [...comps].sort((a, b) => a.ppsf - b.ppsf);
    const n = sorted.length;

    jobLog(`   Sorted PPSF: ${sorted.map(c => `${c.id} ${c.ppsf.toFixed(2)}`).join(', ')}`);
    jobLog(`   Step A: n = ${n} comps, indices [${Array.from({length: n}, (_, i) => i).join(',')}]`);

    if (n < 2) {
      return { kept: [], dropped: comps.map(c => ({id: c.id, reason_codes: ['insufficient']})), thin: true };
    }

    // Step B: Find upper middle starting point
    const mid = (n % 2 === 0) ? (n / 2) : Math.floor(n / 2);
    jobLog(`   Step B: n=${n} is ${n % 2 === 1 ? 'odd' : 'even'}, so mid = ${mid}`);
    jobLog(`   Starting comp: index ${mid} = ${sorted[mid].id} ($${sorted[mid].ppsf.toFixed(2)}/sqft)`);

    // Step C: Calculate adjacent gaps
    const gaps = Array.from({length: n-1}, (_, i) => sorted[i+1].ppsf - sorted[i].ppsf);
    jobLog(`   Step C: All gaps = [${gaps.map(g => g.toFixed(2)).join(', ')}]`);

    // Max gap in the lower side (strictly below mid)
    const lowerMaxGap = (mid >= 1) ? Math.max(...gaps.slice(0, mid)) : -Infinity;
    jobLog(`   Lower gaps (before mid=${mid}): [${gaps.slice(0, mid).map(g => g.toFixed(2)).join(', ')}]`);
    jobLog(`   lowerMaxGap = ${lowerMaxGap === -Infinity ? '-Infinity' : lowerMaxGap.toFixed(2)}`);

    // Step D: Build contiguous upward chain from mid
    jobLog(`   Step D: Building chain from mid=${mid}`);
    const keptIdx = [mid];
    jobLog(`   - chain = [${mid}] (${sorted[mid].id})`);

    for (let i = mid; i < n - 1; i++) {
      const g = gaps[i];
      jobLog(`   - i=${i}: check gaps[${i}]=${g.toFixed(2)} vs lowerMaxGap=${lowerMaxGap === -Infinity ? '-Infinity' : lowerMaxGap.toFixed(2)}`);

      if (g >= lowerMaxGap) {
        jobLog(`     Since ${g.toFixed(2)} >= ${lowerMaxGap === -Infinity ? '-Infinity' : lowerMaxGap.toFixed(2)}, STOP (large jump)`);
        break;
      }

      keptIdx.push(i + 1);
      jobLog(`     Since ${g.toFixed(2)} < ${lowerMaxGap.toFixed(2)}, ADD index ${i + 1}`);
      jobLog(`   - chain = [${keptIdx.join(',')}] (${keptIdx.map(idx => sorted[idx].id).join(', ')})`);
    }

    // Step E: Two-comp rescue if chain length = 1
    if (keptIdx.length === 1) {
      jobLog(`   Step E: Chain length = 1, activating two-comp rescue`);

      // Find tightest adjacent pair
      let bestPair = null;
      let bestGap = Infinity;

      for (let i = 0; i < n - 1; i++) {
        const gap = gaps[i];
        if (gap < bestGap || (gap === bestGap && i > (bestPair?.start || -1))) {
          bestPair = { start: i, gap };
          bestGap = gap;
        }
      }

      if (bestPair) {
        const pairIndices = [bestPair.start, bestPair.start + 1];
        jobLog(`   Tightest pair: indices [${pairIndices.join(', ')}], gap ${bestGap.toFixed(2)}`);

        const kept = pairIndices.map(i => ({ ...sorted[i], reason: 'two_comp_rescue' }));
        const keptIds = new Set(pairIndices);
        const dropped = sorted
          .map((c, i) => keptIds.has(i) ? null : { id: c.id, reason_codes: ['outside_rescue_pair'] })
          .filter(Boolean);

        jobLog(`   Rescue pair: ${kept.map(c => `${c.id}($${c.ppsf.toFixed(2)})`).join(', ')}`);
        jobLog(`   Thin market: true`);

        return { kept, dropped, thin: true };
      }
    }

    // Step F: Format results (normal path)
    const kept = keptIdx.map(i => ({ ...sorted[i], reason: 'central_upper_chain' }));
    const keptIds = new Set(keptIdx);
    const dropped = sorted
      .map((c, i) => keptIds.has(i) ? null : { id: c.id, reason_codes: ['outside_chain'] })
      .filter(Boolean);

    const thin = kept.length < 3;

    jobLog(`   Final chain indices: [${keptIdx.join(',')}]`);
    jobLog(`   Final chain comps: ${kept.map(c => `${c.id}($${c.ppsf.toFixed(2)})`).join(', ')}`);
    jobLog(`   Thin market: ${thin}`);

    return { kept, dropped, thin };
  }

  /**
   * Step 4: Price isolation guard
   */
  applyPriceIsolationGuard(chainResult, allComps) {
    jobLog('\n🛡️ STEP 4: PRICE ISOLATION GUARD');

    const { kept, dropped } = chainResult;

    if (!kept || kept.length <= 2) {
      jobLog('   Skipping isolation guard (≤2 comps, thin market protection)');
      return chainResult;
    }

    const keptSet = new Set(kept.map(c => c.id));
    const finalKept = [];
    const additionalDropped = [];

    for (const comp of kept) {
      // Find TWO closest prices among ALL comps (not just kept)
      const closestTwo = allComps
        .filter(c => c.id !== comp.id)
        .map(c => ({ id: c.id, diff: Math.abs(c.price - comp.price) }))
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 2);

      const bothInKept = closestTwo.length === 2 && closestTwo.every(x => keptSet.has(x.id));

      if (bothInKept) {
        finalKept.push(comp);
        jobLog(`   ${comp.id} kept (both closest neighbors in kept set)`);
      } else {
        const remainingIfDropped = finalKept.length + (kept.length - (finalKept.length + additionalDropped.length) - 1);
        const wouldStillHave2OrMore = remainingIfDropped >= 2;
        if (wouldStillHave2OrMore) {
          additionalDropped.push({ id: comp.id, reason_codes: ['high_price_isolated'] });
          jobLog(`   ${comp.id} dropped (price isolated - closest neighbors not both in kept)`);
        } else {
          finalKept.push(comp);
          jobLog(`   ${comp.id} kept despite isolation (thin market protection)`);
        }
      }
    }

    return {
      ...chainResult,
      kept: finalKept,
      dropped: [...(dropped || []), ...additionalDropped],
    };
  }

  /**
   * Build result helper - creates chainResult structure for formatResult
   */
  buildResult(method, kept, dropped, subjectSqft, thin = false) {
    const chainResult = {
      kept: kept,
      dropped: dropped,
      thin: thin
    };
    return this.formatResult(method, chainResult, subjectSqft);
  }

  /**
   * Format final result
   */
  formatResult(method, chainResult, subjectSqft) {
    jobLog('\n💰 CALCULATING FINAL ARV');

    if (!chainResult || !chainResult.kept) {
      console.error('Invalid chainResult:', chainResult);
      return this.insufficientDataResult([], 'Invalid chain result');
    }

    const { kept, dropped, thin } = chainResult;

    // FIX #8: Validate all drops have reason_codes
    this.validateDropReasons(dropped);

    // Calculate median PPSF
    const ppsfValues = kept.map(comp => comp.ppsf).sort((a, b) => a - b);
    jobLog(`   PPSF values: [${ppsfValues.map(p => p.toFixed(2)).join(', ')}]`);

    let medianPpsf;
    if (ppsfValues.length % 2 === 1) {
      medianPpsf = ppsfValues[Math.floor(ppsfValues.length / 2)];
      jobLog(`   Median (odd count): $${medianPpsf.toFixed(2)}/sqft`);
    } else {
      const mid1 = ppsfValues[ppsfValues.length / 2 - 1];
      const mid2 = ppsfValues[ppsfValues.length / 2];
      medianPpsf = (mid1 + mid2) / 2;
      jobLog(`   Median (even count): ($${mid1.toFixed(2)} + $${mid2.toFixed(2)}) / 2 = $${medianPpsf.toFixed(2)}/sqft`);
    }

    const arvPrice = Math.round(medianPpsf * subjectSqft);
    jobLog(`   ARV = $${medianPpsf.toFixed(2)}/sqft × ${subjectSqft} sqft = $${arvPrice.toLocaleString()}`);

    const result = {
      arv_ppsf: medianPpsf,
      arv_price: arvPrice,
      comp_ids: kept.map(comp => comp.id)
    };

    return {
      method_used: method,
      kept_comps: kept.map(comp => ({
        id: comp.id,
        address: comp.address,
        price: comp.price,
        sqft: comp.sqft,
        ppsf: comp.ppsf,
        reason: comp.reason
      })),
      dropped_comps: dropped,
      // FIX #7: Aggressive = HighCluster, Conservative = CentralUpperChain
      aggressive: method === 'HighCluster' ? result : {
        ...result,
        no_high_cluster: true
      },
      conservative: method === 'HighCluster' ? {
        ...result,
        no_high_cluster: true
      } : result,
      flags: {
        thin_market: thin,
        mixed_types: false
      },
      notes: `Applied ${method} methodology. ${kept.length} comps used for ARV calculation.`
    };
  }

  /**
   * Validate drop reason codes (Fix #8)
   */
  validateDropReasons(dropped) {
    const missingReasons = dropped.filter(d => !d.reason_codes || d.reason_codes.length === 0);
    if (missingReasons.length > 0) {
      console.error('⚠️ ASSERTION FAILED: Dropped comps missing reason_codes:', missingReasons);
      throw new Error(`${missingReasons.length} dropped comps missing reason_codes`);
    }
  }

  /**
   * Handle insufficient data cases
   */
  insufficientDataResult(comps, reason) {
    return {
      method_used: 'insufficient_data',
      kept_comps: [],
      dropped_comps: comps.map(comp => ({
        id: comp.id || 'unknown',
        reason_codes: ['insufficient_data']
      })),
      conservative: {
        arv_ppsf: 0,
        arv_price: 0,
        comp_ids: []
      },
      aggressive: {
        arv_ppsf: 0,
        arv_price: 0,
        comp_ids: [],
        no_high_cluster: true
      },
      flags: {
        thin_market: true,
        mixed_types: false
      },
      notes: `Insufficient data: ${reason}`
    };
  }
}