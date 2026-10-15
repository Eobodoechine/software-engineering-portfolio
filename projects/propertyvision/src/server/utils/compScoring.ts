// Comparable Property Scoring and Deduplication
// Used for top-K selection and early deduplication

export interface ComparableProperty {
  address: string;
  price?: number;
  sqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number | null;
  soldDate?: string;
  distance?: number;
  distanceMi?: number;
  source?: string;
  searchId?: string;
  confidence?: 'high' | 'medium' | 'low';
  lat?: number;
  lon?: number;
  subdivision?: string;
  propertyType?: string;
  [key: string]: any;
}

export interface SubjectProperty {
  address: string;
  sqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number;
  subdivision?: string;
  propertyType?: string;
  lat?: number;
  lon?: number;
}

/**
 * Generate deduplication key for a property
 * Priority: MLS ID > Normalized address
 */
export function dedupeKey(comp: ComparableProperty): string {
  try {
    // Try MLS ID first (most reliable)
    if (comp.searchId) {
      return `mls:${comp.searchId}`;
    }

    // Fall back to normalized address
    const normalized = normalizeAddress(comp.address);
    return `addr:${normalized}`;
  } catch (error) {
    console.error(`❌ DEDUPE KEY ERROR for comp:`, comp);
    console.error(`   Error:`, error);
    // Fallback to raw address
    return `raw:${comp.address || 'unknown'}`;
  }
}

/**
 * Normalize address for deduplication
 */
export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .trim()
    // Remove punctuation except commas and hashes
    .replace(/[^\w\s,#]/g, '')
    // Normalize common abbreviations
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bcircle\b/g, 'cir')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bplace\b/g, 'pl')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score a comparable property (lower is better)
 * Used for top-K selection
 */
export function scoreComparable(comp: ComparableProperty, subject: SubjectProperty): number {
  try {
    let score = 0;

    // Distance penalty (most important)
    const distance = comp.distanceMi ?? comp.distance ?? 99;
    score += distance * 10; // 10 points per mile

    // Bedroom variance penalty
    if (comp.beds && subject.beds) {
      const bedsDelta = Math.abs(comp.beds - subject.beds);
      score += bedsDelta * 5; // 5 points per bedroom difference
    }

    // Square footage variance penalty (percentage)
    if (comp.sqft && subject.sqft) {
      const sqftDelta = Math.abs(comp.sqft - subject.sqft);
      const sqftPct = sqftDelta / subject.sqft;
      score += sqftPct * 20; // 20 points for 100% difference
    }

    // Recency penalty (older sales are less relevant)
    if (comp.soldDate) {
      const monthsAgo = getMonthsAgo(comp.soldDate);
      score += monthsAgo * 0.5; // 0.5 points per month
    }

    // Bonuses (reduce score)
    if (comp.subdivision && subject.subdivision && comp.subdivision === subject.subdivision) {
      score -= 10; // Same subdivision bonus
    }

    if (comp.propertyType && subject.propertyType && comp.propertyType === subject.propertyType) {
      score -= 5; // Same property type bonus
    }

    // Confidence penalty
    if (comp.confidence === 'low') {
      score += 15;
    } else if (comp.confidence === 'medium') {
      score += 5;
    }

    return score;
  } catch (error) {
    console.error(`❌ SCORE COMPARABLE ERROR for comp:`, comp);
    console.error(`   Subject:`, subject);
    console.error(`   Error:`, error);
    // Return high score to deprioritize problematic comps
    return 999;
  }
}

/**
 * Get months ago from date string
 */
function getMonthsAgo(dateStr: string): number {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30);
    return Math.max(0, diffMonths);
  } catch (error) {
    console.error(`❌ GET MONTHS AGO ERROR for date "${dateStr}":`, error);
    return 999; // Very old
  }
}

/**
 * Merge two comparable properties (when deduplicating)
 * Keep the more complete record
 */
export function mergeComparables(a: ComparableProperty, b: ComparableProperty): ComparableProperty {
  try {
    // Count non-null fields in each
    const scoreA = countFields(a);
    const scoreB = countFields(b);

    // Keep the more complete record as base
    const base = scoreA >= scoreB ? a : b;
    const other = scoreA >= scoreB ? b : a;

    // Merge: base wins, but fill nulls from other
    return {
      ...base,
      // Fill missing fields from other record
      price: base.price ?? other.price,
      sqft: base.sqft ?? other.sqft,
      beds: base.beds ?? other.beds,
      baths: base.baths ?? other.baths,
      yearBuilt: base.yearBuilt ?? other.yearBuilt,
      soldDate: base.soldDate ?? other.soldDate,
      distance: base.distance ?? other.distance,
      distanceMi: base.distanceMi ?? other.distanceMi,
      lat: base.lat ?? other.lat,
      lon: base.lon ?? other.lon,
      subdivision: base.subdivision ?? other.subdivision,
      propertyType: base.propertyType ?? other.propertyType,
      source: base.source ?? other.source,
    };
  } catch (error) {
    console.error(`❌ MERGE COMPARABLES ERROR:`, error);
    console.error(`   Comp A:`, a);
    console.error(`   Comp B:`, b);
    // Return first comp on error
    return a;
  }
}

/**
 * Count non-null fields in a comp
 */
function countFields(comp: ComparableProperty): number {
  let count = 0;
  const fields = ['price', 'sqft', 'beds', 'baths', 'yearBuilt', 'soldDate', 'lat', 'lon', 'subdivision', 'propertyType'];

  for (const field of fields) {
    if (comp[field] != null && comp[field] !== '') {
      count++;
    }
  }

  return count;
}
