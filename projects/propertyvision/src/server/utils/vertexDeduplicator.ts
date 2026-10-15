// Vertex AI-Powered Intelligent Deduplication
// Replaces rule-based deduplication with AI that understands real estate data nuances
import { jobLog } from '../utils/jobLogger';
import { withVertexLimiter } from '../vertex-limiter';

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
  searchId?: string;
  confidence?: 'high' | 'medium' | 'low';
  [key: string]: any;
}

interface DeduplicationResult {
  uniqueProperties: PropertyData[];
  duplicatesRemoved: number;
  mergedGroups: Array<{
    masterProperty: PropertyData;
    duplicates: PropertyData[];
    reason: string;
    confidence: number;
  }>;
}

export class VertexDeduplicator {

  /**
   * Use Vertex AI to intelligently deduplicate properties
   * Handles address variations, coordinate proximity, unit numbers, etc.
   */
  async deduplicateProperties(properties: PropertyData[]): Promise<DeduplicationResult> {
    jobLog('🚨🚨🚨 DEDUP START: deduplicateProperties called 🚨🚨🚨');
    jobLog('🔍 DEDUP LINE 0: Function entry, properties type:', typeof properties);
    jobLog('🔍 DEDUP LINE 0.1: properties is array:', Array.isArray(properties));
    jobLog('🔍 DEDUP LINE 0.2: properties length:', properties?.length);
    jobLog('🔍 DEDUP LINE 1: Function entry');
    jobLog('🔍 DEDUP LINE 1.5: About to check properties.length');

    if (properties.length <= 1) {
      jobLog('🔍 DEDUP LINE 2: Early return for <= 1 properties');
      return {
        uniqueProperties: properties,
        duplicatesRemoved: 0,
        mergedGroups: []
      };
    }

    jobLog(`🤖 Vertex Deduplication: Analyzing ${properties.length} properties`);
    jobLog('🔍 DEDUP LINE 3: About to enter try block');

    try {
      jobLog('🔍 DEDUP LINE 4: About to import vertex-freeform.js');
      const { vertexGenerate, resolveProjectId, resolveLocation, getAccessTokenViaAuth } = await import('../vertex-freeform.js');
      jobLog('🔍 DEDUP LINE 5: vertex-freeform.js imported successfully');

      jobLog('🔍 DEDUP LINE 6: About to get ADC credentials');
      const projectId = await resolveProjectId();
      const location = resolveLocation();
      const model = 'gemini-2.5-pro'; // Use Pro model for better structured output
      const token = await getAccessTokenViaAuth();
      jobLog('🔍 DEDUP LINE 7: ADC credentials obtained successfully');

      // Prepare property data - ONLY essentials for deduplication (minimizes token usage)
      const propertyList = properties.map((prop, index) => ({
        record_id: index.toString(),
        address: prop.address, // Primary field for deduplication
        sale_date: prop.soldDate || null, // For tie-breaking (most recent wins)
        price: prop.price || null // For secondary tie-breaking (higher price wins)
      }));

      const prompt = `You are deduplicating real estate property comparables. Identify duplicate properties based on normalized addresses.

NORMALIZATION RULES:
1. Convert to lowercase
2. Remove all punctuation (periods, commas, hashes)
3. Standardize street types: St→Street, Ave→Avenue, Rd→Road, Dr→Drive, Ln→Lane, Ct→Court, Blvd→Boulevard, Cir→Circle
4. Collapse multiple spaces to single space
5. Ignore city and ZIP code differences - only compare street addresses

DUPLICATE DETECTION:
- Properties with the same normalized street address are duplicates
- Example: "123 Example St, Example City, GA 30000" and "123 Example St, Example City, GA" are duplicates

TIE-BREAKING (when duplicates found):
1. PRIMARY: Keep the record with the most recent sale_date
2. SECONDARY: If sale_date is identical, keep the record with higher price
3. Use the kept record's record_id as canonical_record_id

OUTPUT FORMAT:
Return a JSON object with a duplicate_groups array.
Each group must include:
- group_id: unique identifier like "dup-001"
- canonical_record_id: the record_id to keep
- record_ids: all duplicate record_ids including canonical
- match_reason: ["ADDRESS_MATCH"] (optional)
- confidence: 1.0 for exact address match (optional)

Input data to analyze:
${JSON.stringify(propertyList, null, 2)}`;

      // Response Schema mode (Controlled Generation) - lowercase types for JSON Schema
      // More reliable than function calling - bypasses MALFORMED_FUNCTION_CALL errors
      const responseSchema = {
        type: 'object',
        properties: {
          duplicate_groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                group_id: { type: 'string' },
                canonical_record_id: { type: 'string' },
                record_ids: { type: 'array', items: { type: 'string' } },
                match_reason: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number' }
              },
              required: ['group_id', 'canonical_record_id', 'record_ids']
            }
          }
        },
        required: ['duplicate_groups']
      };

      jobLog('🔍 DEDUP LINE 8: About to call vertexGenerate');
      jobLog('🚨🚨🚨 DEDUPLICATOR CALLING VERTEXGENERATE 🚨🚨🚨');

      // S0-v2: Wrap Vertex call with global limiter for S0 runs
      const runLabel = process.env.RUN_LABEL || '';
      const vertexCall = () => vertexGenerate({
        token,
        projectId,
        location,
        model,
        prompt,
        grounded: false, // Use AI reasoning, not web search
        json: true, // Enable JSON response mode
        responseSchema, // Use response schema instead of function calling
        maxOutputTokens: 4096,
        timeoutMs: 120000,
        caller: 'vertex-deduplicator'
      });

      const response = runLabel.startsWith('S0')
        ? await withVertexLimiter('vertex-deduplicator', 'vertex-deduplicator', vertexCall)
        : await vertexCall();

      jobLog('🔍 DEDUP LINE 9: vertexGenerate completed successfully');

      const result = JSON.parse(response);
      jobLog(`🤖 Vertex identified ${result.duplicate_groups.length} duplicate groups`);

      // Build final result
      const uniqueProperties: PropertyData[] = [];
      const mergedGroups: DeduplicationResult['mergedGroups'] = [];
      let duplicatesRemoved = 0;

      // Create a map of kept records by their original index
      const keptRecordMap = new Map<string, any>();
      for (const record of result.kept_records || []) {
        if (record.source_record_ids && record.source_record_ids.length > 0) {
          // Use the first source record ID as the canonical ID
          keptRecordMap.set(record.source_record_ids[0], record);
        }
      }

      // Add unique properties (not in any duplicate group)
      const allGroupedIds = new Set<string>();
      for (const group of result.duplicate_groups || []) {
        for (const id of group.record_ids) {
          allGroupedIds.add(id);
        }
      }

      // Add properties that weren't grouped as duplicates
      properties.forEach((prop, index) => {
        const indexStr = index.toString();
        if (!allGroupedIds.has(indexStr)) {
          uniqueProperties.push(prop);
        }
      });

      // Process duplicate groups and add canonical records
      for (const group of result.duplicate_groups || []) {
        const canonicalId = group.canonical_record_id;
        const canonicalProperty = properties[parseInt(canonicalId)];
        const duplicates = group.record_ids
          .filter(id => id !== canonicalId)
          .map(id => properties[parseInt(id)])
          .filter(Boolean);

        if (canonicalProperty) {
          // Use the enhanced canonical record if available, otherwise use original
          const enhancedRecord = keptRecordMap.get(canonicalId);
          const finalProperty = enhancedRecord ? this.mapBackToPropertyData(enhancedRecord, canonicalProperty) : canonicalProperty;

          uniqueProperties.push(finalProperty);
          mergedGroups.push({
            masterProperty: finalProperty,
            duplicates,
            reason: group.match_reason.join(', '),
            confidence: group.confidence
          });
          duplicatesRemoved += duplicates.length;

          jobLog(`   🔗 Merged ${duplicates.length} duplicates (confidence: ${group.confidence.toFixed(2)}): ${group.notes || group.match_reason.join(', ')}`);
          jobLog(`      Master: ${canonicalProperty.address}`);
          duplicates.forEach(dup => jobLog(`      Duplicate: ${dup.address}`));
        }
      }

      jobLog(`✅ Vertex Deduplication complete: ${properties.length} → ${uniqueProperties.length} unique (removed ${duplicatesRemoved} duplicates)`);

      return {
        uniqueProperties,
        duplicatesRemoved,
        mergedGroups
      };

    } catch (error) {
      jobLog('🚨🚨🚨 DEDUP CATCH BLOCK ENTERED 🚨🚨🚨');
      jobLog('🔍 DEDUP LINE 10: Entered catch block');
      jobLog('🔍 DEDUP LINE 10.1: Error type:', typeof error);
      jobLog('🔍 DEDUP LINE 10.2: Error message:', (error as any)?.message);
      jobLog('🔍 DEDUP LINE 10.3: Error code:', (error as any)?.code);
      jobLog('🔍 DEDUP LINE 10.4: Error stack:', (error as any)?.stack);
      jobLog('🔍 DEDUP LINE 10.5: Error name:', (error as any)?.name);
      jobLog('🔍 DEDUP LINE 10.6: Full error object keys:', error ? Object.keys(error) : 'NO ERROR OBJECT');
      console.error('❌ Vertex deduplication failed, falling back to original properties:', error);
      return {
        uniqueProperties: properties,
        duplicatesRemoved: 0,
        mergedGroups: []
      };
    }
  }

  /**
   * Map enhanced record from Vertex back to PropertyData format
   */
  private mapBackToPropertyData(enhancedRecord: any, originalProperty: PropertyData): PropertyData {
    return {
      ...originalProperty,
      // Update with any enhanced fields from Vertex, keeping original structure
      price: enhancedRecord.price ?? originalProperty.price,
      sqft: enhancedRecord.sqft ?? enhancedRecord.gla ?? originalProperty.sqft,
      beds: enhancedRecord.beds ?? originalProperty.beds,
      baths: enhancedRecord.baths ?? originalProperty.baths,
      yearBuilt: enhancedRecord.year_built ?? originalProperty.yearBuilt,
      soldDate: enhancedRecord.sale_date ?? originalProperty.soldDate,
      source: enhancedRecord.source ?? originalProperty.source
    };
  }
}