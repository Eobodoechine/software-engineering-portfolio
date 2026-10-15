import 'dotenv/config';
import https from 'https';
import { jobLog } from './utils/jobLogger';
import { getLocalDemoToken, localDemoEnabled } from './utils/localDemo.js';
import { GoogleAuth } from 'google-auth-library';
import { withVertexLimiter } from './vertex-limiter';
import { getRedisCache } from './utils/redisCache';
import { normalizeAddress } from './utils/addressNormalizer';

const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// Phase A: Structured logging helper for metrics collection
const logJSON = (kind: string, extra: Record<string, any> = {}) => {
  try {
    jobLog(JSON.stringify({ t: Date.now(), kind, ...extra }));
  } catch {}
};

// Phase B: Parse real 429 signals from Google error.details
/**
 * Robust parser for RetryInfo and QuotaFailure from error.details
 * Handles multiple field name variations (camelCase, snake_case)
 * Returns signals exactly as Google provides them (no hardcoded assumptions)
 */
function parse429Signals(details?: any[]): {
  has_retry_info: boolean;
  retry_delay_ms?: number;
  has_quota_failure: boolean;
  quota_id?: string;
  mechanism_reported?: 'retry_info' | 'quota_failure';
} {
  const out: any = { has_retry_info: false, has_quota_failure: false };

  if (Array.isArray(details)) {
    for (const d of details) {
      const t = d?.['@type'] || d?.type || '';

      // Parse RetryInfo (with field name variations)
      if (t.includes('RetryInfo')) {
        out.has_retry_info = true;
        const dur = d?.retryDelay || d?.retry_delay || {};
        const sec = Number(dur.seconds || 0);
        const ns = Number(dur.nanos || 0);
        out.retry_delay_ms = sec * 1000 + Math.round(ns / 1e6);
        out.mechanism_reported = 'retry_info';
      }

      // Parse QuotaFailure (with field name variations)
      if (t.includes('QuotaFailure')) {
        out.has_quota_failure = true;
        const v = d?.violations?.[0] || {};
        out.quota_id = v.subject || v.description || v.metric || null;
        out.mechanism_reported ||= 'quota_failure';
      }
    }
  }

  return out;
}

export type BasicDetails = {
  address: string;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  yearBuilt: number | null;
  lotSize: number | null;
  subdivision: string | null;
  propertyType: string | null;
  success: boolean;
  confidence?: Partial<Record<'sqft'|'beds'|'baths'|'yearBuilt'|'propertyType'|'subdivision', number>>;
  source?: 'primary' | 'county' | 'reconciled';
};

// JSON Schema for BasicDetails - prevents truncated responses
const BASIC_DETAILS_SCHEMA = {
  type: 'object',
  properties: {
    sqft: { type: 'number', nullable: true },
    beds: { type: 'number', nullable: true },
    baths: { type: 'number', nullable: true },
    yearBuilt: { type: 'number', nullable: true },
    propertyType: { type: 'string', nullable: true, enum: ['single-family detached', 'townhome', 'condo', 'duplex', 'multi-family', null] },
    subdivision: { type: 'string', nullable: true },
    confidence: {
      type: 'object',
      nullable: true,
      properties: {
        sqft: { type: 'number', minimum: 0, maximum: 1 },
        beds: { type: 'number', minimum: 0, maximum: 1 },
        baths: { type: 'number', minimum: 0, maximum: 1 },
        yearBuilt: { type: 'number', minimum: 0, maximum: 1 },
        propertyType: { type: 'number', minimum: 0, maximum: 1 },
        subdivision: { type: 'number', minimum: 0, maximum: 1 }
      }
    }
  }
};

// SPD Timeout Configuration (VPC-aware)
// Grounded searches through VPC can take 60-90 seconds due to private-ranges-only egress overhead
const SPD_PRIMARY_TIMEOUT_MS = Number(process.env.SPD_PRIMARY_TIMEOUT_MS ?? 90000);  // 90s for VPC + grounded search overhead
const SPD_COUNTY_TIMEOUT_MS = Number(process.env.SPD_COUNTY_TIMEOUT_MS ?? 90000);    // 90s for VPC + grounded search overhead
const SPD_PARSE_TIMEOUT_MS = Number(process.env.SPD_PARSE_TIMEOUT_MS ?? 30000);      // 30s for non-grounded parsing (also through VPC)
const SPD_GRACE_WINDOW_MS = Number(process.env.SPD_GRACE_WINDOW_MS ?? 10000);        // 10s grace for reconciliation

function hasServiceAccount(): boolean {
  // On Cloud Run we always have ADC from the attached service account.
  // Still allow JSON creds when explicitly provided (local dev).
  return true;
}

async function getCloudAuthClient() {
  const b64 = process.env.GCP_SA_JSON_B64;
  const jsonUtf8 = process.env.GCP_SA_JSON || process.env.SERVICE_ACCOUNT_JSON;

  if (b64 || jsonUtf8) {
    // Explicit SA JSON provided
    const json = b64 ? Buffer.from(b64, 'base64').toString('utf8') : jsonUtf8!;
    const credentials = JSON.parse(json);
    const auth = new GoogleAuth({ credentials, scopes: VERTEX_SCOPES });
    return auth.getClient();
  }

  // Fallback: ADC (uses GOOGLE_APPLICATION_CREDENTIALS automatically)
  const auth = new GoogleAuth({ scopes: VERTEX_SCOPES });
  return auth.getClient();
}

async function resolveProjectId(auth?: GoogleAuth) {
  const explicit =
    process.env.VERTEX_AI_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;
  if (explicit) return explicit;
  const a = auth ?? new GoogleAuth();
  const pid = await a.getProjectId();
  return typeof pid === 'string' ? pid : String(pid);
}

function resolveLocation() {
  return process.env.VERTEX_AI_LOCATION || 'us-central1';
}

async function getAccessTokenViaAuth(): Promise<string> {
  if (localDemoEnabled()) return getLocalDemoToken();
  const authClient = await getCloudAuthClient();
  const tokenObj = await authClient.getAccessToken();
  const token = typeof tokenObj === 'string'
    ? tokenObj
    : tokenObj?.token;
  if (!token) throw new Error('Failed to obtain access token via ADC');
  return token;
}

async function httpsPostJson(url: string, payload: any, headers: Record<string,string>, timeoutMs: number): Promise<any> {
  return await new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString(), ...headers } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);

    // Set socket timeout to prevent hanging requests (critical for VPC grounded searches)
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`socket hang up`));
    });

    req.write(body);
    req.end();
  });
}

