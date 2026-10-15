import 'dotenv/config';
import fs from 'fs';
import https from 'https';
import dns from 'dns';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import pLimit from 'p-limit';
// import { groundedFreeform } from './vertex-freeform'; // Replaced with deterministic vertexGenerate
import { fetchPropertyDetailsViaVertex } from './vertex-details';
import { GeminiParser } from './utils/geminiParser';
import { jobLog } from './utils/jobLogger';
import { withVertexLimiter, getLimiterCallCount } from './vertex-limiter';
import { probe } from './utils/probe';

// Force IPv4-first DNS resolution to avoid IPv6 timeout delays in VPC
dns.setDefaultResultOrder('ipv4first');

// Keep-alive agent for proxy connections (reuse TLS connections)
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Diagnostic logging helper (structured JSON for Cloud Logging)
function diag(event: string, payload: Record<string, any>) {
  jobLog(JSON.stringify({
    event,
    ts: new Date().toISOString(),
    service: process.env.K_SERVICE || 'worker',
    revision: process.env.K_REVISION || 'unknown',
    ...payload
  }));
}

// ---------- Phase A: Pacing & logging helpers ----------
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const envInt = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};
const CONCURRENCY   = envInt('VERTEX_CONCURRENCY_LIMIT', 2);
const BASE_DELAY_MS = envInt('VERTEX_PACING_MS', 300);
const JITTER_MS     = envInt('VERTEX_PACING_JITTER_MS', 50);
const PHASE_MAX_MS  = envInt('VERTEX_PHASE_OFFSET_MAX_MS', 350);
const DIAG_FAIL_FAST = String(process.env.DIAG_FAIL_FAST || 'false').toLowerCase() === 'true';
const jittered = (base: number, jitter: number) =>
  base + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
const logJSON = (kind: string, extra: Record<string, any> = {}) => {
  jobLog(JSON.stringify({ t: Date.now(), kind, ...extra }));
};

// Cache bypass flag for testing (no default change)
const GEOCODE_BYPASS_CACHE = process.env.GEOCODE_BYPASS_CACHE === 'true';

// Geo-proxy feature flags (env-only toggle)
const USE_GEO_PROXY = process.env.USE_GEO_PROXY === 'true';
const GEO_PROXY_URL = process.env.GEO_PROXY_URL || '';
const PROXY_SHARED_KEY = process.env.PROXY_SHARED_KEY || '';

// Proxy pre-warm (fire-and-forget, non-blocking)
async function prewarmProxy() {
  if (!USE_GEO_PROXY || !GEO_PROXY_URL || !PROXY_SHARED_KEY) return;
  // Skipping prewarm for now - direct calls are fast enough
}

interface ComparableProperty {
  address: string;
  price: number;
  sqft: number;
  beds: number;
  baths: number;
  yearBuilt: number | null;
  soldDate: string;
  distance: number;
  source: string;
  confidence: string;
  condition?: string;
}

interface FindComparablesResult {
  comparables: ComparableProperty[];  // Qualified/filtered comps
  all_comps: ComparableProperty[];    // Raw/unfiltered comps (before validation/filtering)
  success: boolean;
  error?: string;
}

class VertexComparableSearchService {
  private rawCompsFound: number = 0;
  private googleMapsApiKey: string;
  private geocodeCache: Map<string, { lat: number; lon: number }>;
  private geminiParser: GeminiParser;
  private currentJobId: string = 'unknown'; // S0-v2: Track jobId for vertex limiter

