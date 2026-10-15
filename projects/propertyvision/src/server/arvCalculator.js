// Complete ARV Calculator - New numeric, upper-biased method
// - Log-gap banding with z-score edges (n >= 4)
// - Price support = at least 1 closest-by-price inside the band
// - Upper-half window fallback (start at floor(n/2)-1), pairs first, then triplets
// - If none, global tightest adjacent pair by relative gap
// - n==3: pick tighter relative-gap pair; tie -> upper pair
// - n==2: keep both
// - Flat-PPSF: top-2 by price

import { jobLog } from './utils/jobLogger';

export class ARVCalculator {

  calculateARV(subject, comparables) {
    jobLog(`🧮 CALCULATING ARV FOR ${subject.sqft} SQFT PROPERTY`);
    jobLog(`📊 Input: ${comparables.length} comparables`);

    try {
      // STEP 0: Clean & prepare
      const cleaned = this.cleanAndPrepare(comparables);
      jobLog(`📊 After cleaning: ${cleaned.length} comparables`);
      if (cleaned.length < 2) {
        return this.insufficientDataResult(cleaned, "Less than 2 valid comparables");
      }

      // SPECIAL: FLAT PPSF (all values essentially equal)
      const sortedByPpsf = [...cleaned].sort((a,b)=>a.ppsf-b.ppsf);
      const ppsfVals = sortedByPpsf.map(c=>c.ppsf);
      const eps = this.smallestNonZeroGap(ppsfVals); // computed on sorted!
      const minP = ppsfVals[0], maxP = ppsfVals[ppsfVals.length-1];

      if ((maxP - minP) < (eps || 1)) {
        jobLog('\n📊 SPECIAL: FLAT-PPSF MODE');
        jobLog(`   epsilon=${(eps||1).toFixed(4)} range=${(maxP-minP).toFixed(4)}`);
        const kept = [...cleaned].sort((a,b)=>b.price-a.price).slice(0,2).map(k => ({...k, reason:'flat_ppsf_top2'}));
        const keptIds = new Set(kept.map(k=>k.id));
        const dropped = cleaned.filter(c=>!keptIds.has(c.id)).map(c=>({id:c.id, reason_codes:['flat_ppsf_excluded']}));
        return this.formatResult('FlatPPSF', {kept, dropped, thin:true}, subject.sqft);
      }

      // n == 2
      if (cleaned.length === 2) {
        const kept = cleaned.map(c => ({...c, reason:'two_comp_all'}));
        const dropped = [];
        return this.formatResult('TwoComp', {kept, dropped, thin:true}, subject.sqft);
      }

      // n == 3  (simple, stable)
      if (cleaned.length === 3) {
        return this.handleThreeComps_New(cleaned, subject.sqft);
      }

      // n >= 4 -> New banding + support + upper-biased fallback
      const resultN4 = this.selectN4Plus(cleaned);
      if (resultN4.kept.length >= 2) {
        return this.formatResult(resultN4.method, resultN4, subject.sqft);
      }

      // If somehow not enough (shouldn't happen), fall back to global tightest pair
      const lastResort = this.globalTightestPair(cleaned);
      return this.formatResult('GlobalTightPair', lastResort, subject.sqft);

    } catch (error) {
      console.error('ARV Calculation Error:', error);
      return this.insufficientDataResult([], `Error: ${error.message}`);
    }
  }

  /* ───────────────────────────── Helpers / Core Pieces ───────────────────────────── */

  canonicalizeStreet(address) {
    if (!address) return '';
    let normalized = address.toLowerCase().trim();

    const streetTypes = {
      'st':'street','str':'street',
      'dr':'drive','drv':'drive',
      'rd':'road','ave':'avenue','av':'avenue',
      'ln':'lane','ct':'court','cir':'circle',
      'blvd':'boulevard','pkwy':'parkway','pl':'place',
      'ter':'terrace','way':'way','trl':'trail'
    };
    const directionals = {
      'n':'north','no':'north','s':'south','so':'south',
      'e':'east','w':'west','ne':'northeast','nw':'northwest',
      'se':'southeast','sw':'southwest'
    };

    for (const [abbr,full] of Object.entries(streetTypes)) {
      normalized = normalized.replace(new RegExp(`\\b${abbr}\\b`, 'g'), full);
    }
    for (const [abbr,full] of Object.entries(directionals)) {
      normalized = normalized.replace(new RegExp(`\\b${abbr}\\b`, 'g'), full);
    }
    return normalized.replace(/\s+/g,' ').trim();
  }

