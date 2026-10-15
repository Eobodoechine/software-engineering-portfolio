// Vertex AI Gemini property data parser
import { vertexGenerate } from '../vertex-freeform.js';
import { withVertexLimiter } from '../vertex-limiter';
import { jobLog } from '../utils/jobLogger';

interface PropertyData {
  address: string;
  sold_price: number;
  sold_date: string;
  beds: number;
  baths: number;
  sqft: number;
  year_built: number;
  source_url: string;
}

export class GeminiParser {
  private location = process.env.VERTEX_AI_LOCATION || 'us-central1';
  private model = process.env.VERTEX_PARSER_MODEL || process.env.VERTEX_MODEL || 'gemini-2.5-flash';

  /**
   * Parse property data using Gemini API
   */
  async parsePropertyData(rawText: string): Promise<PropertyData[]> {
    jobLog('🤖 GeminiParser: Starting property data extraction...');

    try {
      const extractedData = await this.extractWithGemini(rawText);
      jobLog('✅ GeminiParser: Raw extraction completed');

      const rawData = this.parseRawResponse(extractedData);
      jobLog(`✅ GeminiParser: Extracted ${rawData.length} properties from raw response`);

      return rawData;
    } catch (error) {
      console.error('❌ GeminiParser: Failed to parse data:', error);
      // Fallback manual parser removed - it doesn't work
      // Return empty array instead of trying broken fallback
      return [];
    }
  }

  /**
   * Use Vertex AI Gemini to extract property data
   */
  private async extractWithGemini(rawText: string): Promise<string> {
    const prompt = `Parse this real estate data and return ONLY a JSON object with all properties.

Input data:
${rawText}

Return JSON in exactly this format (no other text):
{
  "properties": [
    {
      "address": "full address",
      "sold_price": 215000,
      "sold_date": "2024-08-02",
      "beds": 4,
      "baths": 2.5,
      "sqft": 1381,
      "year_built": 1960,
      "source_url": "full URL"
    }
  ]
}`;

    jobLog('🔄 GeminiParser: Calling Vertex AI Gemini...');

    try {
      // Use Application Default Credentials (ADC)
      const { resolveProjectId, getAccessTokenViaAuth } = await import('../vertex-freeform.js');
      const projectId = await resolveProjectId();
      const token = await getAccessTokenViaAuth();

      // S0-v2: Wrap Vertex call with global limiter for S0 runs
      const runLabel = process.env.RUN_LABEL || '';
      const vertexCall = () => vertexGenerate({
        projectId: projectId,
        location: this.location,
        model: this.model,
        prompt: prompt,
        token: token,
        json: true,
        timeoutMs: 30000,
        caller: 'gemini-parser'
      });

      const result = runLabel.startsWith('S0')
        ? await withVertexLimiter('gemini-parser', 'gemini-parser', vertexCall)
        : await vertexCall();

      if (!result) {
        // 🔧 [EMPTY_RESPONSE] Vertex AI returned empty response (likely rate limiting)
        jobLog('❌ [GEMINI_EMPTY_RESPONSE] No content returned from Vertex AI');
        jobLog('   This error is retryable - may be temporary quota exhaustion');

        const error = new Error('No content returned from Vertex AI Gemini');
        (error as any).code = 'VERTEX_EMPTY_RESPONSE'; // Mark as retryable

        console.error('❌ [GEMINI_EMPTY_RESPONSE_DETAILS]', {
          timestamp: new Date().toISOString(),
          errorCode: 'VERTEX_EMPTY_RESPONSE',
          retryable: true,
          rawResult: result
        });

        throw error;
      }

      return result;
    } catch (error) {
      throw new Error(`Vertex AI Gemini request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse raw response from Gemini without any data cleaning
   */
  private parseRawResponse(rawResponse: string): PropertyData[] {
    jobLog('🔍 GeminiParser: Parsing raw response without cleaning...');
    jobLog('📝 Raw response:', rawResponse);

    try {
      // Clean markdown code blocks if present
      let cleanedJson = rawResponse.trim();
      if (cleanedJson.startsWith('```json')) {
        cleanedJson = cleanedJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedJson.startsWith('```')) {
        cleanedJson = cleanedJson.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(cleanedJson);

      if (parsed.properties && Array.isArray(parsed.properties)) {
        // Return raw properties without validation or cleaning
        return parsed.properties.map((prop: any) => ({
          address: prop.address || '',
          sold_price: prop.sold_price || 0,
          sold_date: prop.sold_date || '',
          beds: prop.beds || 0,
          baths: prop.baths || 0,
          sqft: prop.sqft || 0,
          year_built: prop.year_built || 0,
          source_url: prop.source_url || ''
        }));
      } else {
        throw new Error('Invalid JSON structure: missing properties array');
      }
    } catch (error) {
      console.error('❌ Raw response parsing failed:', error);
      throw error;
    }
  }

  /**
   * Validate JSON response from Gemini (no cleanup)
   */
  private validateAndCleanJson(jsonText: string): PropertyData[] {
    jobLog('🔍 GeminiParser: Validating JSON response...');

    try {
      // Clean markdown code blocks if present
      let cleanedJson = jsonText.trim();
      if (cleanedJson.startsWith('```json')) {
        cleanedJson = cleanedJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedJson.startsWith('```')) {
        cleanedJson = cleanedJson.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(cleanedJson);

      if (parsed.properties && Array.isArray(parsed.properties)) {
        return parsed.properties.map(prop => this.validateProperty(prop)).filter(Boolean);
      } else {
        throw new Error('Invalid JSON structure: missing properties array');
      }
    } catch (error) {
      console.error('❌ JSON validation failed:', error);
      jobLog('📝 Raw JSON text:', jsonText);
      throw error;
    }
  }

  /**
   * Validate and normalize a single property object
   */
  private validateProperty(prop: any): PropertyData | null {
    try {
      const result = {
        address: prop.address?.toString() || '',
        sold_price: this.parseNumber(prop.sold_price),
        sold_date: prop.sold_date?.toString() || '',
        beds: this.parseNumber(prop.beds),
        baths: this.parseNumber(prop.baths),
        sqft: this.parseNumber(prop.sqft),
        year_built: this.parseNumber(prop.year_built),
        source_url: prop.source_url?.toString() || ''
      };
      return result;
    } catch (error) {
      console.warn('⚠️ GeminiParser: Invalid property data:', prop);
      console.error('⚠️ Validation error details:', error);
      return null;
    }
  }

  /**
   * Parse various number formats
   */
  private parseNumber(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[$,]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

}