async function vertexGenerate(opts: {
  caller?: string;
  token: string;
  projectId: string;
  location: string;
  model: string;
  prompt: string;
  grounded: boolean;
  json: boolean;
  timeoutMs: number;
  responseSchema?: any;
  jobId?: string;
}): Promise<string> {
  const caller = opts.caller || 'vertex-details-unknown';
  const jobId = opts.jobId || 'unknown';
  const token = opts.token;
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${opts.projectId}/locations/${opts.location}/publishers/google/models/${opts.model}:generateContent`;
  const payload: any = {
    contents: [ { role: 'user', parts: [ { text: opts.prompt } ] } ],
    generationConfig: {
      temperature: 0,           // Maximum determinism
      seed: 12345,             // Fixed seed for reproducibility
      maxOutputTokens: 8192,   // Increased from 1500 to prevent truncation
      ...(opts.json ? { responseMimeType: 'application/json' } : {})
    },
  };
  // Use legacy grounding tool name expected by this project
  if (opts.grounded) payload.tools = [ { google_search: {} } as any ];
  if (opts.responseSchema) (payload.generationConfig as any).responseSchema = opts.responseSchema;

  // Retry logic for rate limiting (429) errors
  const MAX_RETRIES = 3;
  const RETRY_BASE_DELAY_MS = 1000;  // Exponential backoff: 1s, 2s, 4s
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const isRetry = attempt > 1;

    if (isRetry) {
      jobLog(`🔄 SPD_VERTEX_RETRY: caller=${caller}, attempt=${attempt}/${MAX_RETRIES}`);
    } else {
      jobLog(`📞 SPD_VERTEX_CALL from ${caller}`);
    }

    // Phase A: Log structured call start
    const callStart = Date.now();
    logJSON('VERTEX_CALL_START', { attempt, caller });

    try {
      const res = await httpsPostJson(endpoint, payload, { Authorization: `Bearer ${token}` }, opts.timeoutMs);

      // Add error checking and logging
      if (!res) {
        jobLog(`❌ SPD_VERTEX_EXIT_NULL_RESPONSE: caller=${caller}, attempt=${attempt}`);
        return '';
      }

      if (!res.candidates) {
        if (res.error) {
          const errorCode = res.error.code || 'unknown';
          const errorStatus = res.error.status || 'unknown';

          // Check if this is a retryable error (429 rate limiting)
          const isRateLimitError = errorCode === 429 || errorStatus === 'RESOURCE_EXHAUSTED';
          const hasRetriesLeft = attempt < MAX_RETRIES;

          jobLog(`❌ SPD_VERTEX_EXIT_NO_CANDIDATES: caller=${caller}, attempt=${attempt}/${MAX_RETRIES}, reason=${errorStatus}, httpCode=${errorCode}, error=${JSON.stringify(res.error)}`);

          // Phase B: Log 429 errors with real Google signals (no hardcoded assumptions)
          if (isRateLimitError) {
            const latencyMs = Date.now() - callStart;
            const signals = parse429Signals(res.error.details);

            // SDK path typically doesn't expose HTTP headers, only error.details
            const headersAvailable = !!(res && (res as any).headers);

            logJSON('429_DIAG', {
              schema_version: 'v2',
              job_id: jobId,
              run_label: process.env.RUN_LABEL,
              attempt,
              caller,
              status: errorStatus,
              code: errorCode,
              msg: (res.error.message || '').slice(0, 240),
              latencyMs,
              // Headers (SDK path may not have these)
              headers_available: headersAvailable,
              x_goog_request_id: (res as any).headers?.['x-goog-request-id'] || null,
              retry_after_header: (res as any).headers?.['retry-after'] || null,
              // Config echo for self-contained analysis
              concurrency: process.env.VERTEX_CONCURRENCY_LIMIT,
              pacing_ms: process.env.VERTEX_PACING_MS,
              // Real signals from Google (Phase B enhancement)
              mechanism_reported: signals.mechanism_reported,
              retry_delay_ms: signals.retry_delay_ms,
              quota_id: signals.quota_id,
              has_retry_info: signals.has_retry_info,
              has_quota_failure: signals.has_quota_failure
            });
          }

          if (isRateLimitError && hasRetriesLeft) {
            // Enforce server-provided backoff if available
            const signals = parse429Signals(res.error.details);
            let delayMs: number;
            let backoffSource: string;

            // Priority: server signals > client exponential backoff
            if (signals.retry_delay_ms && signals.retry_delay_ms > 0) {
              delayMs = signals.retry_delay_ms;
              backoffSource = 'server_retry_info';
            } else if ((res as any).headers?.['retry-after']) {
              const retryAfterSec = parseInt((res as any).headers['retry-after'], 10);
              delayMs = retryAfterSec * 1000;
              backoffSource = 'server_retry_after_header';
            } else {
              // Client exponential backoff with jitter
              const jitter = Math.random() * 1000;
              delayMs = (RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)) + jitter;
              backoffSource = 'client_exponential';
            }

            logJSON('BACKOFF_SCHEDULED', {
              attempt,
              caller,
              delay_ms: delayMs,
              backoff_source: backoffSource
            });

            jobLog(`⏳ SPD_VERTEX_RETRY_SCHEDULED: caller=${caller}, waiting ${Math.floor(delayMs)}ms (${backoffSource}) before retry ${attempt + 1}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            lastError = res.error;
            continue;  // Retry
          }
        } else {
          jobLog(`❌ SPD_VERTEX_EXIT_NO_CANDIDATES: caller=${caller}, attempt=${attempt}, reason=NO_ERROR_OBJECT`);
        }
        return '';
      }

      const text = res?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') || '';

      if (!text || text.length === 0) {
        jobLog(`❌ SPD_VERTEX_EXIT_EMPTY_TEXT: caller=${caller}, attempt=${attempt}`);
      } else {
        if (isRetry) {
          jobLog(`✅ SPD_VERTEX_RETRY_SUCCESS: caller=${caller}, succeeded after ${attempt} attempts, textLength=${text.length}`);
        } else {
          jobLog(`✅ SPD_VERTEX_SUCCESS: caller=${caller}, textLength=${text.length}`);
        }
      }

      // Phase A: Log successful call with latency
      const latencyMs = Date.now() - callStart;
      logJSON('DIAG_RESPONSE_RECEIVED', { attempt, caller, status: 'ok', latencyMs });

      return text;

    } catch (error: any) {
      lastError = error;
      const latencyMs = Date.now() - callStart;
      jobLog(`❌ SPD_VERTEX_HTTP_ERROR: caller=${caller}, attempt=${attempt}/${MAX_RETRIES}, error=${error.message}`);

      // Phase A: Log non-429 errors with structured format
      logJSON('ERROR_NON429', {
        attempt,
        caller,
        code: error?.code ?? 'ERR',
        msg: (error?.message || '').slice(0, 240),
        latencyMs
      });

      // Don't retry network errors, only retry 429 from API
      break;
    }
  }

  jobLog(`🛑 SPD_VERTEX_EXHAUSTED: caller=${caller}, failed after ${MAX_RETRIES} attempts`);
  return '';
}

/**
 * Parse grounded text into structured JSON using non-grounded LLM
 * This replaces multiple grounded extraction calls with a single non-grounded parse
 */