  generateDedupKey(comp) {
    const address = comp.address || '';
    const unitMatch = address.match(/#\s*(\S+)|(?:apt|unit)\s*(\S+)/i);
    const unit = (unitMatch ? (unitMatch[1]||unitMatch[2]||'') : '').toLowerCase();

    // Comparables arrive as `lon`; reading only `lng` made this branch unreachable, so the
    // same sale counted twice when search phrased it as "Audubon Dr NE" and "Audubon Dr".
    const lng = comp.lng ?? comp.lon;
    if (comp.lat && lng) {
      return `coord:${Math.round(comp.lat*1e6)},${Math.round(lng*1e6)}|${unit}`;
    }

    const parts = address.split(',').map(p=>p.trim());
    const line1 = parts[0] || '';
    const zipMatch = address.match(/\b(\d{5})\b/);
    const zip = zipMatch ? zipMatch[1] : '';
    const normalized = this.canonicalizeStreet(line1);
    return `addr:${normalized}|${zip}|${unit}`;
  }

  cleanAndPrepare(comparables) {
    jobLog('\n🧹 STEP 0: CLEAN & PREPARE');
    let cleaned = comparables.filter(c=>{
      const price = c.price || c.comp?.price || 0;
      const sqft  = c.sqft  || c.comp?.sqft  || 0;
      return price>0 && sqft>0;
    });

    jobLog(`   Valid comps: ${cleaned.length}`);

    cleaned = cleaned.map((c,idx)=>({
      id: c.id || `C${idx+1}`,
      address: c.address || c.comp?.address || 'Unknown Address',
      price: c.price || c.comp?.price,
      sqft: c.sqft || c.comp?.sqft,
      ppsf: (c.price || c.comp?.price) / (c.sqft || c.comp?.sqft),
      saleDate: c.saleDate || c.comp?.saleDate || c.sale_date || '2025-01-01',
      lat: c.lat ?? c.comp?.lat,
      lng: c.lng ?? c.lon ?? c.comp?.lng ?? c.comp?.lon,
      reason: 'included'
    }));

    // Dedup by canonical key, keep most-recent sale
    const deduped = [];
    const addrMap = new Map();
    const dropped = [];

    for (const comp of cleaned) {
      const key = this.generateDedupKey(comp);
      jobLog(`   Comp ${comp.id}: key = ${key}`);
      if (!addrMap.has(key)) {
        addrMap.set(key, comp);
        deduped.push(comp);
        jobLog(`   Added ${comp.id}`);
      } else {
        const existing = addrMap.get(key);
        const compDate = new Date(comp.saleDate);
        const existingDate = new Date(existing.saleDate);
        if (compDate > existingDate) {
          const replIdx = deduped.findIndex(c => this.generateDedupKey(c)===key);
          if (replIdx!==-1) {
            dropped.push({id: existing.id, reason_codes:['dup_address_unit']});
            deduped[replIdx] = comp;
            addrMap.set(key, comp);
            jobLog(`   Replaced ${existing.id} with ${comp.id} (newer)`);
          }
        } else {
          dropped.push({id: comp.id, reason_codes:['dup_address_unit']});
          jobLog(`   Dropped ${comp.id} (older/same date)`);
        }
      }
    }

    jobLog(`   After dedup: ${deduped.length} comps`);
    deduped.forEach((c,i)=>jobLog(`   ${i+1}. ${c.address} - $${c.ppsf.toFixed(2)}/sqft`));
    return deduped;
  }

  smallestNonZeroGap(values) {
    if (!values || values.length < 2) return 0;
    const v = [...values].sort((a,b)=>a-b);
    let best = Infinity;
    for (let i=0;i<v.length-1;i++) {
      const g = v[i+1]-v[i];
      if (g>0 && g<best) best=g;
    }
    return best===Infinity ? 0 : best;
  }

  /* ---------- n == 3: stable rule (relative gaps; tie -> upper pair) ---------- */
  handleThreeComps_New(comps, subjectSqft) {
    jobLog('\n🔥 SPECIAL: 3-COMP MODE (relative-gap)');
    const s = [...comps].sort((a,b)=>a.ppsf-b.ppsf);
    const [c1,c2,c3] = s;
    const g1Rel = (c2.ppsf - c1.ppsf) / c1.ppsf;
    const g2Rel = (c3.ppsf - c2.ppsf) / c2.ppsf;
    jobLog(`   Sorted PPSF: [${s.map(c=>c.ppsf.toFixed(2)).join(', ')}]`);
    jobLog(`   Relative gaps: g1=${g1Rel.toFixed(4)}, g2=${g2Rel.toFixed(4)}`);

    let pair;
    let dropped;
    if (g2Rel <= g1Rel) { // upper pair if tie
      pair = [ {...c2,reason:'three_comp_tight'}, {...c3,reason:'three_comp_tight'} ];
      dropped = [{id:c1.id, reason_codes:['outside_tight_pair']}];
    } else {
      pair = [ {...c1,reason:'three_comp_tight'}, {...c2,reason:'three_comp_tight'} ];
      dropped = [{id:c3.id, reason_codes:['outside_tight_pair']}];
    }
    return this.formatResult('ThreeComp', {kept:pair, dropped, thin:true}, subjectSqft);
  }

  /* ---------- n >= 4: banding + support + upper-biased fallback ---------- */

  selectN4Plus(comps) {
    jobLog('\n📈 STEP: BANDING on log(PPSF) with z-score edges');
    const sorted = [...comps].sort((a,b)=>a.ppsf-b.ppsf);
    const n = sorted.length;

    // Build log PPSF and gaps
    const logs = sorted.map(c=>Math.log(c.ppsf));
    const gaps = Array.from({length:n-1}, (_,i)=> logs[i+1]-logs[i]);
    const gapMean = gaps.reduce((s,g)=>s+g,0) / gaps.length;
    const gapVar  = gaps.reduce((s,g)=>s+(g-gapMean)*(g-gapMean),0) / gaps.length;
    const gapStd  = Math.sqrt(gapVar);
    const z = gaps.map(g=> gapStd>0 ? (g-gapMean)/gapStd : 0);

    jobLog(`   PPSF: [${sorted.map(c=>c.ppsf.toFixed(2)).join(', ')}]`);
    jobLog(`   log-gaps z: [${z.map(x=>x.toFixed(2)).join(', ')}]`);

    // Acceptable edge: z <= 1.0
    const accept = z.map(v => v <= 1.0);

    // Build maximal contiguous bands of acceptable edges
    // Band is a run of indices [a..b] in terms of comps; edges true between each adjacent.
    const bands = [];
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n-1 && accept[j]) j++;
      const size = (j - i + 1); // number of comps in this band
      if (size >= 2) bands.push({start:i, end:j});
      i = j + 1;
    }

