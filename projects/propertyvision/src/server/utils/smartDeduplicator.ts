// Smart Deduplication with Intelligent Conflict Resolution
// Replaces simple address-based deduplication with composite key matching

interface PropertyData {
  address: string;
  price?: number;
  sqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number | null;
  soldDate?: string;
  distance?: number;
  source?: string;
  searchId?: string; // Track which search found this property
  confidence?: 'high' | 'medium' | 'low';
  [key: string]: any;
}

interface DeduplicationKey {
  normalizedAddress: string;
  priceRange: string; // Group prices within 5% ranges
  sizeRange: string; // Group sqft within 10% ranges
}

interface DuplicateGroup {
  key: DeduplicationKey;
  properties: PropertyData[];
  merged: PropertyData;
  confidence: 'high' | 'medium' | 'low';
  conflicts: Array<{
    field: string;
    values: any[];
    resolution: any;
    method: string;
  }>;
}

export class SmartDeduplicator {
  private duplicateGroups = new Map<string, DuplicateGroup>();
  private processedProperties = new Set<string>();

  /**
   * Normalize address for comparison
   */
  private normalizeAddress(address: string): string {
    return address
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|circle|cir|court|ct|place|pl|way|blvd|boulevard)\b/g, '')
      .trim();
  }

  /**
   * Generate price range bucket (±5%)
   */
  private getPriceRange(price: number): string {
    const bucket = Math.round(price / (price * 0.05)) * (price * 0.05);
    return `${Math.round(bucket / 1000)}k`;
  }

  /**
   * Generate size range bucket (±10%)
   */
  private getSizeRange(sqft: number): string {
    const bucket = Math.round(sqft / (sqft * 0.1)) * (sqft * 0.1);
    return `${Math.round(bucket / 100)}h`; // hundreds
  }

  /**
   * Generate composite deduplication key
   */
  private generateKey(property: PropertyData): DeduplicationKey {
    return {
      normalizedAddress: this.normalizeAddress(property.address),
      priceRange: this.getPriceRange(property.price),
      sizeRange: this.getSizeRange(property.sqft)
    };
  }

  /**
   * Convert key to string for Map usage
   */
  private keyToString(key: DeduplicationKey): string {
    return `${key.normalizedAddress}|${key.priceRange}|${key.sizeRange}`;
  }

  /**
   * Calculate similarity score between two properties
   */
  private calculateSimilarity(prop1: PropertyData, prop2: PropertyData): number {
    let score = 0;
    let factors = 0;

    // Address similarity (most important)
    const addr1 = this.normalizeAddress(prop1.address);
    const addr2 = this.normalizeAddress(prop2.address);
    if (addr1 === addr2) {
      score += 40;
    } else if (addr1.includes(addr2) || addr2.includes(addr1)) {
      score += 20;
    }
    factors += 40;

    // Price similarity (±5% = high, ±10% = medium, ±20% = low)
    const priceDiff = Math.abs(prop1.price - prop2.price) / Math.max(prop1.price, prop2.price);
    if (priceDiff <= 0.05) score += 20;
    else if (priceDiff <= 0.10) score += 15;
    else if (priceDiff <= 0.20) score += 10;
    factors += 20;

    // Size similarity
    const sizeDiff = Math.abs(prop1.sqft - prop2.sqft) / Math.max(prop1.sqft, prop2.sqft);
    if (sizeDiff <= 0.05) score += 15;
    else if (sizeDiff <= 0.10) score += 10;
    else if (sizeDiff <= 0.20) score += 5;
    factors += 15;

    // Beds/baths match
    if (prop1.beds === prop2.beds) score += 10;
    if (prop1.baths === prop2.baths) score += 10;
    factors += 20;

    // Year built (if available)
    if (prop1.yearBuilt && prop2.yearBuilt) {
      const yearDiff = Math.abs(prop1.yearBuilt - prop2.yearBuilt);
      if (yearDiff <= 2) score += 5;
      else if (yearDiff <= 5) score += 3;
      factors += 5;
    }

    return (score / factors) * 100;
  }

  /**
   * Merge conflicting property data intelligently
   */
  private mergeProperties(properties: PropertyData[]): PropertyData {
    const merged: PropertyData = { ...properties[0] };
    const conflicts: DuplicateGroup['conflicts'] = [];

    // Fields to merge with specific strategies
    const mergeStrategies = {
      address: 'longest', // Use the most complete address
      price: 'median', // Use median price to avoid outliers
      sqft: 'mode', // Use most common sqft
      beds: 'mode',
      baths: 'mode',
      yearBuilt: 'mode',
      soldDate: 'most_recent',
      distance: 'minimum', // Use closest distance
      source: 'best_quality', // Prefer MLS over other sources
      confidence: 'highest'
    };

    for (const [field, strategy] of Object.entries(mergeStrategies)) {
      const values = properties
        .map(p => p[field])
        .filter(v => v != null && v !== undefined && v !== '');

      if (values.length === 0) continue;

      const uniqueValues = [...new Set(values)];
      if (uniqueValues.length === 1) {
        merged[field] = uniqueValues[0];
        continue;
      }

      // Handle conflicts based on strategy
      let resolution: any;
      let method: string;

      switch (strategy) {
        case 'longest':
          resolution = values.reduce((a, b) => a.length > b.length ? a : b);
          method = 'longest_value';
          break;

        case 'median':
          const sorted = values.sort((a, b) => a - b);
          resolution = sorted[Math.floor(sorted.length / 2)];
          method = 'median_value';
          break;

        case 'mode':
          const counts = values.reduce((acc, val) => {
            acc[val] = (acc[val] || 0) + 1;
            return acc;
          }, {} as Record<any, number>);
          resolution = Object.entries(counts)
            .sort(([,a], [,b]) => Number(b) - Number(a))[0][0];
          method = 'most_common_value';
          break;

        case 'most_recent':
          resolution = values
            .map(v => ({ date: new Date(v), value: v }))
            .sort((a, b) => b.date.getTime() - a.date.getTime())[0].value;
          method = 'most_recent_date';
          break;

        case 'minimum':
          resolution = Math.min(...values);
          method = 'minimum_value';
          break;

        case 'best_quality':
          const qualityOrder = ['MLS', 'verified', 'public_records', 'estimate'];
          resolution = values.find(v => qualityOrder.some(q => v.includes(q))) || values[0];
          method = 'quality_preference';
          break;

        case 'highest':
          const confidenceOrder = { 'high': 3, 'medium': 2, 'low': 1 };
          resolution = values.sort((a, b) =>
            (confidenceOrder[b] || 0) - (confidenceOrder[a] || 0)
          )[0];
          method = 'highest_confidence';
          break;

        default:
          resolution = values[0];
          method = 'first_value';
      }

      conflicts.push({
        field,
        values: uniqueValues,
        resolution,
        method
      });

      merged[field] = resolution;
    }

    // Add metadata about the merge
    merged.mergedFrom = properties.length;
    merged.mergeConflicts = conflicts.length;
    merged.searchIds = properties.map(p => p.searchId).filter(Boolean);

    return merged;
  }

  /**
   * Add property to deduplication pool
   */
  addProperty(property: PropertyData): void {
    const key = this.generateKey(property);
    const keyString = this.keyToString(key);

    if (!this.duplicateGroups.has(keyString)) {
      this.duplicateGroups.set(keyString, {
        key,
        properties: [],
        merged: property,
        confidence: 'high',
        conflicts: []
      });
    }

    const group = this.duplicateGroups.get(keyString)!;

    // Check if this is actually a duplicate by calculating similarity
    const isDuplicate = group.properties.some(existing =>
      this.calculateSimilarity(property, existing) > 80
    );

    if (isDuplicate || group.properties.length === 0) {
      group.properties.push(property);

      // Re-merge the group
      group.merged = this.mergeProperties(group.properties);

      // Calculate group confidence
      if (group.properties.length === 1) {
        group.confidence = 'high';
      } else if (group.conflicts.length <= 2) {
        group.confidence = 'medium';
      } else {
        group.confidence = 'low';
      }
    } else {
      // Not actually a duplicate, create new group with modified key
      const newKeyString = `${keyString}_alt_${group.properties.length}`;
      this.duplicateGroups.set(newKeyString, {
        key: { ...key, normalizedAddress: `${key.normalizedAddress}_alt` },
        properties: [property],
        merged: property,
        confidence: 'high',
        conflicts: []
      });
    }
  }

  /**
   * Process multiple properties and return deduplicated results
   */
  deduplicateProperties(properties: PropertyData[]): {
    deduplicated: PropertyData[];
    duplicateGroups: DuplicateGroup[];
    summary: {
      originalCount: number;
      duplicatesRemoved: number;
      finalCount: number;
      conflictsResolved: number;
      highConfidenceGroups: number;
      mediumConfidenceGroups: number;
      lowConfidenceGroups: number;
    };
  } {
    jobLog(`🔗 Starting smart deduplication of ${properties.length} properties...`);

    // Reset state
    this.duplicateGroups.clear();
    this.processedProperties.clear();

    // Add all properties to deduplication pool
    properties.forEach(property => {
      this.addProperty(property);
    });

    // Extract results
    const duplicateGroups = Array.from(this.duplicateGroups.values());
    const deduplicated = duplicateGroups.map(group => group.merged);

    // Calculate summary
    const summary = {
      originalCount: properties.length,
      duplicatesRemoved: properties.length - deduplicated.length,
      finalCount: deduplicated.length,
      conflictsResolved: duplicateGroups.reduce((sum, group) => sum + group.conflicts.length, 0),
      highConfidenceGroups: duplicateGroups.filter(g => g.confidence === 'high').length,
      mediumConfidenceGroups: duplicateGroups.filter(g => g.confidence === 'medium').length,
      lowConfidenceGroups: duplicateGroups.filter(g => g.confidence === 'low').length
    };

    jobLog(`✅ Deduplication complete:`);
    jobLog(`   📊 ${summary.originalCount} → ${summary.finalCount} properties`);
    jobLog(`   🔗 ${summary.duplicatesRemoved} duplicates removed`);
    jobLog(`   ⚠️  ${summary.conflictsResolved} conflicts resolved`);
    jobLog(`   📈 Confidence: ${summary.highConfidenceGroups}H/${summary.mediumConfidenceGroups}M/${summary.lowConfidenceGroups}L`);

    // Log groups with conflicts for debugging
    duplicateGroups.forEach(group => {
      if (group.properties.length > 1) {
        jobLog(`   🔗 Merged ${group.properties.length} instances of ${group.merged.address}`);
        if (group.conflicts.length > 0) {
          group.conflicts.forEach(conflict => {
            jobLog(`      ${conflict.field}: [${conflict.values.join(', ')}] → ${conflict.resolution} (${conflict.method})`);
          });
        }
      }
    });

    return {
      deduplicated,
      duplicateGroups,
      summary
    };
  }

  /**
   * Get duplicate groups for analysis
   */
  getDuplicateGroups(): DuplicateGroup[] {
    return Array.from(this.duplicateGroups.values());
  }

  /**
   * Clear internal state
   */
  reset(): void {
    this.duplicateGroups.clear();
    this.processedProperties.clear();
  }
}