  constructor() {
    this.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!this.googleMapsApiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY environment variable is required');
    }
    this.geocodeCache = new Map();
    this.geminiParser = new GeminiParser();
  }

  async findComparables(
    subjectAddress: string,
    subjectPropertyType?: string,
    maxResults: number = 10,
    searchRadius: number = 3,
    timeWindowMonths: number = 18,
    subjectDetails?: { sqft: number; beds: number; baths: number; yearBuilt: number },
    extra?: { subdivision?: string },
    jobId?: string
  ): Promise<FindComparablesResult> {
    // Use provided jobId or create one from address hash
    const effectiveJobId = jobId || createHash('md5').update(subjectAddress).digest('hex').slice(0, 8);
    // S0-v2: Capture baseline limiter count for per-job integrity tracking
    const baselineLimiterCalls = getLimiterCallCount();
    this.currentJobId = effectiveJobId; // S0-v2: Store for use in private methods
    try {
      // Pre-warm proxy connection (fire-and-forget, non-blocking)
      if (USE_GEO_PROXY) prewarmProxy().catch(() => {});

      jobLog(`🔍 SEARCHING COMPARABLES: ${subjectAddress}`);
      jobLog(`   • Radius: ${searchRadius} miles`);
      jobLog(`   • Max results: ${maxResults}`);
      jobLog(`🔧 DIAG_SEARCH_STRATEGY: using legacy 6-prompt strategy (not progressive)`);
      probe({ probe: 'STEP3_SEARCH_START', subjectAddress, searchRadius, maxResults });

      // Get subject property coordinates
      const subjectCoords = await this.geocodeWithTimeout(subjectAddress, 30000);
      if (!subjectCoords) {
        throw new Error('Failed to geocode subject property');
      }

      // Use ADC for authentication
      const { resolveProjectId, resolveLocation, getAccessTokenViaAuth } = await import('./vertex-freeform.js');
      const projectId = await resolveProjectId();
      const location = resolveLocation();
      const model = process.env.VERTEX_MODEL || 'gemini-2.5-pro';

      const tokenStart = Date.now();
      const token = await getAccessTokenViaAuth();
      const tokenDuration = Date.now() - tokenStart;
      jobLog(`🎫 DIAG_TOKEN_FETCH: acquired in ${tokenDuration}ms, length=${token.length}, will_be_reused=true`);

      // Build subdivision filter from override or env
      const subdivision = (extra?.subdivision?.trim() || process.env.SUBDIVISION)?.trim();
      jobLog(`🔧 DIAG_SUBDIVISION: ${subdivision ? `enabled="${subdivision}"` : 'disabled'}`);

      // Compose an analyst-style prompt but enforce pipe-separated output for parsing
      const composeAnalystPipePrompt = (
        withSubdivision: boolean
      ) => {
        const sd = subjectDetails || null;
        const subjBeds = sd?.beds ?? undefined;
        const subjBaths = sd?.baths ?? undefined;
        const subjSqft = sd?.sqft ?? undefined;
        const subjYear = sd?.yearBuilt ?? undefined;
        const lowSqft = subjSqft ? Math.round(subjSqft * 0.8) : '±20% lower bound';
        const highSqft = subjSqft ? Math.round(subjSqft * 1.2) : '±20% upper bound';
        const lowYear = subjYear ? subjYear - 10 : 'subject-10';
        const highYear = subjYear ? subjYear + 10 : 'subject+10';

        return `You are an experienced real estate analyst.

Your task is to identify the best comparable sales ("comps") for the subject property below.
Follow the step-by-step instructions exactly and only return comps that meet the criteria.

SUBJECT PROPERTY:
- Address: ${subjectAddress}
${subjBeds != null ? `- Beds: ${subjBeds}\n` : ''}${subjBaths != null ? `- Baths: ${subjBaths}\n` : ''}${subjSqft != null ? `- Square Footage: ${subjSqft} sqft\n` : ''}${subjYear != null ? `- Year Built: ${subjYear}\n` : ''}${subjectPropertyType ? `- Property Type: ${subjectPropertyType}\n` : ''}${withSubdivision && subdivision ? `- Subdivision: ${subdivision}\n` : ''}
COMPARABLE SELECTION CRITERIA:
1. Location: Within ${searchRadius} miles of the subject property.
2. Sale Date: Sold within the last ${timeWindowMonths} months.
3. Size: Between ~${lowSqft} sqft and ~${highSqft} sqft (±20% of subject).
4. Bedrooms: ${subjBeds != null ? `${Math.max(1, subjBeds - 1)}–${subjBeds + 1}` : '±1 of subject'} bedrooms.
5. Bathrooms: ${subjBaths != null ? `${Math.max(1, Math.floor(subjBaths - 1))}–${Math.ceil(subjBaths + 1)}` : '±1 of subject'} bathrooms.
6. Year Built: Between ${lowYear} and ${highYear} (within ±10 years of subject's build year).
7. Property Type: ${(subjectPropertyType === 'duplex' || subjectPropertyType === 'multi-family') ?
  `MUST be duplex or multi-family properties ONLY. Include properties listed as "duplex", "multi-family", "multifamily", "two-family", "2-family", or "2-unit". Focus on 2-unit residential buildings. Do not include single-family homes, condos, townhomes, or large apartment buildings.` :
  subjectPropertyType ? `MUST be ${subjectPropertyType} properties ONLY. Do not include any other property types.` :
  'MUST match the same property type as the subject property. If subject is a single family home, only return single family homes. If subject is a condo, only return condos. If subject is a townhome, only return townhomes.'}

CRITICAL: ${(subjectPropertyType === 'duplex' || subjectPropertyType === 'multi-family') ?
  `Only return duplex/multi-family properties that are 2-unit residential buildings. Exclude single-family homes, condos, townhomes, and large apartment complexes.` :
  subjectPropertyType ? `Only return ${subjectPropertyType} properties.` :
  'Determine the property type of the subject property and ONLY include comparable properties of the SAME type.'} Do not mix property types.

OUTPUT FORMAT (STRICT):
Return ONLY pipe-separated lines, one per property, no commentary, no headers:
address | sold_price | sold_date(YYYY-MM-DD) | beds | baths | sqft | year_built | source_url`;
      };

      // Always perform 3 subdivision runs (if subdivision is set), then 3 expanded runs, aggregate all
      const aggregatedComps = new Map<string, ComparableProperty>();

      // OPTIMIZATION #1: Return raw text instead of parsing immediately
      // This allows us to batch all results and parse once instead of 6 times
      const fetchRaw = async (p: string): Promise<string> => {
        jobLog(`🔍 FETCH DEBUG: fetchRaw starting...`);
        jobLog(`🔍 SCOPE DEBUG: Checking subjectAddress availability: "${typeof subjectAddress}" = "${subjectAddress}"`);
        jobLog(`🔍 SCOPE DEBUG: Checking searchRadius availability: "${typeof searchRadius}" = "${searchRadius}"`);
        jobLog(`🔍 SCOPE DEBUG: Checking timeWindowMonths availability: "${typeof timeWindowMonths}" = "${timeWindowMonths}"`);

        jobLog(`🔍 FETCH DEBUG: About to import vertex-freeform.js`);
        const { vertexGenerate } = await import('./vertex-freeform.js');
        jobLog(`🔍 FETCH DEBUG: vertex-freeform.js imported successfully`);

        jobLog(`🔍 FETCH DEBUG: About to call vertexGenerate with timeout 120000ms`);
        const startVertex = Date.now();

        // S0-v2: Wrap Vertex call with global limiter
        const r = await withVertexLimiter(
          'step3-comparables',
          effectiveJobId,
          async () => vertexGenerate({
            token: token,
            projectId,
            location,
            model,
            prompt: p,
            grounded: true,
            timeoutMs: 120000
          })
        );

        const vertexTime = Date.now() - startVertex;
        jobLog(`🔍 FETCH DEBUG: vertexGenerate completed in ${vertexTime}ms`);
        jobLog(`🔍 RAW RESPONSE: Raw Vertex AI response: "${r}"`);

        return r;
      };

      // Prepare prompts and run all Vertex searches in parallel
      const prompts: string[] = [];
      jobLog(`🔍 PROMPT DEBUG: Starting prompt generation`);
      if (subdivision) {
        jobLog('   🏘️  Subdivision specified — scheduling 3 subdivision searches');
        for (let i = 1; i <= 3; i++) {
          jobLog(`🔍 PROMPT DEBUG: About to call composeAnalystPipePrompt(true) for subdivision search ${i}`);
          prompts.push(composeAnalystPipePrompt(true));
          jobLog(`🔍 PROMPT DEBUG: Subdivision search ${i} prompt created successfully`);
        }
      } else {
        jobLog('   🏘️  No subdivision specified — skipping subdivision runs');
      }
      for (let i = 1; i <= 3; i++) {
        jobLog(`🔍 PROMPT DEBUG: About to call composeAnalystPipePrompt(false) for regular search ${i}`);
        prompts.push(composeAnalystPipePrompt(false));
        jobLog(`🔍 PROMPT DEBUG: Regular search ${i} prompt created successfully`);
      }

      jobLog(`🔍 PROMPT DEBUG: All prompts generated successfully, total: ${prompts.length}`);

      // Calculate expected Vertex calls for integrity check
      // Main searches + potential enrichment/verification calls (documented but not strictly enforced)
      const expectedVertexCalls = prompts.length;

      // Phase A: Add phase offset to desync simultaneous jobs
      if (PHASE_MAX_MS > 0) {
        const phaseOffset = Math.floor(Math.random() * PHASE_MAX_MS);
        logJSON('PHASE_OFFSET', { phaseOffsetMs: phaseOffset, concurrency: CONCURRENCY, baseDelayMs: BASE_DELAY_MS, jitterMs: JITTER_MS });
        await sleep(phaseOffset);
      }

      // S0-v2: Enhanced JOB_CONFIG with schema_version, expected calls, and baseline
      logJSON('JOB_CONFIG', {
        schema_version: 'v2',
        job_id: effectiveJobId,
        run_label: process.env.RUN_LABEL || 'default',
        concurrency: CONCURRENCY,
        pacing_ms: BASE_DELAY_MS,
        jitter_ms: JITTER_MS,
        phase_offset_max_ms: PHASE_MAX_MS,
        total_prompts: prompts.length,
        subdivision_prompts: subdivision ? 3 : 0,
        regular_prompts: 3,
        expected_vertex_calls: expectedVertexCalls,
        baseline_limiter_calls: baselineLimiterCalls,
        note: 'expected_vertex_calls includes main searches only; enrichment/verification calls are additional'
      });

      // Rate limit concurrent Vertex API calls to prevent 429 errors
      jobLog(`   🚀 Launching ${prompts.length} Vertex searches with concurrency limit: ${CONCURRENCY}...`);
      jobLog(`🔍 VERTEX DEBUG: Rate-limited execution starting...`);
      jobLog(`📊 DIAG_BATCH_CONFIG: total_prompts=${prompts.length}, concurrency_limit=${CONCURRENCY}, subdivision_prompts=${subdivision ? 3 : 0}, regular_prompts=3`);
      jobLog(`📊 DIAG_EXPECTED_WAVES: ${Math.ceil(prompts.length / CONCURRENCY)} waves of max ${CONCURRENCY} concurrent calls`);
      const startPromiseAll = Date.now();

      const limit = pLimit(CONCURRENCY);
      const results = await Promise.allSettled(prompts.map((p, index) => {
        return limit(async () => {
          // S0-v2: Pacing is now handled by withVertexLimiter (removed duplicate Phase A pacing)

          const searchStart = Date.now();
          jobLog(`🔍 VERTEX DEBUG: Starting search ${index + 1}/${prompts.length} (concurrency limit: ${CONCURRENCY})`);
          jobLog(`🔍 VERTEX DEBUG: Search ${index + 1} - subjectAddress scope check: "${typeof subjectAddress}" = "${subjectAddress}"`);
          jobLog(`📊 DIAG_SEARCH_START: search_id=${index + 1}, timestamp=${searchStart}, prompt_type=${index < 3 && subdivision ? 'subdivision' : 'regular'}`);

          try {
            // OPTIMIZATION #1: Fetch raw text only, don't parse yet
            const result = await fetchRaw(p);
            const searchDuration = Date.now() - searchStart;
            jobLog(`🔍 VERTEX DEBUG: Search ${index + 1} completed successfully with raw text (${result.length} chars)`);
            jobLog(`✅ DIAG_SEARCH_COMPLETE: search_id=${index + 1}, duration=${searchDuration}ms, text_length=${result.length}`);
            return result;
          } catch (error: any) {
            const searchDuration = Date.now() - searchStart;
            console.error(`❌ VERTEX DEBUG: Search ${index + 1} failed with error: ${error.message}`);
            console.error(`❌ VERTEX DEBUG: Search ${index + 1} error stack: ${error.stack}`);
            console.error(`❌ VERTEX DEBUG: Search ${index + 1} - subjectAddress at error: "${typeof subjectAddress}" = "${subjectAddress}"`);
            jobLog(`❌ DIAG_SEARCH_ERROR: search_id=${index + 1}, duration=${searchDuration}ms, error_code=${error.code}, error_msg=${error.message}`);
            if (error.message.includes('subjectAddress is not defined')) {
              console.error(`❌ CRITICAL: Found the subjectAddress error in search ${index + 1}!`);
            }
            throw error;
          }
        });
      }));

      const promiseAllTime = Date.now() - startPromiseAll;
      jobLog(`🔍 VERTEX DEBUG: Promise.allSettled completed in ${promiseAllTime}ms`);

      // OPTIMIZATION #1: Batch parse all successful results
      jobLog(`🤖 OPTIMIZATION: Starting batch parsing of all search results...`);
      const rawTexts: string[] = [];
      let timeoutCount = 0;
      let errorCount = 0;
      let okCount = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          okCount++;
          jobLog(`✅ VERTEX DEBUG: Search ${index + 1} fulfilled with raw text (${result.value ? result.value.length : 0} chars)`);
          rawTexts.push(result.value || '');
        } else {
          const errorMessage = result.reason?.message || String(result.reason);
          const errorCode = result.reason?.code || 'unknown';

          // Phase A: Log structured fan-out failures
          logJSON('FANOUT_FAILURE', {
            index,
            reason: errorMessage.slice(0, 300),
            code: errorCode
          });

          if (errorCode === 'ETIMEDOUT' || errorMessage.includes('timeout')) {
            timeoutCount++;
            jobLog(`❌ SEARCH_TIMEOUT: Search ${index + 1}/${prompts.length} timed out - ${errorMessage}`);
            jobLog(`⏱️  TIMEOUT_DETAILS: search=${index + 1}, error_code=${errorCode}, duration=${promiseAllTime}ms`);
          } else {
            errorCount++;
            jobLog(`❌ SEARCH_ERROR: Search ${index + 1}/${prompts.length} failed - ${errorMessage}`);
            jobLog(`🔍 ERROR_DETAILS: search=${index + 1}, error_code=${errorCode}, error_type=${typeof result.reason}`);
          }

          console.error(`❌ VERTEX DEBUG: Search ${index + 1} rejected: ${errorMessage}`, result.reason);
          rawTexts.push(''); // Add empty string for failed searches
        }
      });

      // OPTIMIZATION #1: Concatenate ALL raw texts and parse with SINGLE GeminiParser call
      jobLog(`🤖 GEMINI OPTIMIZATION: Concatenating ${rawTexts.filter(t => t).length} search results for single batch parse...`);
      const batchParseStart = Date.now();

      // Concatenate all successful raw texts with clear separators
      const concatenatedText = rawTexts
        .filter(t => t && t.trim().length > 0)
        .join('\n\n=== NEXT SEARCH RESULT ===\n\n');

      jobLog(`🤖 GEMINI: Parsing ALL search results in single call (${concatenatedText.length} chars total)...`);

      let allGeminiProperties: any[] = [];
      if (concatenatedText.length > 0) {
        try {
          allGeminiProperties = await this.geminiParser.parsePropertyData(concatenatedText);
          jobLog(`🤖 GEMINI: Single parse extracted ${allGeminiProperties.length} total properties from ALL searches`);
        } catch (error: any) {
          console.error(`❌ GEMINI: Batch parse failed:`, error.message);
          jobLog(`⚠️  GEMINI: Falling back to sequential parsing...`);

          // Fallback: parse each search individually if batch fails
          for (let i = 0; i < rawTexts.length; i++) {
            if (rawTexts[i]) {
              try {
                const props = await this.geminiParser.parsePropertyData(rawTexts[i]);
                allGeminiProperties.push(...props);
              } catch (e) {
                console.error(`❌ GEMINI: Failed to parse search ${i + 1}:`, e);
              }
            }
          }
        }
      }

      // Convert all properties to ComparableProperty format
      const batches: ComparableProperty[][] = [[]]; // Single batch with all results
      if (allGeminiProperties.length > 0) {
        try {
          const allParsed = await this.convertGeminiToComparable(allGeminiProperties, subjectCoords.lat, subjectCoords.lon, subjectDetails);
          jobLog(`🔍 CONVERSION: Converted ${allParsed.length} total properties`);
          probe({ probe: 'STEP3_CONVERSION_COMPLETE', parsedCount: allParsed.length });
          batches[0] = allParsed;
        } catch (error: any) {
          console.error(`❌ CONVERSION: Failed to convert properties:`, error.message);
        }
      }

      const batchParseTime = Date.now() - batchParseStart;
      jobLog(`🤖 GEMINI OPTIMIZATION COMPLETE: Parsed all results with 1 API call in ${batchParseTime}ms (saved ${rawTexts.filter(t => t).length - 1} API calls)`);

      // Phase A: Summary and optional fail-fast
      logJSON('FANOUT_SUMMARY', { okCount, errorCount, totalPrompts: prompts.length });
      if (DIAG_FAIL_FAST && errorCount > 0) {
        throw new Error(`Fan-out had ${errorCount} failures (DIAG_FAIL_FAST=true)`);
      }

      // Summary logging
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      jobLog(`📊 SEARCH_SUMMARY: total=${prompts.length}, success=${successCount}, timeouts=${timeoutCount}, errors=${errorCount}`);
      if (timeoutCount > 0) {
        jobLog(`⚠️  WARNING: ${timeoutCount} search(es) timed out - consider increasing timeout or optimizing queries`);
      }

      for (const list of batches) {
        if (list && list.length > 0) {
          list.forEach((c: ComparableProperty) => { if (!aggregatedComps.has(c.address)) aggregatedComps.set(c.address, c); });
        }
      }

      // Use aggregated results
      let comps = Array.from(aggregatedComps.values());
      const rawCompsBeforeFiltering = [...comps]; // Save raw comps before any filtering
      jobLog(`   🔗 Aggregated total before filters: ${comps.length} unique properties`);
      probe({ probe: 'STEP3_AGGREGATION_COMPLETE', uniqueComps: comps.length });

      // LOG EACH PROPERTY BEFORE FILTERING
      jobLog(`   🔍 DETAILED PROPERTY FILTERING:`);
      comps.forEach((comp, index) => {
        // Safe formatting to prevent hangs with very large numbers
        const safeSqft = (subjectDetails?.sqft && subjectDetails.sqft < 100000) ? subjectDetails.sqft : '?';
        jobLog(`   🔍 FILTERING ${comp.address}: ${comp.beds}BR/${comp.baths}BA, ${comp.sqft}sqft vs Subject: ${subjectDetails?.beds || '?'}BR/${subjectDetails?.baths || '?'}BA, ${safeSqft}sqft`);

        // Bedroom validation
        const bedroomDiff = Math.abs((comp.beds || 0) - (subjectDetails?.beds || 0));
        if (bedroomDiff <= 1) {
          jobLog(`   ✅ BEDROOM OK ${comp.address}: ${comp.beds}BR vs ${subjectDetails?.beds || '?'}BR (diff: ${bedroomDiff} ≤ 1)`);
        } else {
          jobLog(`   ❌ BEDROOM REJECTED ${comp.address}: ${comp.beds}BR vs ${subjectDetails?.beds || '?'}BR (diff: ${bedroomDiff} > 1)`);
        }

        // Size validation
        if (subjectDetails?.sqft) {
          const sizeVariance = Math.abs(comp.sqft - subjectDetails.sqft) / subjectDetails.sqft * 100;
          if (sizeVariance <= 20) {
            jobLog(`   ✅ SIZE QUALIFIED ${comp.address}: ${sizeVariance.toFixed(1)}% variance (within 20% limit)`);
          } else {
            jobLog(`   ⚠️  Filtered out ${comp.address}: size variance too high (${sizeVariance.toFixed(1)}% > 20% limit)`);
          }
        }

        // Time validation with proper date calculation
        let timeDescription = "Recent sale";
        if (comp.soldDate) {
          try {
            const soldDate = new Date(comp.soldDate);
            const today = new Date();
            const ageInMonths = Math.floor((today.getTime() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
            if (Number.isFinite(ageInMonths)) {
              timeDescription = `Recent sale (${Math.abs(ageInMonths)} months)`;
            } else {
              timeDescription = "Recent sale (calculated)";
            }
          } catch (error) {
            timeDescription = "Recent sale (calculated)";
          }
        } else {
          timeDescription = "Recent sale (calculated)";
        }
        jobLog(`   ✅ TIME QUALIFIED ${comp.address}: ${timeDescription}`);
        jobLog(`🔍 DEBUG STEP A: After TIME QUALIFIED log for ${comp.address}`);
        jobLog(`🔍 DEBUG STEP: About to format price for ${comp.address}, price = ${comp.price} (type: ${typeof comp.price})`);
        const safePrice = (typeof comp.price === 'number' && !isNaN(comp.price)) ? comp.price.toLocaleString() : comp.price;
        jobLog(`🔍 DEBUG STEP: Price formatted successfully: ${safePrice}`);
        jobLog(`   ✅ Added: ${comp.address} - $${safePrice} - ${comp.sqft}sqft - Built: ${comp.yearBuilt || 'Unknown'}`);
      });
      jobLog(`🔍 EXACT DEBUG: forEach loop completed, processed ${comps.length} properties`);

      // Apply bedroom, size, and time filters BEFORE deduplication to reduce API calls
      jobLog(`\n🔍 Step 3a: Bedroom, Size, and Time Filtering (before deduplication)`);
      const beforeFiltering = comps.length;
      comps = comps.filter(comp => {
        // Bedroom filter: ±1 bedroom tolerance
        if (subjectDetails?.beds) {
          const bedroomDiff = Math.abs((comp.beds || 0) - subjectDetails.beds);
          if (bedroomDiff > 1) {
            jobLog(`   ❌ BEDROOM REJECTED ${comp.address}: ${comp.beds}BR vs ${subjectDetails.beds}BR (diff: ${bedroomDiff})`);
            return false;
          }
        }

        // Size filter: ±20% variance
        if (subjectDetails?.sqft) {
          const sizeVariance = Math.abs(comp.sqft - subjectDetails.sqft) / subjectDetails.sqft * 100;
          if (sizeVariance > 20) {
            jobLog(`   ❌ SIZE REJECTED ${comp.address}: ${sizeVariance.toFixed(1)}% variance (> 20% limit)`);
            return false;
          }
        }

        // Time filter: Check against timeWindowMonths parameter
        if (timeWindowMonths && comp.soldDate) {
          try {
            const soldDate = new Date(comp.soldDate);
            const today = new Date();
            const ageInMonths = Math.floor((today.getTime() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
            if (Number.isFinite(ageInMonths) && ageInMonths > timeWindowMonths) {
              jobLog(`   ❌ TIME REJECTED ${comp.address}: ${ageInMonths} months old (> ${timeWindowMonths} months limit)`);
              return false;
            }
          } catch (error) {
            jobLog(`   ❌ TIME REJECTED ${comp.address}: Error parsing date`);
            return false;
          }
        }

        return true;
      });
      jobLog(`   📊 Filter results: ${comps.length}/${beforeFiltering} passed bedroom, size, and time filters (rejected ${beforeFiltering - comps.length})`);

      // Deduplicate by address (remove duplicate addresses)
      jobLog(`\n🔍 Step 3b: Deduplication`);
      jobLog(`🔍 EXACT DEBUG: About to call deduplicateComparables with ${comps.length} comps`);
      comps = this.deduplicateComparables(comps);
      jobLog(`🔍 EXACT DEBUG: deduplicateComparables completed, now have ${comps.length} comps`);

      // PPSF outlier filtering now handled by enhanced ARV calculation with 7.5% threshold

      // Step 3c: Distance Filtering (after deduplication)
      // Note: Distance already calculated in convertGeminiToComparable via Google Maps API
      jobLog(`\n📏 Step 3c: Distance Filtering`);
      const beforeDistanceFilter = comps.length;
      comps = comps.filter((comp) => {
        if (comp.distance === null || comp.distance === undefined) {
          jobLog(`   ❌ DISTANCE REJECTED ${comp.address}: No distance calculated`);
          return false;
        }
        if (comp.distance <= searchRadius) {
          jobLog(`   ✅ DISTANCE OK ${comp.address}: ${comp.distance.toFixed(2)} miles (≤ ${searchRadius} miles)`);
          return true;
        } else {
          jobLog(`   ❌ DISTANCE REJECTED ${comp.address}: ${comp.distance.toFixed(2)} miles (> ${searchRadius} miles)`);
          return false;
        }
      });
      jobLog(`   📏 Distance filter: ${comps.length}/${beforeDistanceFilter} within ${searchRadius} mile radius (rejected ${beforeDistanceFilter - comps.length})`);

      // Enrich missing data and re-validate (drops any newly disqualified comps)
      // No top-N limit: enrich all surviving comps
      jobLog(`\n🔍 Step 3d: Enrich and Re-validate`);
      jobLog(`🔍 EXACT DEBUG: About to call prioritizeForEnrichment with ${comps.length} comps`);
      const prioritized = this.prioritizeForEnrichment(comps);
      jobLog(`🔍 EXACT DEBUG: prioritizeForEnrichment completed, got ${prioritized.length} prioritized`);
      jobLog(`🔍 EXACT DEBUG: About to call enrichAndRevalidate`);
      comps = await this.enrichAndRevalidate(prioritized, subjectDetails);
      jobLog(`🔍 EXACT DEBUG: enrichAndRevalidate completed, now have ${comps.length} comps`);

      // CRITICAL DEBUG LOGGING FOR DUPLEX VERIFICATION
      jobLog(`   🚨 DUPLEX VERIFICATION CHECK POINT:`);
      jobLog(`      🏠 subjectPropertyType = "${subjectPropertyType}" (type: ${typeof subjectPropertyType})`);
      jobLog(`      📊 comps.length = ${comps.length}`);
      jobLog(`      🔍 isDuplex = ${subjectPropertyType === 'duplex'}`);
      jobLog(`      🔍 isMultiFamily = ${subjectPropertyType === 'multi-family'}`);
      jobLog(`      🔍 condition1 = ${(subjectPropertyType === 'duplex' || subjectPropertyType === 'multi-family')}`);
      jobLog(`      🔍 condition2 = ${comps.length > 0}`);
      jobLog(`      🔍 shouldVerify = ${(subjectPropertyType === 'duplex' || subjectPropertyType === 'multi-family') && comps.length > 0}`);

      // If subject is duplex or multi-family, verify each remaining comparable is actually a duplex/multi-family
      if ((subjectPropertyType === 'duplex' || subjectPropertyType === 'multi-family') && comps.length > 0) {
        jobLog(`   🏠 STARTING DUPLEX VERIFICATION for ${comps.length} properties...`);
        comps = await this.verifyDuplexComparables(comps, token, projectId, location, model);
        jobLog(`   ✅ DUPLEX VERIFICATION COMPLETE: ${comps.length} confirmed duplex/multi-family properties`);
      } else {
        jobLog(`   ⏭️  SKIPPING DUPLEX VERIFICATION: propertyType="${subjectPropertyType}", comps=${comps.length}`);
      }

      // Sort by distance (placing unknowns last) and limit results
      comps.sort((a, b) => {
        const af = Number.isFinite(a.distance) ? a.distance : Number.POSITIVE_INFINITY;
        const bf = Number.isFinite(b.distance) ? b.distance : Number.POSITIVE_INFINITY;
        return af - bf;
      });
      const finalComps = comps.slice(0, maxResults);

      // COMPREHENSIVE VALIDATION LOGGING
      const foundCount = this.rawCompsFound || 0; // Track raw comps found
      const qualifiedCount = finalComps.length;
      const rejectedCount = foundCount - qualifiedCount;

      jobLog(`   📊 SEARCH SUMMARY:`);
      jobLog(`      🔍 Found: ${foundCount} raw comps from Vertex AI`);
      jobLog(`      ✅ Qualified: ${qualifiedCount} comps (passed all filters)`);
      jobLog(`      ❌ Rejected: ${rejectedCount} comps (failed validation)`);

      if (qualifiedCount > 0) {
        const distances = finalComps.map(c => c.distance);
        const sizes = finalComps.map(c => c.sqft);
        const ppsfValues = finalComps.map(c => c.price / c.sqft);

        jobLog(`      📍 Distance range: ${Math.min(...distances).toFixed(2)}mi - ${Math.max(...distances).toFixed(2)}mi`);
        jobLog(`      📐 Size range: ${Math.min(...sizes).toLocaleString()} - ${Math.max(...sizes).toLocaleString()} sqft`);
        jobLog(`      💲 PPSF range: $${Math.min(...ppsfValues).toFixed(2)} - $${Math.max(...ppsfValues).toFixed(2)}`);
      }

      // MINIMUM COMP COUNT VALIDATION
      const MIN_COMPS_REQUIRED = 3;
      if (finalComps.length < MIN_COMPS_REQUIRED) {
        jobLog(`   ⚠️  WARNING: Only ${finalComps.length} qualified comps (minimum ${MIN_COMPS_REQUIRED} recommended)`);
        jobLog(`   💡 SUGGESTED EXPANSIONS:`);
        jobLog(`      📅 Extend time window: 12 → 18 months`);
        jobLog(`      📍 Expand distance: 2 → 3 miles`);
        jobLog(`      📐 Relax size variance: ±20% → ±25%`);

        if (finalComps.length === 0) {
          return {
            comparables: [],
            all_comps: rawCompsBeforeFiltering,
            success: false,
            error: `No qualified comparables found after strict filtering. Consider expanding search criteria.`
          };
        }
      }

      // Log comp quality breakdown
      const recentComps = finalComps.filter(c => {
        const soldDate = new Date(c.soldDate);
        const ageInMonths = Math.floor((Date.now() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
        return ageInMonths <= 12;
      });

      const idealDistance = finalComps.filter(c => c.distance <= 1.0);
      const extendedDistance = finalComps.filter(c => c.distance > 1.0);

      jobLog(`   ✅ QUALIFIED COMPARABLES: ${finalComps.length}`);
      jobLog(`   📊 Time Quality: ${recentComps.length} recent (≤12mo), ${finalComps.length - recentComps.length} extended (12-18mo)`);
      jobLog(`   📊 Distance Quality: ${idealDistance.length} ideal (≤1mi), ${extendedDistance.length} extended (1-2mi)`);

      // Optional: write final comps cache with distances
      try {
        const outPath = process.env.FINAL_COMPS_CACHE;
        if (outPath) {
          const payload = finalComps.map(c => ({
            address: c.address,
            price: c.price,
            soldDate: c.soldDate,
            beds: c.beds,
            baths: c.baths,
            sqft: c.sqft,
            yearBuilt: c.yearBuilt,
            distance: c.distance,
            source: c.source,
            confidence: c.confidence
          }));
          fs.writeFileSync(outPath, JSON.stringify({ comps: payload }, null, 2));
          jobLog(`   💾 Wrote final comps cache: ${outPath}`);
        }
      } catch {}

      // S0-v2: JOB_END integrity check with per-job baseline tracking
      const endLimiterCalls = getLimiterCallCount();
      const actualSinceStart = Math.max(0, endLimiterCalls - baselineLimiterCalls);
      const callDelta = actualSinceStart - expectedVertexCalls;
      logJSON('JOB_END', {
        schema_version: 'v2',
        job_id: effectiveJobId,
        run_label: process.env.RUN_LABEL || 'default',
        baseline_limiter_calls: baselineLimiterCalls,
        end_limiter_calls: endLimiterCalls,
        vertex_calls_since_start: actualSinceStart,
        vertex_calls_expected_main: expectedVertexCalls,
        call_delta: callDelta,
        integrity_check: callDelta >= 0 ? 'PASS' : 'FAIL',
        note: 'Delta is calls_since_start - expected_main; enrichment/verification add extra calls (OK if delta >= 0)'
      });

      // S0 strict mode: fail if calls bypassed limiter (fewer calls than expected)
      if (process.env.RUN_LABEL?.startsWith('S0') && callDelta < 0) {
        const violation = `S0 integrity violation: expected >=${expectedVertexCalls}, got ${actualSinceStart} (delta ${callDelta})`;
        console.error(JSON.stringify({ t: Date.now(), kind: 'S0_INTEGRITY_VIOLATION', message: violation }));
        throw new Error(violation);
      }

      probe({ probe: 'STEP3_SEARCH_COMPLETE', finalComps: finalComps.length, rawComps: rawCompsBeforeFiltering.length, success: true });
      return {
        comparables: finalComps,
        all_comps: rawCompsBeforeFiltering,
        success: true
      };

    } catch (error: any) {
      console.error(`❌ MAIN CATCH: Comparable search failed with error: ${error.message}`);
      console.error(`❌ MAIN CATCH: Error stack: ${error.stack}`);
      console.error(`❌ MAIN CATCH: subjectAddress at error: "${typeof subjectAddress}" = "${subjectAddress}"`);
      console.error(`❌ MAIN CATCH: Full error object:`, error);
      if (error.message && error.message.includes('subjectAddress is not defined')) {
        console.error(`❌ CRITICAL: Found the subjectAddress error in main catch block!`);
        console.error(`❌ CRITICAL: This means the error bubbled up from Promise.all or fetchAndParse`);
      }
      return {
        comparables: [],
        all_comps: [],
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Convert Gemini parsed properties to ComparableProperty format with distances
   */
  private async convertGeminiToComparable(
    geminiProperties: any[],
    subjectLat: number,
    subjectLon: number,
    subjectDetails?: { sqft: number; beds: number; baths: number; yearBuilt: number }
  ): Promise<ComparableProperty[]> {
    const comparables: ComparableProperty[] = [];

    for (const prop of geminiProperties) {
      try {
        // Get coordinates for this property
        const coords = await this.geocodeWithTimeout(prop.address, 30000);
        if (!coords) {
          console.warn(`⚠️  Skipping property with no coordinates: ${prop.address}`);
          continue;
        }

        // Calculate distance
        const distance = this.calculateHaversineDistance(subjectLat, subjectLon, coords.lat, coords.lon);

        // Convert to ComparableProperty format
        const comparable: ComparableProperty = {
          address: prop.address,
          price: prop.sold_price || 0,
          sqft: prop.sqft || 0,
          beds: prop.beds || 0,
          baths: prop.baths || 0,
          yearBuilt: prop.year_built || null,
          soldDate: prop.sold_date || '',
          distance: distance,
          lat: coords.lat,
          lon: coords.lon,
          source: prop.source_url || 'Unknown',
          confidence: 'High' // Gemini parsing is generally high confidence
        };

        comparables.push(comparable);
      } catch (error: any) {
        console.warn(`⚠️  Error processing property ${prop.address}: ${error.message}`);
        continue;
      }
    }

    return comparables;
  }

  /**
   * Calculate the Haversine distance between two points in miles
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

  private async verifyDuplexComparables(
    comps: ComparableProperty[],
    token: string,
    projectId: string,
    location: string,
    model: string
  ): Promise<ComparableProperty[]> {
    const verifiedComps: ComparableProperty[] = [];

    for (const comp of comps) {
      try {
        // Use LLM to verify if this property is actually a duplex/multi-family
        const verificationPrompt = `Is this property a duplex, two-family, or multi-family building (2-4 units)? Analyze the description and respond with YES or NO.

Property: ${comp.address}
Bedrooms: ${comp.beds}
Bathrooms: ${comp.baths}
Square Feet: ${comp.sqft}
Source: ${comp.source}

Look for indicators like:
- Listed as "duplex", "multi-family", "two-family", "2-unit"
- Side-by-side or up/down configuration
- Multiple kitchens or separate entrances
- Investment property characteristics
- Unit descriptions (Unit A/B, Upper/Lower)

Respond with only YES (if duplex/multi-family) or NO (if single-family/other).`;

        const { vertexGenerate } = await import('./vertex-freeform.js');

        // S0-v2: Wrap Vertex call with global limiter
        const response = await withVertexLimiter(
          'step3-verify-duplex',
          this.currentJobId,
          async () => vertexGenerate({
            token,
            projectId,
            location,
            model,
            prompt: verificationPrompt,
            grounded: true,
            timeoutMs: 30000
          })
        );

        const isDuplex = response.trim().toUpperCase().includes('YES');

        if (isDuplex) {
          jobLog(`   ✅ VERIFIED DUPLEX: ${comp.address} - ${comp.beds}BR/${comp.baths}BA`);
          verifiedComps.push(comp);
        } else {
          jobLog(`   ❌ NOT DUPLEX: ${comp.address} - ${comp.beds}BR/${comp.baths}BA (excluded)`);
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        jobLog(`   ⚠️  Verification failed for ${comp.address}: ${error}`);
        // If verification fails, include the property (conservative approach)
        verifiedComps.push(comp);
      }
    }

    return verifiedComps;
  }

  private async getVertexConfig() {
    const { resolveProjectId, resolveLocation } = await import('./vertex-freeform.js');
    const projectId = await resolveProjectId();
    const location = resolveLocation();
    const model = process.env.VERTEX_MODEL || 'gemini-2.5-pro';

    return { projectId, location, model };
  }

  private async parsePropertyDataWithLLM(propertyLine: string): Promise<{
    address?: string;
    price?: number;
    soldDate?: Date | null;
    beds?: number;
    baths?: number;
    sqft?: number;
    yearBuilt?: number;
    source?: string;
  } | null> {
    try {
      const { vertexGenerate, getAccessTokenViaAuth } = await import('./vertex-freeform.js');
      const { projectId, location, model } = await this.getVertexConfig();
      const token = await getAccessTokenViaAuth();

      // Single LLM call for all fields using JSON
      const allFieldsPrompt = `Extract all property data from this line and return ONLY valid JSON (no prose, no markdown fences):

"${propertyLine}"

Return exactly this JSON structure:
{
  "address": "complete street address",
  "price": number (no commas or dollar signs),
  "soldDate": "YYYY-MM-DD format (or INVALID if date is missing/invalid)",
  "beds": number,
  "baths": number (can be decimal),
  "sqft": number (no commas),
  "yearBuilt": 4-digit year,
  "source": "website name or URL"
}`;

      // Provide response schema to strongly bias valid JSON output
      const responseSchema = {
        type: 'OBJECT',
        properties: {
          address: { type: 'STRING' },
          price: { type: 'NUMBER' },
          soldDate: { type: 'STRING' },
          beds: { type: 'NUMBER' },
          baths: { type: 'NUMBER' },
          sqft: { type: 'NUMBER' },
          yearBuilt: { type: 'NUMBER' },
          source: { type: 'STRING' },
        }
      } as any;

      // S0-v2: Wrap Vertex call with global limiter
      const response = await withVertexLimiter(
        'step3-parse-llm',
        this.currentJobId,
        async () => vertexGenerate({
          token,
          projectId,
          location,
          model,
          prompt: allFieldsPrompt,
          grounded: false,
          json: true,
          timeoutMs: 600000,
          responseSchema
        })
      );

      // Be robust to code fences or stray prose
      const extractJsonBlock = (text: string): string | null => {
        if (!text) return null;
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced && fenced[1]) return fenced[1].trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
        return null;
      };

      let parsedJson: any;
      try {
        parsedJson = JSON.parse(response);
      } catch (parseError) {
        jobLog(`⚠️  Initial JSON parse failed, trying to extract JSON block from response:`, response.substring(0, 200));
        const block = extractJsonBlock(response);
        if (block) {
          try {
            parsedJson = JSON.parse(block);
          } catch (blockError) {
            jobLog(`❌ Failed to parse extracted JSON block:`, block.substring(0, 200));
            parsedJson = null;
          }
        } else {
          jobLog(`❌ No JSON block found in response`);
          parsedJson = null;
        }
      }

      if (!parsedJson || typeof parsedJson !== 'object') {
        jobLog(`❌ LLM parsing error - Invalid JSON response:`, response.substring(0, 500));
        throw new Error('invalid-json-from-llm');
      }

      const addressRes = parsedJson.address || '';
      const priceRes = String(parsedJson.price || 0);
      const dateRes = parsedJson.soldDate || 'INVALID';
      const bedsRes = String(parsedJson.beds || 0);
      const bathsRes = String(parsedJson.baths || 0);
      const sqftRes = String(parsedJson.sqft || 0);
      const yearRes = parsedJson.yearBuilt != null ? String(parsedJson.yearBuilt) : '';
      const sourceRes = parsedJson.source || 'unknown';

      // Parse results
      const address = addressRes.trim();
      const price = Number(priceRes.replace(/[^\d.]/g, ''));
      const dateStr = dateRes.trim();
      const beds = Number(bedsRes.replace(/[^\d.]/g, ''));
      // Normalize common unicode fractions in baths
      const normalizedBaths = bathsRes
        .replace(/½/g, '.5')
        .replace(/¼/g, '.25')
        .replace(/¾/g, '.75');
      const baths = Number(normalizedBaths.replace(/[^\d.]/g, ''));
      const sqft = Number(sqftRes.replace(/[^\d.]/g, ''));
      const yearBuilt = yearRes ? Number(yearRes.replace(/[^\d]/g, '')) : NaN;
      const source = sourceRes.trim();

      // Handle date parsing
      let soldDate: Date | null = null;
      if (dateStr && dateStr !== 'INVALID') {
        soldDate = new Date(dateStr);
        if (isNaN(soldDate.getTime())) {
          // Try alternative date parsing
          let dateMatch = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
          if (dateMatch) {
            soldDate = new Date(parseInt(dateMatch[1], 10), parseInt(dateMatch[2], 10) - 1, parseInt(dateMatch[3], 10));
          } else {
            // Try MM/DD/YYYY or MM-DD-YYYY
            dateMatch = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (dateMatch) {
              soldDate = new Date(parseInt(dateMatch[3], 10), parseInt(dateMatch[1], 10) - 1, parseInt(dateMatch[2], 10));
            } else {
              soldDate = null;
            }
          }
        }
      }

      return {
        address,
        price,
        soldDate,
        beds,
        baths,
        sqft,
        yearBuilt,
        source: source || 'unknown'
      };

    } catch (error) {
      jobLog(`   ⚠️ LLM parsing error: ${error}`);
      return null;
    }
  }

  // Batch LLM parsing for multiple problematic lines in one request
  private async batchParsePropertyDataWithLLM(propertyLines: { id: number; line: string }[]): Promise<Record<number, {
    address?: string;
    price?: number;
    soldDate?: Date | null;
    beds?: number;
    baths?: number;
    sqft?: number;
    yearBuilt?: number;
    source?: string;
  }>> {
    const results: Record<number, any> = {};
    if (propertyLines.length === 0) return results;

    try {
      const { vertexGenerate, getAccessTokenViaAuth } = await import('./vertex-freeform.js');
      const { projectId, location, model } = await this.getVertexConfig();
      const token = await getAccessTokenViaAuth();

      // Build a compact, deterministic prompt with IDs for mapping
      const header = `Parse each of the following real-estate comp lines into JSON. Return ONLY a JSON array (no prose). Each element MUST include the provided id and these fields: address, price (number), soldDate (YYYY-MM-DD or INVALID), beds (number), baths (number), sqft (number), yearBuilt (number), source (string).`;
      const items = propertyLines.map(({ id, line }) => `${id}) ${line}`).join('\n');
      const prompt = `${header}\n\nLINES:\n${items}`;

      // Response schema to strongly bias correct structure
      const responseSchema = {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'NUMBER' },
            address: { type: 'STRING' },
            price: { type: 'NUMBER' },
            soldDate: { type: 'STRING' },
            beds: { type: 'NUMBER' },
            baths: { type: 'NUMBER' },
            sqft: { type: 'NUMBER' },
            yearBuilt: { type: 'NUMBER' },
            source: { type: 'STRING' },
          }
        }
      } as any;

      // S0-v2: Wrap Vertex call with global limiter
      const text = await withVertexLimiter(
        'step3-batch-parse-llm',
        this.currentJobId,
        async () => vertexGenerate({
          token,
          projectId,
          location,
          model,
          prompt,
          grounded: false,
          json: true,
          timeoutMs: 600000,
          responseSchema
        })
      );

      // Extract JSON robustly
      const extractJsonBlock = (t: string): string | null => {
        if (!t) return null;
        const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced && fenced[1]) return fenced[1].trim();
        const start = t.indexOf('[');
        const end = t.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) return t.slice(start, end + 1);
        return null;
      };

      let arr: any[] | null = null;
      try {
        arr = JSON.parse(text);
      } catch {
        const block = extractJsonBlock(text);
        if (block) {
          try { arr = JSON.parse(block); } catch { arr = null; }
        }
      }

      if (!Array.isArray(arr)) return results;

      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const id = Number(item.id);
        if (!Number.isFinite(id)) continue;
        // Normalize and coerce types
        const soldDateStr = String(item.soldDate || '').trim();
        let soldDate: Date | null = null;
        if (soldDateStr && soldDateStr.toUpperCase() !== 'INVALID') {
          let d = new Date(soldDateStr);
          if (!isNaN(d.getTime())) soldDate = d; else {
            let m = soldDateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
            if (m) soldDate = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
            else {
              m = soldDateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
              if (m) soldDate = new Date(parseInt(m[3],10), parseInt(m[1],10)-1, parseInt(m[2],10));
            }
          }
        }

        results[id] = {
          address: item.address || undefined,
          price: Number.isFinite(Number(item.price)) ? Number(item.price) : undefined,
          soldDate,
          beds: Number.isFinite(Number(item.beds)) ? Number(item.beds) : undefined,
          baths: Number.isFinite(Number(item.baths)) ? Number(item.baths) : undefined,
          sqft: Number.isFinite(Number(item.sqft)) ? Number(item.sqft) : undefined,
          yearBuilt: Number.isFinite(Number(item.yearBuilt)) ? Number(item.yearBuilt) : undefined,
          source: item.source || undefined,
        };
      }

      return results;
    } catch (err) {
      jobLog(`   ⚠️ Batch LLM parsing error: ${err}`);
      return results;
    }
  }

  private async parseVertexResponse(
    text: string,
    subjectLat: number,
    subjectLon: number,
    subjectDetails?: { sqft: number; beds: number; baths: number; yearBuilt: number }
  ): Promise<ComparableProperty[]> {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const comps: ComparableProperty[] = [];

    const useLazyParse = String(process.env.LAZY_PARSE || 'true').toLowerCase() !== 'false';

    const cheapParse = (parts: string[]) => {
      if (parts.length < 7) return null;
      const [addrOld, priceStr, dateStr, bedsStr, bathsStr, sqftStr, ybStr, url] = parts;
      if (!addrOld) return null;
      const address = addrOld.trim();
      const price = parseInt(String(priceStr).replace(/[^\d]/g, ''), 10);
      const beds = parseFloat(String(bedsStr).replace(/[^\d.]/g, ''));
      const baths = parseFloat(String(bathsStr).replace(/[^\d.]/g, '').replace(/½/g, '.5'));
      const sqft = parseInt(String(sqftStr).replace(/[^\d]/g, ''), 10);
      const yearBuilt = parseInt(String(ybStr).replace(/[^\d]/g, ''), 10);

      // Date parsing
      let soldDate: Date | null = null;
      const ds = (dateStr || '').trim();
      if (ds) {
        let d = new Date(ds);
        if (!isNaN(d.getTime())) soldDate = d; else {
          let m = ds.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
          if (m) {
            soldDate = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
          } else {
            m = ds.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (m) soldDate = new Date(parseInt(m[3],10), parseInt(m[1],10)-1, parseInt(m[2],10));
          }
        }
      }

      // Basic sanity checks; leave business rules (±20%, etc.) to later filters
      const hasAddress = !!address;
      const hasPrice = Number.isFinite(price) && price > 0;
      const hasDate = soldDate != null && !isNaN(soldDate.getTime());
      const hasSqft = Number.isFinite(sqft) && sqft > 0;
      const hasYear = Number.isFinite(yearBuilt) && yearBuilt >= 1900 && yearBuilt <= new Date().getFullYear();
      const hasBeds = Number.isFinite(beds) && beds > 0;
      const hasBaths = Number.isFinite(baths) && baths > 0;

      if (!hasAddress || !hasPrice || !hasDate) return null; // Core fields required

      return {
        address,
        price,
        soldDate,
        beds: hasBeds ? beds : NaN,
        baths: hasBaths ? baths : NaN,
        sqft: hasSqft ? sqft : NaN,
        yearBuilt: hasYear ? yearBuilt : NaN,
        source: (url || '').trim() || 'unknown'
      } as any;
    };

    // First pass: identify bad lines and attempt cheap parse
    const lineParts: string[][] = [];
    const validLineIndex: number[] = [];
    const initialParsed: (any | null)[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split('|').map(s => s.trim());
      lineParts[i] = parts;
      if (parts.length < 7) { initialParsed[i] = null; continue; }
      const [addrOld] = parts;
      if (!addrOld || /^(address|123\s+main\s+st|example)/i.test(addrOld)) { initialParsed[i] = null; continue; }
      validLineIndex.push(i);
      this.rawCompsFound++;
      initialParsed[i] = useLazyParse ? cheapParse(parts) : null;
    }

    // Collect bad lines for batch LLM parsing
    const badEntries: { id: number; line: string }[] = [];
    for (const idx of validLineIndex) {
      if (!initialParsed[idx]) {
        badEntries.push({ id: idx, line: lines[idx] });
      }
    }

    // Batch in chunks
    const batchSize = Math.max(1, parseInt(String(process.env.LLM_BATCH_SIZE || '12'), 10));
    const batchedParsed: Record<number, any> = {};
    for (let i = 0; i < badEntries.length; i += batchSize) {
      const slice = badEntries.slice(i, i + batchSize);
      const mapped = await this.batchParsePropertyDataWithLLM(slice);
      Object.assign(batchedParsed, mapped);
      // Small delay to be polite and avoid rate limits
      await new Promise(r => setTimeout(r, 150));
    }

    // Second pass: build comps using parsed data (cheap or batched), fallback to single-line LLM if still missing
    for (const idx of validLineIndex) {
      const parts = lineParts[idx];
      const line = lines[idx];
      const [addrOld, priceStr, dateStr, bedsStr, bathsStr, sqftStr, ybStr, url] = parts as any;

      let parsedData: any = initialParsed[idx] || batchedParsed[idx] || null;
      if (!parsedData) {
        // Last resort: single-line LLM
        parsedData = await this.parsePropertyDataWithLLM(line);
      }

      // Start with whatever the LLM returned (may be partial)
      let address = parsedData?.address;
      let price = parsedData?.price;
      let soldDate = parsedData?.soldDate ?? null;
      let beds = parsedData?.beds;
      let baths = parsedData?.baths;
      let sqft = parsedData?.sqft;
      let yearBuilt = parsedData?.yearBuilt;
      let source = parsedData?.source;

      // Enrich/Backfill missing fields from the pipe-delimited line parts
      const parseIntSafe = (s: string) => {
        const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) ? n : NaN;
      };
      const parseFloatSafe = (s: string) => {
        const normalized = String(s).replace(/½/g, '.5').replace(/¼/g, '.25').replace(/¾/g, '.75');
        const n = parseFloat(normalized.replace(/[^\d.]/g, ''));
        return Number.isFinite(n) ? n : NaN;
      };
      const parseDateSafe = (s: string): Date | null => {
        if (!s) return null;
        let d = new Date(s);
        if (!isNaN(d.getTime())) return d;
        let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
        m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (m) return new Date(parseInt(m[3],10), parseInt(m[1],10)-1, parseInt(m[2],10));
        return null;
      };

      if (!address) address = addrOld;
      if (!price || !Number.isFinite(price)) price = parseIntSafe(priceStr);
      if (!soldDate) soldDate = parseDateSafe(dateStr);
      if (!beds || !Number.isFinite(beds)) beds = parseIntSafe(bedsStr);
      if (!baths || !Number.isFinite(baths)) baths = parseFloatSafe(bathsStr);
      if (!sqft || !Number.isFinite(sqft)) sqft = parseIntSafe(sqftStr);
      if (!yearBuilt || !Number.isFinite(yearBuilt)) yearBuilt = parseIntSafe(ybStr);
      if (!source || source === 'unknown') source = url || 'unknown';

      // Only require address; other fields can be enriched later
      if (!address) {
        jobLog(`   ❌ Rejected line: missing address`);
        continue;
      }

      // Basic validation
      if (!Number.isFinite(price) || price <= 0) {
        jobLog(`   ❌ Rejected ${address}: Invalid or missing price (${price})`);
        continue;
      }
      if (!Number.isFinite(sqft) || sqft <= 0) {
        jobLog(`   ❌ Rejected ${address}: Invalid or missing sqft (${sqft})`);
        continue;
      }
      if (sqft < 500 || sqft > 10000) {
        jobLog(`   ❌ Rejected ${address}: Sqft out of range (${sqft})`);
        continue;
      }
      if (!Number.isFinite(beds) || beds < 1 || beds > 10) {
        jobLog(`   ❌ Rejected ${address}: Invalid or missing beds (${beds})`);
        continue;
      }
      if (!Number.isFinite(baths) || baths < 1 || baths > 10) {
        jobLog(`   ❌ Rejected ${address}: Invalid or missing baths (${baths})`);
        continue;
      }
      if (Number.isFinite(yearBuilt) && (yearBuilt < 1900 || yearBuilt > new Date().getFullYear())) {
        jobLog(`   ❌ Rejected ${address}: Invalid year built (${yearBuilt})`);
        continue;
      }

      // SOLD DATE VALIDATION (only if available)
      let ageInMonths = Infinity;
      if (soldDate) {
        const today = new Date();
        const futureBuffer = new Date(today.getTime() + (7 * 24 * 60 * 60 * 1000)); // 7 days ahead
        if (soldDate > futureBuffer) {
          jobLog(`   ❌ Rejected ${address}: Future sold date (${soldDate.toISOString().split('T')[0]}) - today is ${today.toISOString().split('T')[0]}`);
          continue;
        }
        ageInMonths = Math.floor((today.getTime() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
      }

      // ENHANCED FILTERING based on subject property (if available)
      if (subjectDetails) {
        jobLog(`   🔍 FILTERING ${address}: ${beds}BR/${baths}BA, ${sqft}sqft vs Subject: ${subjectDetails.beds}BR/${subjectDetails.baths}BA, ${subjectDetails.sqft}sqft`);

        // 1. Bedroom count: ±1 bedroom max (if beds available)
        if (Number.isFinite(beds)) {
          const bedroomDiff = Math.abs((beds as number) - subjectDetails.beds);
          if (bedroomDiff > 1) {
            jobLog(`   ❌ FILTERED OUT ${address}: bedroom mismatch (${beds}BR vs ${subjectDetails.beds}BR, diff: ${bedroomDiff})`);
            continue;
          } else {
            jobLog(`   ✅ BEDROOM OK ${address}: ${beds}BR vs ${subjectDetails.beds}BR (diff: ${bedroomDiff} ≤ 1)`);
          }
        } else {
          jobLog(`   ℹ️  Skipping bedroom filter: missing beds`);
        }

        // 2. Bathroom filtering with special logic for low bathroom count
        if (!Number.isFinite(baths)) {
          jobLog(`   ℹ️  Skipping bathroom filter: missing baths`);
        } else if (subjectDetails.baths <= 2) {
          // For subject with ≤2 baths, keep all comps with ≤2 baths + separate tracking for >2 bath comps
          if (baths > 2) {
            jobLog(`   📝 Flagged ${address}: high bathroom count for low-bath subject (${baths} vs ${subjectDetails.baths})`);
            // Still include but flag for separate ARV calculation
          }
        } else {
          // For subject with >2 baths, use ±1 bathroom rule (rounded for half baths)
          const bathDiff = Math.abs((baths as number) - subjectDetails.baths);
          if (bathDiff > 1.5) { // Allow up to 1.5 difference to handle half-bath variations
            jobLog(`   ⚠️  Filtered out ${address}: bathroom mismatch (${baths} vs ${subjectDetails.baths}, diff: ${bathDiff.toFixed(1)})`);
            continue;
          }
        }

        // 3. Square footage: ±20% max
        const sqftVariance = Math.abs(sqft - subjectDetails.sqft) / subjectDetails.sqft;
        if (sqftVariance > 0.20) {
          jobLog(`   ⚠️  Filtered out ${address}: size variance too high (${(sqftVariance * 100).toFixed(1)}% > 20% limit)`);
          continue;
        }

        // 4. Age cohort filtering (if comp year built available)
        if (Number.isFinite(yearBuilt)) {
          const ageGroup = this.getAgeGroup(subjectDetails.yearBuilt);
          const compAgeGroup = this.getAgeGroup(yearBuilt as number);
          if (!this.isAdjacentAgeGroup(ageGroup, compAgeGroup)) {
            jobLog(`   ⚠️  Filtered out ${address}: age group mismatch (${compAgeGroup} vs ${ageGroup})`);
            continue;
          }
        } else {
          jobLog(`   ℹ️  Skipping age-group filter: missing year built`);
        }
      }

      // Defer live geocoding to the final stage for surviving comps
      let distance = NaN as any;

      // STRICT SIZE VARIANCE FILTERING (±20%)
      if (subjectDetails) {
        const sizeVariance = Math.abs(sqft - subjectDetails.sqft) / subjectDetails.sqft;
        const MAX_SIZE_VARIANCE = 0.20; // 20%

        if (sizeVariance > MAX_SIZE_VARIANCE) {
          jobLog(`   ❌ REJECTED ${address}: Size variance too high (${(sizeVariance * 100).toFixed(1)}% > ${(MAX_SIZE_VARIANCE * 100)}%)`);
          jobLog(`      Subject: ${subjectDetails.sqft}sqft | Comp: ${sqft}sqft`);
          continue; // Hard rejection
        }

        jobLog(`   ✅ SIZE QUALIFIED ${address}: ${(sizeVariance * 100).toFixed(1)}% variance (within ${(MAX_SIZE_VARIANCE * 100)}% limit)`);
      }

      // TIERED TIME WINDOW FILTERING
      const IDEAL_TIME_MONTHS = 12;
      const MAX_TIME_MONTHS = 18;

      if (Number.isFinite(ageInMonths) && ageInMonths <= IDEAL_TIME_MONTHS) {
        jobLog(`   ✅ TIME QUALIFIED ${address}: Recent sale (${ageInMonths} months)`);
      } else if (Number.isFinite(ageInMonths) && ageInMonths <= MAX_TIME_MONTHS) {
        jobLog(`   ⚠️  TIME EXTENDED ${address}: Extended time range (${ageInMonths} months) - may need market adjustments`);
      } else if (!Number.isFinite(ageInMonths)) {
        jobLog(`   ℹ️  Skipping time window filter for ${address}: missing sold date`);
      } else {
        jobLog(`   ❌ REJECTED ${address}: Too old (${ageInMonths} months > ${MAX_TIME_MONTHS} months)`);
        continue;
      }

      // Format sold date as YYYY-MM-DD string (avoid TZ shift)
      const soldDateStr = (() => {
        if (!soldDate) return '';
        const d = new Date(soldDate.getTime() - soldDate.getTimezoneOffset() * 60000);
        return d.toISOString().split('T')[0];
      })();

      comps.push({
        address: address,
        price,
        sqft,
        beds: Number.isFinite(beds) ? (beds as number) : NaN,
        baths: Number.isFinite(baths) ? (baths as number) : NaN,
        yearBuilt: Number.isFinite(yearBuilt) ? (yearBuilt as number) : null,
        soldDate: soldDateStr,
        distance,
        source: source || 'Vertex AI Grounded Search',
        confidence: Number.isFinite(beds) && Number.isFinite(baths) && Number.isFinite(yearBuilt) ? 'high' : 'medium',
        condition: 'renovated' // Assume renovated for ARV analysis
      });

      jobLog(`   ✅ Added: ${address} - $${price.toLocaleString()} - ${sqft}sqft - Built: ${yearBuilt}`);
    }

    return comps;
  }

  // Prioritize comps for enrichment: prefer those with more complete fields and newer sold dates
  private prioritizeForEnrichment(comps: ComparableProperty[]): ComparableProperty[] {
    const score = (c: ComparableProperty) => {
      let s = 0;
      if (Number.isFinite(c.price)) s += 2;
      if (Number.isFinite(c.sqft)) s += 2;
      if (Number.isFinite(c.beds)) s += 1;
      if (Number.isFinite(c.baths)) s += 1;
      if (c.yearBuilt != null) s += 1;
      if (c.soldDate) s += 1;
      return s;
    };
    const dateValue = (c: ComparableProperty) => {
      const d = c.soldDate ? new Date(c.soldDate) : null;
      return d && !isNaN(d.getTime()) ? d.getTime() : 0;
    };
    return [...comps].sort((a, b) => score(b) - score(a) || dateValue(b) - dateValue(a));
  }


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

  private isAdjacentAgeGroup(group1: string, group2: string): boolean {
    const groups = ['Pre-1940', '1940-1959', '1960-1979', '1980-1999', '2000-2009', '2010-2015', '2016-2019', '2020+'];
    const index1 = groups.indexOf(group1);
    const index2 = groups.indexOf(group2);
    return Math.abs(index1 - index2) <= 1; // Same group or adjacent
  }

  private deduplicateComparables(comps: ComparableProperty[]): ComparableProperty[] {
    const seen = new Set<string>();
    const deduplicated: ComparableProperty[] = [];

    jobLog(`   🔍 DEDUPLICATION ANALYSIS: Starting with ${comps.length} properties`);

    for (const comp of comps) {
      // Normalize address for comparison (lowercase, remove extra spaces)
      const normalizedAddress = comp.address.toLowerCase().trim().replace(/\s+/g, ' ');

      jobLog(`   🔍 CHECKING: "${comp.address}" → normalized: "${normalizedAddress}"`);
      jobLog(`   📊 Property details: $${comp.price?.toLocaleString()} | ${comp.sqft}sqft | ${comp.soldDate} | ${comp.source}`);

      if (!seen.has(normalizedAddress)) {
        seen.add(normalizedAddress);
        deduplicated.push(comp);
        jobLog(`   ✅ KEPT: ${comp.address} (first occurrence)`);
      } else {
        jobLog(`   ❌ DUPLICATE REMOVED: ${comp.address} (already seen as "${normalizedAddress}")`);
        // Show which property was kept vs removed
        const existing = deduplicated.find(d => d.address.toLowerCase().trim().replace(/\s+/g, ' ') === normalizedAddress);
        if (existing) {
          jobLog(`   📊 KEPT: ${existing.address} | $${existing.price?.toLocaleString()} | ${existing.soldDate}`);
          jobLog(`   📊 REMOVED: ${comp.address} | $${comp.price?.toLocaleString()} | ${comp.soldDate}`);
        }
      }
    }

    jobLog(`   📊 Deduplication: ${comps.length} → ${deduplicated.length} unique properties`);
    return deduplicated;
  }

  // Removed filterByPPSFVariance method - using consistent 7.5% threshold in ARV calculation instead

  private async enrichAndRevalidate(
    comps: ComparableProperty[],
    subjectDetails?: { sqft: number; beds: number; baths: number; yearBuilt: number }
  ): Promise<ComparableProperty[]> {
    const enriched: ComparableProperty[] = [];

    for (const comp of comps) {
      let updated = { ...comp };

      // Enrich missing fields (beds/baths/yearBuilt) using property details
      const needsEnrich = !Number.isFinite(updated.beds) || !Number.isFinite(updated.baths) || updated.yearBuilt == null;
      if (needsEnrich) {
        try {
          const details = await fetchPropertyDetailsViaVertex(updated.address, { jobId: this.currentJobId });
          if (details) {
            if (!Number.isFinite(updated.beds) && details.beds != null) updated.beds = details.beds as any;
            if (!Number.isFinite(updated.baths) && details.baths != null) updated.baths = details.baths as any;
            if (updated.yearBuilt == null && details.yearBuilt != null) updated.yearBuilt = details.yearBuilt;
            if (!Number.isFinite(updated.sqft) && details.sqft != null) updated.sqft = details.sqft as any;
          }
        } catch {}
      }

      // Require full set after enrichment
      const hasAll = (
        updated.address &&
        Number.isFinite(updated.price) &&
        typeof updated.soldDate === 'string' && updated.soldDate.length >= 8 &&
        Number.isFinite(updated.sqft) &&
        Number.isFinite(updated.beds) &&
        Number.isFinite(updated.baths) &&
        updated.yearBuilt != null
      );
      if (!hasAll) continue;

      // Re-validate after enrichment; drop if disqualified
      if (!Number.isFinite(updated.price) || updated.price <= 0) continue;
      if (Number.isFinite(updated.sqft) && (updated.sqft < 500 || updated.sqft > 10000)) continue;
      if (Number.isFinite(updated.beds) && (updated.beds! < 1 || updated.beds! > 10)) continue;
      if (Number.isFinite(updated.baths) && (updated.baths! < 1 || updated.baths! > 10)) continue;

      if (subjectDetails) {
        if (Number.isFinite(updated.beds)) {
          const bedDiff = Math.abs((updated.beds as number) - subjectDetails.beds);
          if (bedDiff > 1) continue;
        }
        if (Number.isFinite(updated.baths)) {
          const bathDiff = Math.abs((updated.baths as number) - subjectDetails.baths);
          if (subjectDetails.baths > 2 && bathDiff > 1.5) continue;
        }
        if (Number.isFinite(updated.sqft)) {
          const variance = Math.abs((updated.sqft as number) - subjectDetails.sqft) / subjectDetails.sqft;
          if (variance > 0.20) continue;
        }
        if (Number.isFinite(updated.yearBuilt as any)) {
          const ageGroup = this.getAgeGroup(subjectDetails.yearBuilt);
          const compAge = this.getAgeGroup(updated.yearBuilt as number);
          if (!this.isAdjacentAgeGroup(ageGroup, compAge)) continue;
        }
      }

      // Update confidence if now complete
      updated.confidence = 'high';
      enriched.push(updated);
    }

    return enriched;
  }


  // Geo-proxy client (header-based auth, no OIDC)
  private async geocodeViaProxy(address: string, timeoutMs: number): Promise<{ lat: number; lon: number } | null> {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const body = JSON.stringify({ address });
      const url = new URL(`${GEO_PROXY_URL}/geocode`);

      const req = https.request({
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'content-type': 'application/json',
          'x-proxy-key': PROXY_SHARED_KEY,
          'content-length': Buffer.byteLength(body).toString()
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          const total = Date.now() - t0;
          diag('geocode.proxy.result', { http: { status: res.statusCode }, timingMs: { total } });

          try {
            const j = JSON.parse(data);
            const first = j?.results?.[0];
            if (!first) return resolve(null);
            resolve({ lat: first.geometry.location.lat, lon: first.geometry.location.lng });
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', (e: any) => {
        clearTimeout(timer);
        diag('geocode.proxy.error', { msg: e.message, timingMs: { total: Date.now() - t0 } });
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }

  private async geocodeWithTimeout(address: string, timeoutMs: number): Promise<{ lat: number; lon: number } | null> {
    const normalizedAddress = this.normalizeAddress(address);
    const addressHash = createHash('md5').update(normalizedAddress).digest('hex').slice(0, 8);

    // Cache bypass for testing (respects GEOCODE_BYPASS_CACHE env var)
    if (!GEOCODE_BYPASS_CACHE && this.geocodeCache.has(normalizedAddress)) {
      diag('geocode.cache_hit', { addressHash, timeoutMs });
      return this.geocodeCache.get(normalizedAddress)!;
    }
    diag('geocode.cache_miss', { addressHash, timeoutMs, bypass: GEOCODE_BYPASS_CACHE });

    // Use geo-proxy if enabled (feature-flagged)
    if (USE_GEO_PROXY) {
      diag('geocode.proxy.call', { addressHash, timeoutMs, url: GEO_PROXY_URL });
      return await this.geocodeViaProxy(normalizedAddress, timeoutMs);
    }

    // DNS/VIP fingerprinting (async, non-blocking)
    dns.lookup('maps.googleapis.com', { all: true }, (err, addrs) => {
      const a = (addrs || []).map(x => ({ address: x.address, family: x.family }));
      const restrictedVip = a.some(x => /^199\.36\.153\.[0-7]$/.test(x.address));
      const privateVip = a.some(x => /^199\.36\.153\.(8|9|1\d|2\d|3[0-1])$/.test(x.address));
      diag('geocode.dns', { addressHash, err: err?.message || null, addrs: a, restrictedVip, privateVip });
    });

    return new Promise((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          diag('geocode.timeout', { addressHash, timeoutMs });
          resolve(null);
        }
      }, timeoutMs);

      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(normalizedAddress)}&key=${this.googleMapsApiKey}&components=country:US&region=us`;
      const started = Date.now();
      let firstByteAt = 0;

      const req = https.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.once('data', () => { if (!firstByteAt) firstByteAt = Date.now(); });
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);

          const total = Date.now() - started;
          const ttfb = firstByteAt ? (firstByteAt - started) : total;
          const body = Buffer.concat(chunks);

          diag('geocode.result', {
            addressHash,
            http: { status: res.statusCode, bytes: body.length },
            timingMs: { total, ttfb }
          });

          try {
            const parsed = JSON.parse(body.toString());
            if (parsed.results?.length > 0) {
              const result = parsed.results[0];
              const coords = { lat: result.geometry.location.lat, lon: result.geometry.location.lng };
              this.geocodeCache.set(normalizedAddress, coords);
              diag('geocode.success', { addressHash, timingMs: { total } });
              resolve(coords);
            } else {
              diag('geocode.no_results', { addressHash, status: parsed.status, errorMsg: parsed.error_message || null });
              resolve(null);
            }
          } catch (error) {
            diag('geocode.parse_error', { addressHash, error: String(error) });
            resolve(null);
          }
        });
      });

      // Per-stage timing (DNS/TCP/TLS)
      req.on('socket', (s: any) => {
        const t0 = Date.now();
        s.on('lookup', () => diag('geocode.timing', { addressHash, stage: 'dns', ms: Date.now() - t0 }));
        s.on('connect', () => diag('geocode.timing', { addressHash, stage: 'tcp', ms: Date.now() - t0 }));
        s.on('secureConnect', () => diag('geocode.timing', { addressHash, stage: 'tls', ms: Date.now() - t0 }));
      });

      req.on('timeout', () => {
        diag('geocode.timeout', { addressHash, timeoutMs });
      });

      req.on('error', (e: any) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        diag('geocode.error', { addressHash, code: e.code || null, msg: e.message || String(e) });
        resolve(null);
      });

      req.setTimeout(timeoutMs, () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        req.destroy();
        diag('geocode.timeout', { addressHash, timeoutMs });
        resolve(null);
      });
    });
  }

  private normalizeAddress(address: string): string {
    return address
      // Standardize street type abbreviations
      .replace(/\bterrace\b/gi, 'Terrace')
      .replace(/\bter\b/gi, 'Terrace')
      .replace(/\bdr\b/gi, 'Drive')
      .replace(/\bst\b/gi, 'Street')
      .replace(/\bave\b/gi, 'Avenue')
      .replace(/\brd\b/gi, 'Road')
      .replace(/\bln\b/gi, 'Lane')
      .replace(/\bct\b/gi, 'Court')
      .replace(/\bpl\b/gi, 'Place')
      // Normalize spacing and commas
      .replace(/\s*,\s*/g, ', ')  // Standardize comma spacing
      .replace(/,\s*(GA|Georgia)\s*,?\s*/gi, ', GA ')  // Fix GA comma placement
      .replace(/\s+/g, ' ')  // Normalize multiple spaces
      // Handle city name variations for East Point area
      .replace(/\bAtlanta,\s*GA\s*30344\b/gi, 'East Point, GA 30344')
      .trim();
  }
}

// Test function
async function testFindComparables() {
  const address = process.env.ADDRESS;
  if (!address) {
    console.error('❌ ADDRESS environment variable is required');
    process.exit(1);
  }

  jobLog('📍 GEOCODING:', address);
  const service = new VertexComparableSearchService();

  // Get coordinates for display
  const coords = await service['geocodeWithTimeout'](address, 5000);
  if (coords) {
    jobLog(`   ✅ Coordinates: ${coords.lat}, ${coords.lon}`);
  }

  jobLog('\n🔍 STEP 3: FINDING COMPARABLES');
  jobLog('============================================================');

  const result = await service.findComparables(address);

  if (result.success && result.comparables.length > 0) {
    jobLog(`✅ Found ${result.comparables.length} comparables:`);
    result.comparables.forEach((comp, i) => {
      jobLog(`   ${i + 1}. ${comp.address}`);
      jobLog(`      Price: $${comp.price.toLocaleString()}`);
      jobLog(`      Size: ${comp.sqft} sqft (${comp.beds}bd/${comp.baths}ba)`);
      jobLog(`      Built: ${comp.yearBuilt}`);
      jobLog(`      Sold: ${comp.soldDate}`);
      jobLog(`      Distance: ${comp.distance.toFixed(2)} miles`);
      jobLog(`      Source: ${comp.source}`);
      jobLog('');
    });
  } else {
    jobLog('❌ No comparables found');
    if (result.error) {
      jobLog(`   Error: ${result.error}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testFindComparables().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}

export { VertexComparableSearchService, type ComparableProperty, type FindComparablesResult };
// Backward-compatible alias for existing imports
export { VertexComparableSearchService as ComparableSearchService };