    jobLog(`   Bands (start..end): ${bands.map(b=>`[${b.start}..${b.end}]`).join(' | ') || '(none)'}`);

    // Upper-bias: pick highest band (largest end) with length >= 2 that passes price support
    const bandsSortedUpper = [...bands].sort((a,b)=> (b.end - a.end) || (b.start - a.start));

    const supportedBand = bandsSortedUpper.find(b => this.bandHasPriceSupport(sorted, b));
    if (supportedBand) {
      const kept = this.bandToComps(sorted, supportedBand, 'band_supported');
      const keptIds = new Set(kept.map(k=>k.id));
      const dropped = sorted.filter(c=>!keptIds.has(c.id)).map(c=>({id:c.id, reason_codes:['outside_band']}));
      jobLog(`   ✅ Using supported band [${supportedBand.start}..${supportedBand.end}]`);
      return { method:'Banding', kept, dropped, thin: kept.length<3 };
    }

    // If no band passes support, try ANY band (uppermost) with length >=2 (softer gate)
    const anyBand = bandsSortedUpper[0];
    if (anyBand) {
      jobLog(`   ⚠️ No band passed price-support. Using uppermost band anyway.`);
      const kept = this.bandToComps(sorted, anyBand, 'band_no_support_fallback');
      const keptIds = new Set(kept.map(k=>k.id));
      const dropped = sorted.filter(c=>!keptIds.has(c.id)).map(c=>({id:c.id, reason_codes:['outside_band']}));
      return { method:'BandingNoSupport', kept, dropped, thin: kept.length<3 };
    }