async function parseTextToJSON(
  text: string,
  ctx: { token: string; projectId: string; location: string; model: string; jobId?: string }
): Promise<Partial<BasicDetails>> {
  const startTime = Date.now();

  const prompt = `You are a precise, highly-reliable property data extractor. Your sole function is to process the provided text and return a complete and valid JSON object following the required schema.

CRITICAL RULES:
1. **Extract All Available Fields**: You MUST extract all fields (sqft, beds, baths, yearBuilt) if the information is clearly present in the "TEXT TO PARSE" section below.
2. **Omission Rule**: ONLY omit a field from the final JSON object if the value is explicitly not found or genuinely unclear in the provided text.
3. **Data Integrity**: You MUST return numeric fields (sqft, beds, yearBuilt) as **integers**. The 'baths' field must be a **float** (e.g., 3.0, 3.5).
4. **Format Adherence**: Return **valid JSON only**, with no preamble, explanation, or conversational text.
5. **Thoroughness**: Scan the entire text carefully for bedroom and bathroom counts - they are CRITICAL fields and almost always present.

Extract these fields:
- sqft: interior living area square footage (integer)
- beds: number of bedrooms (integer) - REQUIRED if present in text
- baths: number of bathrooms including half baths (float, e.g., 2.5) - REQUIRED if present in text
- yearBuilt: year the property was built (integer)
- propertyType: one of: "single-family detached", "townhome", "condo", "duplex", "multi-family" (string)
- subdivision: subdivision or neighborhood name (string)
- confidence: for each extracted field, estimate confidence 0.0-1.0 based on source clarity (object)

TEXT TO PARSE:
${text}

Return JSON with this exact structure:
{
  "sqft": <integer>,
  "beds": <integer>,
  "baths": <float>,
  "yearBuilt": <integer>,
  "propertyType": "<type>",
  "subdivision": "<name>",
  "confidence": {
    "sqft": <number>,
    "beds": <number>,
    "baths": <number>,
    "yearBuilt": <number>,
    "propertyType": <number>,
    "subdivision": <number>
  }
}`;

  // Retry logic with exponential backoff for truncated JSON responses
  const MAX_RETRIES = 2;
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      jobLog(`   🔍 Calling non-grounded Vertex AI for JSON parsing (attempt ${attempt}/${MAX_RETRIES}, timeout: ${SPD_PARSE_TIMEOUT_MS}ms)...`);
      const responseText = await vertexGenerate({
        caller: 'subject_property_parse_json',
        ...ctx,
        prompt,
        grounded: false,  // CRITICAL: No web search, just parse the provided text
        json: true,       // Request JSON output
        responseSchema: BASIC_DETAILS_SCHEMA,  // Use schema to prevent truncation
        timeoutMs: SPD_PARSE_TIMEOUT_MS,
      });

      const duration = Date.now() - startTime;
      jobLog(`   ✅ Vertex AI response received in ${duration}ms (${responseText.length} chars)`);
      jobLog(`   📄 FULL VERTEX RESPONSE: ${responseText}`);

      try {
        const parsed = JSON.parse(responseText);
        jobLog(`   ✅ JSON.parse() successful: parsed ${Object.keys(parsed).length} fields`);
        jobLog(`   📋 PARSED FIELDS: ${JSON.stringify(parsed, null, 2)}`);

        // Validate critical fields - retry if missing
        const missingFields: string[] = [];
        if (!parsed.sqft) missingFields.push('sqft');
        if (!parsed.beds) missingFields.push('beds');
        if (!parsed.baths) missingFields.push('baths');
        if (!parsed.yearBuilt) missingFields.push('yearBuilt');

        if (missingFields.length > 0) {
          console.error(`   ❌ Validation failed on attempt ${attempt}/${MAX_RETRIES}: missing ${missingFields.join(', ')}`);
          console.error(`   📄 Response text with missing fields (first 1000 chars): "${responseText.substring(0, 1000)}"`);
          lastError = new Error(`Missing critical fields: ${missingFields.join(', ')}`);

          // If not last attempt, retry with jitter
          if (attempt < MAX_RETRIES) {
            const jitter = Math.random() * 500; // 0-500ms random jitter
            const backoffMs = (1000 * Math.pow(2, attempt - 1)) + jitter;
            jobLog(`   🔄 Retrying in ${Math.floor(backoffMs)}ms (with jitter) due to missing fields...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue; // Retry the loop
          }

          // Last attempt failed - return partial data for reconciliation
          console.error(`   ⚠️  Max retries reached - returning partial data for reconciliation`);
        }

        jobLog(`   ⚡ Non-grounded JSON parse completed in ${duration}ms`);

        // Post-process: Normalize numeric fields to handle precision issues
        if (parsed.sqft) parsed.sqft = Math.floor(Number(parsed.sqft));
        if (parsed.beds) parsed.beds = Math.floor(Number(parsed.beds));
        if (parsed.baths) parsed.baths = Number(Number(parsed.baths).toFixed(1)); // Round to 1 decimal
        if (parsed.yearBuilt) parsed.yearBuilt = Math.floor(Number(parsed.yearBuilt));

        jobLog(`   🔧 Post-processed values: sqft=${parsed.sqft}, beds=${parsed.beds}, baths=${parsed.baths}, yearBuilt=${parsed.yearBuilt}`);

        return parsed;
      } catch (jsonError) {
        console.error(`   ❌ JSON.parse() failed on attempt ${attempt}/${MAX_RETRIES} after ${duration}ms:`, jsonError);
        console.error(`   📄 Response text that failed to parse (first 500 chars): "${responseText.substring(0, 500)}"`);
        lastError = jsonError;

        // If not last attempt, wait before retrying with exponential backoff and jitter
        if (attempt < MAX_RETRIES) {
          const jitter = Math.random() * 500; // 0-500ms random jitter
          const backoffMs = (1000 * Math.pow(2, attempt - 1)) + jitter; // 1s, 2s, 4s + jitter
          jobLog(`   🔄 Retrying in ${Math.floor(backoffMs)}ms (with jitter)...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`   ❌ Vertex AI call failed on attempt ${attempt}/${MAX_RETRIES} after ${duration}ms:`, error);
      if (error instanceof Error) {
        console.error(`   📋 Error message: ${error.message}`);
        console.error(`   📋 Error stack: ${error.stack?.split('\n')[0]}`);
      }
      lastError = error;

      // If not last attempt, wait before retrying with jitter
      if (attempt < MAX_RETRIES) {
        const jitter = Math.random() * 500; // 0-500ms random jitter
        const backoffMs = (1000 * Math.pow(2, attempt - 1)) + jitter;
        jobLog(`   🔄 Retrying in ${Math.floor(backoffMs)}ms (with jitter)...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  console.error(`   ❌ All ${MAX_RETRIES} attempts failed. Last error:`, lastError);
  return {};
}

/**
 * Reconcile primary and county results with authority preference
 * County is authoritative for sqft/yearBuilt, primary for other fields
 */
function reconcileResults(
  primary: Partial<BasicDetails>,
  county: Partial<BasicDetails>,
  primaryWon: boolean
): BasicDetails {
  jobLog(`   🔄 Reconciling: primary (${primaryWon ? 'winner' : 'loser'}) vs county (${primaryWon ? 'loser' : 'winner'})`);
  jobLog(`   📊 Primary data: sqft=${primary.sqft}, beds=${primary.beds}, baths=${primary.baths}, yearBuilt=${primary.yearBuilt}, type=${primary.propertyType}`);
  jobLog(`   📊 County data: sqft=${county.sqft}, beds=${county.beds}, baths=${county.baths}, yearBuilt=${county.yearBuilt}, type=${county.propertyType}`);

  const winner = primaryWon ? primary : county;
  const loser = primaryWon ? county : primary;

  // Authority preference: county for sqft/yearBuilt, winner for others
  const reconciled: Partial<BasicDetails> = {
    // Prefer county for authoritative fields (tax assessor data)
    sqft: county.sqft || primary.sqft,
    yearBuilt: county.yearBuilt || primary.yearBuilt,

    // Prefer winner for other fields (faster, less critical)
    beds: winner.beds || loser.beds,
    baths: winner.baths || loser.baths,
    propertyType: winner.propertyType || loser.propertyType,
    subdivision: winner.subdivision || loser.subdivision,

    // Merge confidence scores
    confidence: {
      sqft: Math.max(county.confidence?.sqft ?? 0, primary.confidence?.sqft ?? 0),
      beds: Math.max(winner.confidence?.beds ?? 0, loser.confidence?.beds ?? 0),
      baths: Math.max(winner.confidence?.baths ?? 0, loser.confidence?.baths ?? 0),
      yearBuilt: Math.max(county.confidence?.yearBuilt ?? 0, primary.confidence?.yearBuilt ?? 0),
      propertyType: Math.max(winner.confidence?.propertyType ?? 0, loser.confidence?.propertyType ?? 0),
      subdivision: Math.max(winner.confidence?.subdivision ?? 0, loser.confidence?.subdivision ?? 0),
    },

    source: 'reconciled' as const,
  };

  jobLog(`   ✅ Reconciliation complete:`);
  jobLog(`      - sqft=${reconciled.sqft} (from ${county.sqft ? 'county' : 'primary'})`);
  jobLog(`      - yearBuilt=${reconciled.yearBuilt} (from ${county.yearBuilt ? 'county' : 'primary'})`);
  jobLog(`      - beds=${reconciled.beds} (from ${primaryWon ? 'primary' : 'county'})`);
  jobLog(`      - baths=${reconciled.baths} (from ${primaryWon ? 'primary' : 'county'})`);
  jobLog(`      - type=${reconciled.propertyType} (from ${primaryWon ? 'primary' : 'county'})`);

  return reconciled as BasicDetails;
}

/**
 * Sleep promise for grace window timeout
 */
function sleep(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('grace window expired')), ms));
}

// [DEPRECATED] Old sequential parsing function - replaced by parseTextToJSON
// Keeping below for reference only, not used in optimized SPD flow
/*
async function parseFreeformWithLLM(text: string, sa: any, projectId: string, location: string, model: string, address?: string): Promise<Partial<BasicDetails>> {
  jobLog(`   🤖 Starting LLM extraction for property details...`);
  try {
    // STEP 1: Validation extraction - send raw data back for clean parsing
    jobLog(`   🔍 Step 1: Validation extraction from raw data...`);
    const validationPrompt = `Extract property details from this text. You MUST provide ALL five values - if any value is not found, write "UNKNOWN":

"${text}"

Find these details:
- Square footage (house living area only, not lot size)
- Number of bedrooms
- Number of bathrooms (including half baths as decimals like 1.5)
- Year built
- Property type (single-family detached, townhome, condo, duplex, multi-family)

Respond in this EXACT format (provide ALL five lines):
SQFT: [number or UNKNOWN]
BEDS: [number or UNKNOWN]
BATHS: [number or UNKNOWN]
YEAR: [4-digit year or UNKNOWN]
TYPE: [property type or UNKNOWN]`;

    const validationResponse = await vertexGenerate({
      sa, projectId, location, model,
      prompt: validationPrompt,
      grounded: true,
      json: false,
      timeoutMs: 10000
    });

    jobLog(`   🔍 Validation response: "${validationResponse}"`);
    const validationData = parsePropertyResponse(validationResponse);
    jobLog(`   🔍 Validation extracted: sqft=${validationData.sqft}, beds=${validationData.beds}, baths=${validationData.baths}, year=${validationData.yearBuilt}`);

    // Check if validation got all critical fields - but continue to verify with fallback
    const hasAllCriticalFields = validationData.sqft && validationData.beds && validationData.baths && validationData.yearBuilt;
    if (hasAllCriticalFields) {
      jobLog(`   ✅ Validation found all critical fields - but continuing to verify with fallback for accuracy`);
      // Don't return early - continue to fallback to verify/improve the data
    }

    jobLog(`   🔍 Continuing with original extraction for comparison and verification...`);

    // STEP 2: Original LLM extraction logic for comparison and verification
    jobLog(`   🔍 Step 2: Original extraction logic for comparison...`);

    // Extract square footage using LLM - ask for clean number only
    const sqftPrompt = `Extract the house square footage (interior living space only, not lot size) from this text. Return ONLY the number with no commas, units, or other text:

"${text}"`;

    const sqftResponse = await vertexGenerate({
      sa, projectId, location, model,
      prompt: sqftPrompt,
      grounded: true,
      json: false,
      timeoutMs: 10000
    });

    jobLog(`   🔍 Original sqft response: "${sqftResponse}"`);
    const sqft = sqftResponse && sqftResponse.trim() ? Number(sqftResponse.trim()) : null;
    jobLog(`   🔍 Original sqft parsed: ${sqft}`);

    // Extract bedrooms using LLM
    const bedsPrompt = `Extract the number of bedrooms from this text. Return ONLY the number:

"${text}"`;

    const bedsResponse = await vertexGenerate({
      sa, projectId, location, model,
      prompt: bedsPrompt,
      grounded: true,
      json: false,
      timeoutMs: 10000
    });

    jobLog(`   🔍 Original beds response: "${bedsResponse}"`);
    const beds = bedsResponse && bedsResponse.trim() ? Number(bedsResponse.trim()) : null;
    jobLog(`   🔍 Original beds parsed: ${beds}`);

    // Extract bathrooms using LLM
    const bathsPrompt = `Extract the number of bathrooms (including half baths as 0.5) from this text. Return ONLY the number (use decimals like 2.5):

"${text}"`;

    const bathsResponse = await vertexGenerate({
      sa, projectId, location, model,
      prompt: bathsPrompt,
      grounded: true,
      json: false,
      timeoutMs: 10000
    });

    jobLog(`   🔍 Original baths response: "${bathsResponse}"`);
    const baths = bathsResponse && bathsResponse.trim() ? Number(bathsResponse.trim()) : null;
    jobLog(`   🔍 Original baths parsed: ${baths}`);

    // Extract year built using LLM
    const yearPrompt = `Extract the year this property was built from this text. Return ONLY the 4-digit year:

"${text}"`;

    const yearResponse = await vertexGenerate({
      sa, projectId, location, model,
      prompt: yearPrompt,
      grounded: true,
      json: false,
      timeoutMs: 10000
    });

    jobLog(`   🔍 Original year response: "${yearResponse}"`);
    const yearBuilt = yearResponse && yearResponse.trim() ? Number(yearResponse.trim()) : null;
    jobLog(`   🔍 Original year parsed: ${yearBuilt}`);

    // Try to extract subdivision/neighborhood from text
    let subdivision: string | null = null;
    try {
      const subPrompt = `From this text, what is the subdivision or neighborhood name of the property? If not present, answer UNKNOWN.\n\n"${text}"\n\nRespond with only the name or UNKNOWN.`;
      const subResp = await vertexGenerate({ sa, projectId, location, model, prompt: subPrompt, grounded: true, json: false, timeoutMs: 600000 });
      const cleaned = (subResp || '').trim();
      if (cleaned && !/^unknown$/i.test(cleaned)) {
        subdivision = cleaned.replace(/^[-\s:]+/, '').trim();
      }
    } catch {}

    // Try to extract property type from text
    let propertyType: string | null = null;
    try {
      jobLog(`   🏠 Extracting property type from text...`);
      const typePrompt = `From this text, what is the property type? Answer with one of: single-family detached, townhome, condo, duplex, multi-family, or UNKNOWN.\n\n"${text}"\n\nRespond with only one of those exact terms.`;
      const typeResp = await vertexGenerate({ sa, projectId, location, model, prompt: typePrompt, grounded: true, json: false, timeoutMs: 600000 });
      jobLog(`   🏠 Raw property type response: "${typeResp}"`);
      const cleaned = (typeResp || '').trim().toLowerCase();
      if (cleaned && !/^unknown$/i.test(cleaned)) {
        // Normalize property type terms
        if (cleaned.includes('duplex')) propertyType = 'duplex';
        else if (cleaned.includes('multi-family') || cleaned.includes('multifamily')) propertyType = 'multi-family';
        else if (cleaned.includes('condo')) propertyType = 'condo';
        else if (cleaned.includes('townhome') || cleaned.includes('townhouse')) propertyType = 'townhome';
        else if (cleaned.includes('single-family') || cleaned.includes('single family')) propertyType = 'single-family detached';
        jobLog(`   🏠 Normalized property type: "${propertyType}"`);
      } else {
        jobLog(`   🏠 Property type extraction returned: "${cleaned}" (treating as unknown)`);
      }
    } catch (error) {
      jobLog(`   ❌ Property type extraction failed: ${error}`);
    }

    const originalData = { sqft, beds, baths, yearBuilt, lotSize: null, subdivision, propertyType };
    jobLog(`   🤖 Original LLM Extraction: SQFT=${sqft}, Beds=${beds}, Baths=${baths}, Built=${yearBuilt}${subdivision ? `, Subdivision=${subdivision}` : ''}${propertyType ? `, Type=${propertyType}` : ''}`);

    // **FAST-FAIL: Check if LLM extraction found ZERO critical data**
    // If all critical fields are missing, the address is likely invalid - fail immediately
    const allCriticalFieldsMissing = !sqft && !beds && !baths && !yearBuilt;

    if (allCriticalFieldsMissing) {
      console.error(`   ❌ FAST-FAIL: Initial LLM extraction found ZERO critical property data`);
      console.error(`      sqft=${sqft}, beds=${beds}, baths=${baths}, yearBuilt=${yearBuilt}`);
      console.error(`      This indicates an invalid or incomplete address - failing immediately without fallback strategies`);
      throw new Error(`Invalid address - no property data found. Please verify the address is complete and correct.`);
    }

    // STEP 3: Enrich validation data with original extraction for missing fields only
    jobLog(`   🔄 Step 3: Enriching validation data with original extraction...`);

    const finalData = { ...validationData };

    // Only use original data to fill missing fields from validation
    if (!finalData.sqft && sqft) {
      finalData.sqft = sqft;
      jobLog(`   ✅ ENRICHED: Added sqft from original extraction: ${sqft}`);
    }
    if (!finalData.beds && beds) {
      finalData.beds = beds;
      jobLog(`   ✅ ENRICHED: Added beds from original extraction: ${beds}`);
    }
    if (!finalData.baths && baths) {
      finalData.baths = baths;
      jobLog(`   ✅ ENRICHED: Added baths from original extraction: ${baths}`);
    }
    if (!finalData.yearBuilt && yearBuilt) {
      finalData.yearBuilt = yearBuilt;
      jobLog(`   ✅ ENRICHED: Added yearBuilt from original extraction: ${yearBuilt}`);
    }
    if (!finalData.subdivision && subdivision) {
      finalData.subdivision = subdivision;
      jobLog(`   ✅ ENRICHED: Added subdivision from original extraction: ${subdivision}`);
    }
    if (!finalData.propertyType && propertyType) {
      finalData.propertyType = propertyType;
      jobLog(`   ✅ ENRICHED: Added propertyType from original extraction: ${propertyType}`);
    }

    finalData.lotSize = null; // Always null for now

    // Check if we have critical missing fields after both extractions
    const missingCriticalFields = [];
    if (!finalData.sqft || finalData.sqft <= 0) missingCriticalFields.push('sqft');
    if (!finalData.beds || finalData.beds <= 0) missingCriticalFields.push('beds');
    if (!finalData.baths || finalData.baths <= 0) missingCriticalFields.push('baths');
    if (!finalData.yearBuilt) missingCriticalFields.push('yearBuilt');

    if (missingCriticalFields.length > 0) {
      jobLog(`   ⚠️  Still missing critical fields after validation+original: ${missingCriticalFields.join(', ')}`);
      jobLog(`   🔄 Step 4: Enhanced fallback detection for missing fields...`);

      // Try the existing fallback detection for ALL fields to get complete data
      jobLog(`   🔍 Requesting complete fallback data for all fields to ensure accuracy...`);
      const fallbackData = address ? await fallbackPropertyDetection(address, sa, projectId, location, model, ['sqft', 'beds', 'baths', 'yearBuilt', 'propertyType']) : {};

      // Fill in any missing critical fields from fallback
      missingCriticalFields.forEach(field => {
        if (field === 'sqft' && fallbackData.sqft && (!finalData.sqft || finalData.sqft <= 0)) {
          finalData.sqft = fallbackData.sqft;
          jobLog(`   ✅ Enhanced fallback: Found sqft = ${fallbackData.sqft}`);
        }
        if (field === 'beds' && fallbackData.beds && (!finalData.beds || finalData.beds <= 0)) {
          finalData.beds = fallbackData.beds;
          jobLog(`   ✅ Enhanced fallback: Found beds = ${fallbackData.beds}`);
        }
        if (field === 'baths' && fallbackData.baths && (!finalData.baths || finalData.baths <= 0)) {
          finalData.baths = fallbackData.baths;
          jobLog(`   ✅ Enhanced fallback: Found baths = ${fallbackData.baths}`);
        }
        if (field === 'yearBuilt' && fallbackData.yearBuilt && !finalData.yearBuilt) {
          finalData.yearBuilt = fallbackData.yearBuilt;
          jobLog(`   ✅ Enhanced fallback: Found yearBuilt = ${fallbackData.yearBuilt}`);
        }
      });

      // VERIFICATION: If fallback found different values, do verification search to pick supported data
      if (fallbackData.yearBuilt && fallbackData.propertyType) {
        const hasConflicts =
          (finalData.yearBuilt && fallbackData.yearBuilt !== finalData.yearBuilt) ||
          (finalData.propertyType && fallbackData.propertyType !== finalData.propertyType);

        if (hasConflicts) {
          jobLog(`   🔍 CONFLICT DETECTED: Verification search needed`);
          jobLog(`   📊 Current: yearBuilt=${finalData.yearBuilt}, propertyType=${finalData.propertyType}`);
          jobLog(`   📊 Fallback: yearBuilt=${fallbackData.yearBuilt}, propertyType=${fallbackData.propertyType}`);

          try {
            const verificationPrompt = `Search multiple real estate sources to verify conflicting property data for: ${address}

CONFLICTING DATA TO VERIFY:
- Year built: ${finalData.yearBuilt} vs ${fallbackData.yearBuilt}
- Property type: ${finalData.propertyType} vs ${fallbackData.propertyType}

Search these sources for consensus:
- site:zillow.com "${address}" year built property type
- site:redfin.com "${address}" year built property type
- site:realtor.com "${address}" year built property type
- "${address}" county records year built property type
- "${address}" tax assessor year built property type

Find which values have the most supporting evidence across multiple sources.

Respond in this exact format:
YEAR_BUILT: [the year with most evidence]
PROPERTY_TYPE: [the type with most evidence: single-family detached, multi-family, duplex, etc.]
EVIDENCE: [brief summary of which sources support the chosen values]`;

            const verificationResult = await vertexGenerate({
              sa, projectId, location, model,
              prompt: verificationPrompt,
              grounded: true,
              json: false,
              timeoutMs: 30000
            });

            jobLog(`   🔍 Verification result: ${verificationResult}`);

            // Parse verification result
            const yearMatch = verificationResult.match(/YEAR_BUILT:\s*(\d{4})/i);
            const typeMatch = verificationResult.match(/PROPERTY_TYPE:\s*([^\n]+)/i);

            if (yearMatch) {
              const verifiedYear = parseInt(yearMatch[1]);
              finalData.yearBuilt = verifiedYear;
              jobLog(`   ✅ VERIFIED: Using year built = ${verifiedYear}`);
            }

            if (typeMatch) {
              const verifiedType = typeMatch[1].trim();
              finalData.propertyType = verifiedType;
              jobLog(`   ✅ VERIFIED: Using property type = ${verifiedType}`);
            }

          } catch (error) {
            jobLog(`   ⚠️  Verification search failed, using fallback data: ${error}`);
            if (fallbackData.yearBuilt) finalData.yearBuilt = fallbackData.yearBuilt;
            if (fallbackData.propertyType) finalData.propertyType = fallbackData.propertyType;
          }
        }
      }

      // Final check - if still missing critical fields, one more attempt
      const stillMissing = [];
      if (!finalData.sqft || finalData.sqft <= 0) stillMissing.push('sqft');
      if (!finalData.beds || finalData.beds <= 0) stillMissing.push('beds');
      if (!finalData.baths || finalData.baths <= 0) stillMissing.push('baths');
      if (!finalData.yearBuilt) stillMissing.push('yearBuilt');

      if (stillMissing.length > 0) {
        jobLog(`   🆘 Step 5: Last resort - manual extraction for: ${stillMissing.join(', ')}`);
        jobLog(`   ❌ EXTRACTION FAILED: Could not find ${stillMissing.join(', ')} after all attempts`);
      } else {
        jobLog(`   🎉 Enhanced fallback SUCCESS: All critical fields now found!`);
      }
    }

    // CONFLICT RESOLUTION: Use existing fallback data to resolve conflicts with validation data
    jobLog(`   🔍 Conflict resolution: Using Step 2 fallback to validate Step 1 data...`);

    // We already have fallbackData from the enhanced fallback detection above
    // Let's also get the original validation conflicts we saw earlier
    const hasConflictingData = originalData.yearBuilt !== validationData.yearBuilt ||
                               originalData.propertyType !== validationData.propertyType;

    if (hasConflictingData) {
      jobLog(`   🔍 CONFLICT DETECTED between validation and original extraction:`);
      jobLog(`   📊 Validation: yearBuilt=${validationData.yearBuilt}, propertyType=${validationData.propertyType}`);
      jobLog(`   📊 Original: yearBuilt=${originalData.yearBuilt}, propertyType=${originalData.propertyType}`);

      // Use the more complete dataset - prefer original extraction data when it has both fields
      if (originalData.yearBuilt && originalData.propertyType) {
        jobLog(`   ✅ CONFLICT RESOLVED: Using original extraction data (more complete)`);
        finalData.yearBuilt = originalData.yearBuilt;
        finalData.propertyType = originalData.propertyType;
        jobLog(`   ✅ RESOLVED: yearBuilt=${originalData.yearBuilt}, propertyType=${originalData.propertyType}`);
      } else if (validationData.yearBuilt && validationData.propertyType) {
        jobLog(`   ✅ CONFLICT RESOLVED: Using validation data (more complete)`);
        finalData.yearBuilt = validationData.yearBuilt;
        finalData.propertyType = validationData.propertyType;
      }
    } else {
      jobLog(`   ✅ No conflicts detected between validation and original data`);
    }

    jobLog(`   📊 Final combined result: SQFT=${finalData.sqft}, Beds=${finalData.beds}, Baths=${finalData.baths}, Built=${finalData.yearBuilt}${finalData.subdivision ? `, Subdivision=${finalData.subdivision}` : ''}${finalData.propertyType ? `, Type=${finalData.propertyType}` : ''}`);

    return finalData;

  } catch (error) {
    // Re-throw fast-fail errors immediately - don't fallback to regex
    if (error instanceof Error && error.message.includes('Invalid address - no property data found')) {
      throw error;
    }

    jobLog(`   ❌ LLM parsing completely failed, falling back to regex: ${error}`);
    jobLog(`   📄 Text that caused LLM parsing failure: ${text.substring(0, 300)}...`);
    return parseFreeformRegex(text);
  }
}

// Keep original regex as fallback
function parseFreeformRegex(text: string): Partial<BasicDetails> {
  const clean = (s: string) => s.replace(/[,\s]/g, '').trim();

  // Simplified square footage parsing (keeping the problematic logic for fallback only)
  const sqftMatch = text.match(/([0-9,]+)\s*(?:sq\s*ft|square\s*feet)/i);
  let sqft = null;
  if (sqftMatch) {
    const val = Number(clean(sqftMatch[1]));
    if (val >= 500 && val <= 10000) {
      sqft = val;
    }
  }

  // Simplified bedroom parsing for fallback
  const bedsMatch = text.match(/([0-9]{1,2})\s*(?:bedroom|bed|BR)/i);
  const beds = bedsMatch ? Number(bedsMatch[1]) : null;

  // Simplified bathroom parsing for fallback
  const bathsMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:bathroom|bath|BA)/i);
  const baths = bathsMatch ? Number(bathsMatch[1]) : null;

  // Simplified year parsing for fallback
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const yearBuilt = yearMatch ? Number(yearMatch[0]) : null;

  return { sqft, beds, baths, yearBuilt, lotSize: null, subdivision: null, propertyType: null };
}
*/

// [DEPRECATED] Removed old sequential parsing helper functions (fallbackPropertyDetection, parsePropertyResponse,
// hasRequiredFields, normalizePropertyType) - replaced by parallel SPD with parseTextToJSON in optimized flow

const SUBJECT_DETAILS_TTL_MS = Math.max(0, Number(process.env.PV_SUBJECT_TTL_DAYS || 30)) * 24 * 60 * 60 * 1000;
const subjectDetailsKey = (address: string) => `subjectDetails:${normalizeAddress(address)}`;

async function readSubjectDetailsCache(address: string): Promise<BasicDetails | null> {
  try {
    const raw = await getRedisCache().get(subjectDetailsKey(address));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    const details = entry?.details as BasicDetails | undefined;
    if (!details?.sqft || !details?.beds) return null;
    if (SUBJECT_DETAILS_TTL_MS > 0 && Date.now() - Number(entry.storedAt) > SUBJECT_DETAILS_TTL_MS) return null;
    return details;
  } catch (error: any) {
    jobLog(`⚠️ [SUBJECT_DETAILS_CACHE] read failed: ${error?.message}`);
    return null;
  }
}

async function writeSubjectDetailsCache(address: string, details: BasicDetails | null): Promise<void> {
  // A failed or partial lookup must not get frozen in, or every later run inherits it.
  if (!details || !details.success || !details.sqft || !details.beds) return;
  try {
    await getRedisCache().set(
      subjectDetailsKey(address),
      JSON.stringify({ details, storedAt: Date.now() })
    );
    jobLog(`💾 [SUBJECT_DETAILS_CACHE_SET] sqft=${details.sqft} beds=${details.beds} baths=${details.baths} year=${details.yearBuilt} subdivision=${details.subdivision || 'n/a'} source=${details.source || 'n/a'}`);
  } catch (error: any) {
    jobLog(`⚠️ [SUBJECT_DETAILS_CACHE] write failed: ${error?.message}`);
  }
}

export async function fetchPropertyDetailsViaVertex(
  address: string,
  options?: { jobId?: string; timeoutMs?: number }
): Promise<BasicDetails | null> {
  const jobId = options?.jobId ?? address; // default for legacy callers
  const runLabel = process.env.RUN_LABEL || '';

  // Beds/baths/subdivision drive comp scoring and the pass filters, so letting the
  // LLM re-answer them per run moves the ARV by tens of thousands on the same house.
  const cached = await readSubjectDetailsCache(address);
  if (cached) {
    jobLog(`♻️ [SUBJECT_DETAILS_CACHE_HIT] Reusing reconciled subject record for ${address}`);
    return cached;
  }

  let details: BasicDetails | null;
  // S0 enforcement: wrap entire function with limiter for strict serialization
  if (runLabel.startsWith('S0')) {
    details = await withVertexLimiter('pv:details', jobId, () => rawFetchPropertyDetailsViaVertex(address, jobId));
  } else {
    details = await rawFetchPropertyDetailsViaVertex(address, jobId);
  }

  await writeSubjectDetailsCache(address, details);
  return details;
}

async function rawFetchPropertyDetailsViaVertex(address: string, jobId: string): Promise<BasicDetails | null> {
  const totalStartTime = Date.now();

  jobLog(`🔍 SPD ENTRY: fetchPropertyDetailsViaVertex called for ${address}`);
  const hasSA = hasServiceAccount();
  jobLog(`🔍 SPD SERVICE ACCOUNT CHECK: ${hasSA}`);

  if (!hasSA) {
    jobLog(`❌ SPD ABORTED: No service account found - returning null`);
    return null;
  }

  // Use ADC-first authentication (keyless on Cloud Run)
  const projectId = await resolveProjectId();
  const location = resolveLocation();
  const model = process.env.VERTEX_MODEL || 'gemini-2.5-pro';

  const tokenStart = Date.now();
  const token = await getAccessTokenViaAuth();
  const tokenDuration = Date.now() - tokenStart;
  jobLog(`🎫 DIAG_SPD_TOKEN: acquired in ${tokenDuration}ms for SPD calls`);

  const ctx = { token, projectId, location, model, jobId };

  jobLog(`\n🚀 OPTIMIZED SPD: Parallel Primary + County fetch for: ${address}`);

  // 🔍 DIAGNOSTIC: Log HTTPS agent state before parallel requests
  jobLog(`🔍 PARALLEL REQUEST DIAGNOSTIC:`);
  jobLog(`   About to launch 2 parallel Vertex API calls (Primary + County)`);
  jobLog(`   https.globalAgent.maxSockets = ${https.globalAgent.maxSockets}`);
  const vertexHostname = 'aiplatform.googleapis.com:443:';
  const activeSockets = https.globalAgent.sockets[vertexHostname] || [];
  const freeSockets = https.globalAgent.freeSockets[vertexHostname] || [];
  const queuedRequests = https.globalAgent.requests[vertexHostname] || [];
  jobLog(`   Active sockets to Vertex API: ${activeSockets.length}`);
  jobLog(`   Free sockets to Vertex API: ${freeSockets.length}`);
  jobLog(`   Queued requests to Vertex API: ${queuedRequests.length}`);

  // ===== STEP 1: Parallel Grounded Fetch (Primary + County) =====
  const primaryPrompt = `Use Google Search grounding with authoritative real estate sources (Zillow, Redfin, Realtor.com, county records) to find COMPLETE property details for: ${address}

CRITICAL REQUIRED DATA (must find all):
- Exact square footage (living area only, not lot size)
- Number of bedrooms (exact count)
- Number of bathrooms (including half baths as 0.5)
- Year built (exact year)
- Property type (single-family detached, townhome, condo, duplex)

ADDITIONAL HELPFUL DATA:
- Subdivision/neighborhood name
- Lot size in square feet or acres

Search specific sites:
- site:zillow.com "${address}"
- site:redfin.com "${address}"
- site:realtor.com "${address}"
- "${address}" county records property details

Provide specific facts with numbers and source URLs.`;

  const countyPrompt = `Use Google Search grounding to find property data from county records and tax assessor for: ${address}

Search county assessor and tax records:
- "${address}" tax assessor records
- "${address}" property tax records
- "${address}" county property details
- "${address}" square feet bedrooms bathrooms year built

Focus on official county/tax data. Provide exact numbers and source URLs.`;

  const primaryStart = Date.now();
  const countyStart = Date.now();

  const primaryPromise = vertexGenerate({ caller: 'subject_property_primary', ...ctx, prompt: primaryPrompt, grounded: true, json: false, timeoutMs: SPD_PRIMARY_TIMEOUT_MS })
    .then(text => {
      const duration = Date.now() - primaryStart;
      jobLog(`   ✅ Primary grounded search completed in ${duration}ms`);
      jobLog(`   📄 PRIMARY GROUNDED RESPONSE (${text.length} chars): ${text}`);
      return { text, source: 'primary' as const, duration, error: null };
    })
    .catch(err => {
      const duration = Date.now() - primaryStart;
      jobLog(`   ❌ Primary grounded search failed after ${duration}ms: ${err.message || err}`);
      return { text: null, source: 'primary' as const, duration, error: err };
    });

  const countyPromise = vertexGenerate({ caller: 'subject_property_county', ...ctx, prompt: countyPrompt, grounded: true, json: false, timeoutMs: SPD_COUNTY_TIMEOUT_MS })
    .then(text => {
      const duration = Date.now() - countyStart;
      jobLog(`   ✅ County grounded search completed in ${duration}ms`);
      jobLog(`   📄 COUNTY GROUNDED RESPONSE (${text.length} chars): ${text}`);
      return { text, source: 'county' as const, duration, error: null };
    })
    .catch(err => {
      const duration = Date.now() - countyStart;
      jobLog(`   ❌ County grounded search failed after ${duration}ms: ${err.message || err}`);
      return { text: null, source: 'county' as const, duration, error: err };
    });

  // Race to get the first winner
  const winnerResult = await Promise.race([primaryPromise, countyPromise]);
  jobLog(`   🏆 Winner: ${winnerResult.source} (${winnerResult.duration}ms)`);

  if (!winnerResult.text) {
    jobLog(`   ❌ Winner ${winnerResult.source} failed after ${winnerResult.duration}ms: ${winnerResult.error?.message || winnerResult.error}`);
    // Wait for the other one
    jobLog(`   🔄 Waiting for ${winnerResult.source === 'primary' ? 'county' : 'primary'} to complete...`);
    const [p, c] = await Promise.all([primaryPromise, countyPromise]);

    // 🔍 DIAGNOSTIC: Log parallel request results
    jobLog(`🔍 PARALLEL REQUEST COMPLETE:`);
    jobLog(`   Primary: ${p.text ? 'SUCCESS' : 'FAILED'} (${p.duration}ms)${p.error ? ', error: ' + p.error.message : ''}`);
    jobLog(`   County: ${c.text ? 'SUCCESS' : 'FAILED'} (${c.duration}ms)${c.error ? ', error: ' + c.error.message : ''}`);

    const loserResult = winnerResult.source === 'primary' ? c : p;

    if (!loserResult.text) {
      jobLog(`   ❌ Loser ${loserResult.source} also failed after ${loserResult.duration}ms: ${loserResult.error?.message || loserResult.error}`);
      jobLog(`   🛑 FATAL: Both primary and county searches failed - cannot retrieve SPD`);
      return null;
    }

    jobLog(`   🔄 Using fallback: ${loserResult.source} (${loserResult.duration}ms)`);
    // Parse the loser
    try {
      const parseStart = Date.now();
      const parsed = await parseTextToJSON(loserResult.text, ctx);
      const parseDuration = Date.now() - parseStart;
      jobLog(`   ✅ Fallback parse completed in ${parseDuration}ms`);
      return normalize(address, { ...parsed, source: loserResult.source, lotSize: null, success: true });
    } catch (err) {
      console.error(`   ❌ Fallback parse failed:`, err);
      return null;
    }
  }

  // ===== STEP 2: Parse Winner Immediately =====
  jobLog(`   🔍 Parsing winner (${winnerResult.source})...`);
  let parsedWinner: Partial<BasicDetails>;
  try {
    const parseStart = Date.now();
    parsedWinner = await parseTextToJSON(winnerResult.text, ctx);
    const parseDuration = Date.now() - parseStart;
    jobLog(`   ✅ Winner parsed in ${parseDuration}ms: sqft=${parsedWinner.sqft}, beds=${parsedWinner.beds}, baths=${parsedWinner.baths}, yearBuilt=${parsedWinner.yearBuilt}`);
  } catch (err) {
    console.error(`   ❌ Winner parse failed:`, err);
    jobLog(`   🔄 Waiting for loser to complete...`);
    // Try the loser
    const loserPromise = winnerResult.source === 'primary' ? countyPromise : primaryPromise;
    const loserResult = await loserPromise;
    if (!loserResult.text) {
      console.error(`   ❌ Loser also failed - cannot retrieve SPD`);
      return null;
    }
    try {
      const parseStart = Date.now();
      parsedWinner = await parseTextToJSON(loserResult.text, ctx);
      const parseDuration = Date.now() - parseStart;
      jobLog(`   ✅ Loser parsed in ${parseDuration}ms (used as fallback)`);
      return normalize(address, { ...parsedWinner, source: loserResult.source, lotSize: null, success: true });
    } catch (err2) {
      console.error(`   ❌ Loser parse also failed:`, err2);
      return null;
    }
  }

  // ===== STEP 3: Grace Window for Loser (for reconciliation) =====
  jobLog(`   ⏱️  Waiting ${SPD_GRACE_WINDOW_MS}ms for ${winnerResult.source === 'primary' ? 'county' : 'primary'} (grace window)...`);
  let parsedLoser: Partial<BasicDetails> | null = null;
  try {
    const loserPromise = winnerResult.source === 'primary' ? countyPromise : primaryPromise;
    const loserResult = await Promise.race([
      loserPromise,
      sleep(SPD_GRACE_WINDOW_MS)
    ]);

    if (loserResult && loserResult.text) {
      jobLog(`   ✅ Loser arrived in grace window: ${loserResult.source} (${loserResult.duration}ms)`);
      try {
        const parseStart = Date.now();
        parsedLoser = await parseTextToJSON(loserResult.text, ctx);
        const parseDuration = Date.now() - parseStart;
        jobLog(`   ✅ Loser parsed in ${parseDuration}ms: sqft=${parsedLoser.sqft}, beds=${parsedLoser.beds}, baths=${parsedLoser.baths}, yearBuilt=${parsedLoser.yearBuilt}`);
      } catch (err) {
        console.error(`   ❌ Loser parse failed:`, err);
        parsedLoser = null;
      }
    } else if (loserResult && !loserResult.text) {
      console.error(`   ❌ Loser ${loserResult.source} failed in grace window after ${loserResult.duration}ms:`, loserResult.error?.message || loserResult.error);
    }
  } catch (err) {
    jobLog(`   ⏱️  Grace window expired (${SPD_GRACE_WINDOW_MS}ms) - using winner only`);
  }

  // ===== STEP 4: Reconcile if we have both =====
  let finalDetails: Partial<BasicDetails>;

  if (parsedLoser) {
    const primaryWon = winnerResult.source === 'primary';
    const primaryData = primaryWon ? parsedWinner : parsedLoser;
    const countyData = primaryWon ? parsedLoser : parsedWinner;

    jobLog(`   🔄 Reconciling: primary=${primaryWon ? 'winner' : 'loser'}, county=${primaryWon ? 'loser' : 'winner'}`);
    finalDetails = reconcileResults(primaryData, countyData, primaryWon);
  } else {
    jobLog(`   📋 Using winner only (no reconciliation): ${winnerResult.source}`);
    finalDetails = { ...parsedWinner, source: winnerResult.source };
  }

  // ===== STEP 5: Final Validation =====
  jobLog(`   🔍 Validating final details...`);
  const hasCriticalData = finalDetails.sqft && finalDetails.beds && finalDetails.baths && finalDetails.yearBuilt;

  if (!hasCriticalData) {
    const missing = [];
    if (!finalDetails.sqft) missing.push('sqft');
    if (!finalDetails.beds) missing.push('beds');
    if (!finalDetails.baths) missing.push('baths');
    if (!finalDetails.yearBuilt) missing.push('yearBuilt');

    console.error(`   ❌ Validation failed - Missing critical fields: ${missing.join(', ')}`);
    console.error(`   📊 Partial data: sqft=${finalDetails.sqft}, beds=${finalDetails.beds}, baths=${finalDetails.baths}, yearBuilt=${finalDetails.yearBuilt}`);
    console.error(`   🛑 FATAL: Cannot proceed - insufficient data for SPD`);
    return null;
  }

  const totalDuration = Date.now() - totalStartTime;
  jobLog(`   ✅ Validation passed - All critical fields present`);
  jobLog(`   ✅ SPD Complete in ${totalDuration}ms (${(totalDuration/1000).toFixed(1)}s)`);
  jobLog(`   📊 Final: sqft=${finalDetails.sqft}, beds=${finalDetails.beds}, baths=${finalDetails.baths}, yearBuilt=${finalDetails.yearBuilt}, type=${finalDetails.propertyType}, source=${finalDetails.source}`);

  return normalize(address, { ...finalDetails, lotSize: null, success: true });
}

function normalize(address: string, obj: any): BasicDetails {
  return {
    address,
    sqft: obj?.sqft != null && Number.isFinite(Number(obj.sqft)) ? Number(obj.sqft) : null,
    beds: obj?.beds != null && Number.isFinite(Number(obj.beds)) ? Number(obj.beds) : null,
    baths: obj?.baths != null ? Number(obj.baths) : null,
    yearBuilt: obj?.yearBuilt != null && Number.isFinite(Number(obj.yearBuilt)) ? Number(obj.yearBuilt) : null,
    lotSize: obj?.lotSize != null && Number.isFinite(Number(obj.lotSize)) ? Number(obj.lotSize) : null,
    subdivision: typeof obj?.subdivision === 'string' && obj.subdivision.trim().length > 0 ? obj.subdivision.trim() : null,
    propertyType: typeof obj?.propertyType === 'string' && obj.propertyType.trim().length > 0 ? obj.propertyType.trim() : null,
    success: true,
  };
}