    // No bands (all edges "big") → Upper-half window fallback (pairs first, then triplets)
    return this.upperWindowFallback(sorted, gaps);
  }

  bandToComps(sorted, band, reason) {
    const out = [];
    for (let i=band.start;i<=band.end;i++) out.push({...sorted[i], reason});
    return out;
  }

  // Price support = each comp has at least ONE closest-by-price neighbor that is inside the band
  bandHasPriceSupport(sorted, band) {
    const inBand = new Set();
    for (let i=band.start;i<=band.end;i++) inBand.add(i);

    for (let i=band.start;i<=band.end;i++) {
      const base = sorted[i];
      // Two nearest by absolute PRICE among ALL comps
      const closest = sorted
        .map((c,j)=>({j, d: Math.abs(c.price - base.price)}))
        .filter(o=>o.j!==i)
        .sort((a,b)=>a.d-b.d)
        .slice(0,2);

      // At least one of the two must be inside the band
      const ok = closest.some(c => inBand.has(c.j));
      if (!ok) {
        jobLog(`     No price support for index ${i} (${base.id}) -> outside neighbors: [${closest.map(c=>c.j).join(', ')}]`);
        return false;
      }
    }
    return true;
  }

  /* ---------- Upper window fallback (pairs then triplets), then global tightest ---------- */

  upperWindowFallback(sorted, gaps) {
    jobLog('\n↗️  Upper window fallback (pairs, then triplets)');
    const n = sorted.length;
    const start = Math.max(0, Math.floor(n/2) - 1); // FIX: allow i >= floor(n/2) - 1
    jobLog(`   Window starts at index ${start}`);

    // Soft support for a pair: edge gap not an extreme outlier relative to all gaps (z<=1.0 on log gaps),
    // or mutual nearest-by-PPSF.
    const logs = sorted.map(c=>Math.log(c.ppsf));
    const logGaps = Array.from({length:n-1}, (_,i)=> logs[i+1]-logs[i]);
    const m = logGaps.reduce((s,g)=>s+g,0)/logGaps.length;
    const sv= logGaps.reduce((s,g)=>s+(g-m)*(g-m),0)/logGaps.length;
    const sd= Math.sqrt(sv);

    const relGap = (i)=> (sorted[i+1].ppsf - sorted[i].ppsf) / sorted[i].ppsf;

    const isSoftSupportedPair = (i)=>{
      const zVal = sd>0 ? (logGaps[i]-m)/sd : 0;
      if (zVal <= 1.0) return true;
      // mutual nearest-by-PPSF
      const leftNearest  = this.nearestIndexByPpsf(sorted, i);
      const rightNearest = this.nearestIndexByPpsf(sorted, i+1);
      return (leftNearest === (i+1)) && (rightNearest === i);
    };

    // 1) Upper-half tightest pair WITH soft support
    const pairCandidates = [];
    for (let i=start;i<=n-2;i++) {
      if (isSoftSupportedPair(i)) {
        pairCandidates.push({i, rg: relGap(i)});
      }
    }
    pairCandidates.sort((a,b)=> (a.rg - b.rg) || (b.i - a.i)); // smallest rel gap, tie -> upper
    if (pairCandidates.length) {
      const i0 = pairCandidates[0].i;
      const kept = [ {...sorted[i0],reason:'upper_pair'}, {...sorted[i0+1],reason:'upper_pair'} ];
      const keptIds = new Set([sorted[i0].id, sorted[i0+1].id]);
      const dropped = sorted.filter(c=>!keptIds.has(c.id)).map(c=>({id:c.id, reason_codes:['outside_upper_window']}));
      jobLog(`   ✅ Upper pair selected at [${i0}, ${i0+1}]`);
      return { method:'UpperPair', kept, dropped, thin:true };
    }

    // 2) Upper-half triplet (check both edges moderate by rel gap, choose smallest max-edge)
    const tripCandidates = [];
    for (let i=start;i<=n-3;i++) {
      const r1 = relGap(i), r2 = relGap(i+1);
      const maxR = Math.max(r1,r2);
      tripCandidates.push({i, maxR});
    }
    tripCandidates.sort((a,b)=> (a.maxR - b.maxR) || (b.i - a.i));
    if (tripCandidates.length) {
      const i0 = tripCandidates[0].i;
      const kept = [ {...sorted[i0],reason:'upper_triplet'}, {...sorted[i0+1],reason:'upper_triplet'}, {...sorted[i0+2],reason:'upper_triplet'} ];
      const keptIds = new Set([sorted[i0].id, sorted[i0+1].id, sorted[i0+2].id]);
      const dropped = sorted.filter(c=>!keptIds.has(c.id)).map(c=>({id:c.id, reason_codes:['outside_upper_window']}));
      jobLog(`   ✅ Upper triplet selected at [${i0}..${i0+2}]`);
      return { method:'UpperTriplet', kept, dropped, thin: kept.length<3 };
    }

    jobLog(`   ⚠️ No upper window selection; using global tightest pair`);
    return this.globalTightestPair(sorted);
  }

  nearestIndexByPpsf(sorted, idx) {
    const base = sorted[idx].ppsf;
    let best = -1, bestD = Infinity;
    for (let j=0;j<sorted.length;j++) {
      if (j!==idx) {
        const d = Math.abs(sorted[j].ppsf - base);
        if (d < bestD) { bestD=d; best=j; }
      }
    }
    return best;
  }

  globalTightestPair(sorted) {
    const n = sorted.length;
    let bestI = 0, bestRG = Infinity;
    for (let i=0;i<n-1;i++) {
      const rg = (sorted[i+1].ppsf - sorted[i].ppsf) / sorted[i].ppsf;
      if (rg < bestRG || (rg===bestRG && i>bestI)) { bestRG = rg; bestI = i; }
    }
    const kept = [ {...sorted[bestI],reason:'global_tight_pair'}, {...sorted[bestI+1],reason:'global_tight_pair'} ];
    const keptIds = new Set([sorted[bestI].id, sorted[bestI+1].id]);
    const dropped = sorted.filter(c=>!keptIds.has(c.id)).map(c=>({id:c.id, reason_codes:['outside_tight_pair']}));
    return { method:'GlobalTightPair', kept, dropped, thin:true };
  }

  /* ───────────────────────────── Result/Output helpers ───────────────────────────── */

  buildResult(method, kept, dropped, subjectSqft, thin=false) {
    const chainResult = { kept, dropped, thin };
    return this.formatResult(method, chainResult, subjectSqft);
  }

  formatResult(method, chainResult, subjectSqft) {
    jobLog('\n💰 CALCULATING FINAL ARV');
    if (!chainResult || !chainResult.kept) {
      console.error('Invalid chainResult:', chainResult);
      return this.insufficientDataResult([], 'Invalid chain result');
    }

    const { kept, dropped, thin } = chainResult;

    // Ensure every drop has a reason code
    this.validateDropReasons(dropped || []);

    const ppsfValues = kept.map(c=>c.ppsf).sort((a,b)=>a-b);
    jobLog(`   PPSF values: [${ppsfValues.map(x=>x.toFixed(2)).join(', ')}]`);

    let medianPpsf;
    if (ppsfValues.length % 2) {
      medianPpsf = ppsfValues[Math.floor(ppsfValues.length/2)];
      jobLog(`   Median (odd): $${medianPpsf.toFixed(2)}/sqft`);
    } else {
      const a = ppsfValues[ppsfValues.length/2 - 1];
      const b = ppsfValues[ppsfValues.length/2];
      medianPpsf = (a+b)/2;
      jobLog(`   Median (even): ($${a.toFixed(2)} + $${b.toFixed(2)}) / 2 = $${medianPpsf.toFixed(2)}/sqft`);
    }

    const arvPrice = Math.round(medianPpsf * subjectSqft);
    jobLog(`   ARV = $${medianPpsf.toFixed(2)}/sqft × ${subjectSqft} sqft = $${arvPrice.toLocaleString()}`);

    const base = {
      arv_ppsf: medianPpsf,
      arv_price: arvPrice,
      comp_ids: kept.map(k=>k.id)
    };

    return {
      method_used: method,
      kept_comps: kept.map(k=>({id:k.id,address:k.address,price:k.price,sqft:k.sqft,ppsf:k.ppsf,reason:k.reason})),
      dropped_comps: dropped || [],
      aggressive: { ...base, no_high_cluster: true },
      conservative: base,
      flags: { thin_market: thin, mixed_types: false },
      notes: `Applied ${method}. ${kept.length} comps used for ARV calculation.`
    };
  }

  validateDropReasons(dropped) {
    const missing = dropped.filter(d=>!d.reason_codes || d.reason_codes.length===0);
    if (missing.length>0) throw new Error(`${missing.length} dropped comps missing reason_codes`);
  }

  insufficientDataResult(comps, reason) {
    return {
      method_used: 'insufficient_data',
      kept_comps: [],
      dropped_comps: (comps||[]).map(c=>({id:c.id||'unknown', reason_codes:['insufficient_data']})),
      conservative: { arv_ppsf:0, arv_price:0, comp_ids:[] },
      aggressive:   { arv_ppsf:0, arv_price:0, comp_ids:[], no_high_cluster:true },
      flags: { thin_market:true, mixed_types:false },
      notes: `Insufficient data: ${reason}`
    };
  }
}
