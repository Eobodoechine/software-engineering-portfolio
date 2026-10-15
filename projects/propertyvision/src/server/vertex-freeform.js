import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import { GoogleAuth } from 'google-auth-library';
import { jobLog } from './utils/jobLogger';
import { getLocalDemoToken, localDemoEnabled } from './utils/localDemo.js';
import { postJsonWithBackoff } from './utils/vertex-http.js';

const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// 🔧 CONCURRENCY FIX v1.0: Custom HTTP agent with connection limits
// Prevents TLS socket listener accumulation under concurrent load
// Research: https://github.com/nodejs/node/issues/16716 (socket reuse memory leak)
// Research: https://github.com/nodejs/node/issues/55330 (ECONNRESET with keepAlive)

jobLog('🔧 [AGENT_INIT_START] Creating custom Vertex HTTP agent...');

let vertexHttpAgent;
try {
    vertexHttpAgent = new https.Agent({
        keepAlive: true,           // Enable connection reuse for performance
        keepAliveMsecs: 30000,     // Keep sockets alive for 30s
        maxSockets: 10,            // CRITICAL: Limit concurrent sockets per host (prevents listener leak)
        maxFreeSockets: 5,         // Limit idle socket pool size
        timeout: 60000,            // Socket timeout (60s)
        freeSocketTimeout: 4000,   // Close idle sockets after 4s (before server timeout)
    });

    jobLog('✅ [AGENT_INIT_SUCCESS] Vertex HTTP agent created');
    jobLog(`🔧 [AGENT_CONFIG] maxSockets=${vertexHttpAgent.maxSockets}, maxFreeSockets=${vertexHttpAgent.maxFreeSockets}, keepAlive=${vertexHttpAgent.keepAlive}`);

    // Graceful shutdown: destroy agent on process exit
    process.on('beforeExit', () => {
        jobLog('🔧 [AGENT_CLEANUP] Destroying Vertex HTTP agent on process exit...');
        vertexHttpAgent.destroy();
        jobLog('✅ [AGENT_CLEANUP_DONE] Agent destroyed');
    });

} catch (error) {
    console.error('❌ [AGENT_INIT_FAILED] Failed to create Vertex HTTP agent:', error);
    console.error('   Error type:', error.constructor.name);
    console.error('   Error message:', error.message);
    console.error('   Error stack:', error.stack);
    throw new Error(`[AGENT_INIT_FAILED] Cannot initialize custom HTTP agent: ${error.message}`);
}

// 🔍 DIAGNOSTIC: Track concurrent API calls and socket usage
let activeVertexCalls = 0;
let peakConcurrency = 0;

// 📊 STATISTICS: Track retry success across all Vertex calls in this worker instance
let vertexStats = {
    totalCalls: 0,
    successFirstAttempt: 0,
    successAfterRetry: 0,
    totalFailures: 0,
    socketReusedCount: 0,
    socketNewCount: 0,
    errorCodes: {},
    retriesByAttempt: { 1: 0, 2: 0, 3: 0 }  // Track how many retries were needed
};

// Retry configuration based on Node.js issue #55330 workarounds
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;  // Exponential backoff: 1s, 2s, 4s

// 🔧 DIAGNOSTIC: Track auth client instances and token caching
let authClientInstanceCount = 0;
const tokenCache = { token: null, fetchedAt: null };

// 🔬 DIAGNOSTIC v2: Parse real 429 signals from Google (no hardcoded mechanisms)
/**
 * Parse 429 error signals from Google's error response
 * Extracts RetryInfo and QuotaFailure from error.details[] WITHOUT hardcoding mechanism names
 */
function classifyQuota(res, body) {
    const ct = (res.headers['content-type'] || '').toLowerCase();
    let parsed;
    if (ct.includes('application/json')) {
        try { parsed = JSON.parse(body); } catch {}
    }

    const msg = parsed?.error?.message || '';
    const details = parsed?.error?.details || [];

    // Parse RetryInfo from error.details (contains retry delay recommendation)
    const retryInfo = details.find(d => d['@type']?.includes('RetryInfo'));
    let retryDelayMs = null;
    if (retryInfo && retryInfo.retryDelay) {
        const seconds = retryInfo.retryDelay.seconds || 0;
        const nanos = retryInfo.retryDelay.nanos || 0;
        retryDelayMs = (seconds * 1000) + Math.floor(nanos / 1000000);
    }

    // Parse QuotaFailure from error.details (contains quota ID and subject)
    const quotaFailure = details.find(d => d['@type']?.includes('QuotaFailure'));
    let quotaId = null;
    let quotaSubject = null;
    if (quotaFailure && quotaFailure.violations && quotaFailure.violations.length > 0) {
        const violation = quotaFailure.violations[0];
        quotaSubject = violation.subject || null;
        // Quota ID can be in description or subject field
        quotaId = violation.description || violation.subject || null;
    }

    // Determine mechanism_reported based on what Google actually tells us
    // DO NOT hardcode mechanism names - report exactly what Google provides
    let mechanismReported = null;
    if (retryInfo) {
        mechanismReported = `RetryInfo(delay=${retryDelayMs}ms)`;
    } else if (quotaFailure) {
        mechanismReported = `QuotaFailure(quota=${quotaId || 'unknown'})`;
    }
    // If neither RetryInfo nor QuotaFailure, mechanism_reported stays null (not "UNKNOWN")

    return {
        mechanism_reported: mechanismReported,
        msg,
        retry_delay_ms: retryDelayMs,
        quota_id: quotaId,
        quota_subject: quotaSubject,
        has_retry_info: !!retryInfo,
        has_quota_failure: !!quotaFailure
    };
}

/**
 * Parse Retry-After header (supports both seconds and HTTP-date format)
 */
function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const n = Number(headerValue);
    if (!Number.isNaN(n)) return n * 1000; // seconds → ms
    const ts = Date.parse(headerValue);
    return Number.isNaN(ts) ? null : Math.max(0, ts - Date.now());
}

// 🔬 DIAGNOSTIC v2: Precise in-flight tracking
/**
 * Record attempt start and capture in-flight count
 */
function startAttempt() {
    activeVertexCalls++;
    peakConcurrency = Math.max(peakConcurrency, activeVertexCalls);
    return {
        start: Date.now(),
        inflightAtStart: activeVertexCalls
    };
}

/**
 * Record attempt end and capture final in-flight count
 */
function endAttempt(meta) {
    activeVertexCalls = Math.max(0, activeVertexCalls - 1);
    return {
        ...meta,
        inflightAtEnd: activeVertexCalls,
        latencyMs: Date.now() - meta.start
    };
}

/**
 * Log comprehensive statistics about Vertex API calls
 */
function logVertexStats() {
    const totalAttempts = vertexStats.totalCalls;
    if (totalAttempts === 0) return;

    const successRate = ((vertexStats.successFirstAttempt + vertexStats.successAfterRetry) / totalAttempts * 100).toFixed(1);
    const retryRate = (vertexStats.successAfterRetry / totalAttempts * 100).toFixed(1);
    const failureRate = (vertexStats.totalFailures / totalAttempts * 100).toFixed(1);
    const totalSockets = vertexStats.socketReusedCount + vertexStats.socketNewCount;
    const reuseRate = totalSockets > 0 ? (vertexStats.socketReusedCount / totalSockets * 100).toFixed(1) : 0;

    jobLog(`📈 VERTEX_API_STATS (this worker session):`);
    jobLog(`   Total calls: ${totalAttempts}`);
    jobLog(`   Success on first attempt: ${vertexStats.successFirstAttempt} (${((vertexStats.successFirstAttempt / totalAttempts * 100).toFixed(1))}%)`);
    jobLog(`   Success after retry: ${vertexStats.successAfterRetry} (${retryRate}%)`);
    jobLog(`   Failed after all retries: ${vertexStats.totalFailures} (${failureRate}%)`);
    jobLog(`   Overall success rate: ${successRate}%`);
    jobLog(`   Socket reuse rate: ${vertexStats.socketReusedCount}/${totalSockets} (${reuseRate}%)`);
    jobLog(`   Retries by attempt: 1st=${vertexStats.retriesByAttempt[1]}, 2nd=${vertexStats.retriesByAttempt[2]}, 3rd=${vertexStats.retriesByAttempt[3]}`);
    jobLog(`   Error breakdown: ${JSON.stringify(vertexStats.errorCodes)}`);
    jobLog(`   Peak concurrency: ${peakConcurrency}`);
}

/**
 * Retry wrapper with exponential backoff and comprehensive logging
 * Implements workarounds from Node.js issue #55330
 */
async function httpsPostJsonWithRetry(url, payload, headers, timeoutMs = 60000, callType = 'VERTEX') {
    // Delegate to postJsonWithBackoff which has built-in rate limiting, retries, and probe instrumentation
    jobLog(`🔄 VERTEX_CALL: ${callType} via postJsonWithBackoff`);
    try {
        const result = await postJsonWithBackoff(url, {
            headers,
            bodyJson: payload,
            jobLog
        });
        jobLog(`✅ VERTEX_CALL_SUCCESS: ${callType}`);
        return result;
    } catch (error) {
        jobLog(`❌ VERTEX_CALL_FAILED: ${callType}, error=${error.message}`);
        throw error;
    }
}

async function httpsPostJson(url, payload, headers, timeoutMs = 60000) {
    // 🔬 DIAGNOSTIC v2: Start attempt tracking with precise in-flight
    const attemptMeta = startAttempt();

    return await new Promise((resolve, reject) => {
        const u = new URL(url);
        const body = JSON.stringify(payload);

        // 🔍 DIAGNOSTIC: Check HTTP agent state BEFORE making request
        const globalAgent = https.globalAgent;
        const hostname = u.hostname;
        const socketKey = `${hostname}:443:`;

        const activeSockets = globalAgent.sockets[socketKey] || [];
        const freeSockets = globalAgent.freeSockets[socketKey] || [];
        const queuedRequests = globalAgent.requests[socketKey] || [];

        // Track socket ages and reuse count
        const socketAges = freeSockets.map(s => Date.now() - (s._socketStart || Date.now()));
        const avgSocketAge = socketAges.length > 0 ? socketAges.reduce((a,b) => a+b, 0) / socketAges.length : 0;
        const oldestSocket = socketAges.length > 0 ? Math.max(...socketAges) : 0;

        jobLog(`🔍 SOCKET DIAG [call ${activeVertexCalls}/${peakConcurrency} peak]:`);
        jobLog(`   maxSockets: ${globalAgent.maxSockets}`);
        jobLog(`   active sockets: ${activeSockets.length}`);
        jobLog(`   free sockets: ${freeSockets.length}`);
        jobLog(`   queued requests: ${queuedRequests.length}`);
        jobLog(`   hostname: ${hostname}`);
        jobLog(`🔧 DIAG_SOCKET_AGES: avg=${Math.round(avgSocketAge)}ms, oldest=${Math.round(oldestSocket)}ms, free_sockets_detail=${freeSockets.length}`);
        jobLog(`🔧 DIAG_CONCURRENCY_SNAPSHOT: current=${activeVertexCalls}, peak=${peakConcurrency}, utilization=${((activeVertexCalls/Math.max(peakConcurrency,1))*100).toFixed(1)}%`);

        // 🔧 [AGENT_USE_MAIN] Using custom agent for Vertex API request
        jobLog(`🔧 [AGENT_USE_MAIN] Hostname: ${u.hostname}, using agent: ${!!vertexHttpAgent}`);

        if (!vertexHttpAgent) {
            const error = new Error('[AGENT_USE_MAIN_FAILED] vertexHttpAgent is not initialized');
            jobLog('❌ [AGENT_USE_MAIN_FAILED] Custom agent not available, cannot proceed');
            throw error;
        }

        const requestStartTime = Date.now();
        const req = https.request({
            method: 'POST',
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body).toString(),
                ...headers
            },
            agent: vertexHttpAgent  // ✅ Use custom agent instead of globalAgent
        }, (res) => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => {
                // 🔬 DIAGNOSTIC v2: End attempt tracking
                const done = endAttempt(attemptMeta);
                const requestDuration = Date.now() - requestStartTime;

                // 🔬 DIAGNOSTIC v2: Log all attempts with in-flight metrics
                jobLog(JSON.stringify({
                    t: Date.now(),
                    kind: 'ATTEMPT_END',
                    status: res.statusCode,
                    inflightAtStart: done.inflightAtStart,
                    inflightAtEnd: done.inflightAtEnd,
                    latencyMs: done.latencyMs
                }));

                // 🔬 DIAGNOSTIC v2: 429 Classification and detailed logging
                if (res.statusCode === 429) {
                    const classification = classifyQuota(res, data);
                    const retryAfterMs = parseRetryAfter(res.headers['retry-after']);

                    jobLog(JSON.stringify({
                        t: Date.now(),
                        kind: '429_DIAG',
                        endpoint: `${u.hostname}${u.pathname}`,
                        model: 'gemini-2.5-pro',
                        region: 'us-central1',
                        status: res.statusCode,
                        headers: res.headers,
                        retryAfterMs,
                        xGoogRequestId: res.headers['x-goog-request-id'] || null,
                        classification,
                        bodyPreview: data.slice(0, 500),
                        inflightAtStart: done.inflightAtStart,
                        inflightAtEnd: done.inflightAtEnd,
                        durationMs: requestDuration
                    }));
                }

                // Log successful completion with socket state
                const socketReused = req.socket?._reusedSocket || false;
                const socketAge = req.socket?._socketStart ? Date.now() - req.socket._socketStart : 'unknown';

                jobLog(`🔍 SOCKET FREED: active calls now ${done.inflightAtEnd}`);
                jobLog(`✅ DIAG_REQUEST_SUCCESS: duration=${requestDuration}ms, socket_reused=${socketReused}, socket_age=${socketAge}ms, response_bytes=${data.length}`);

                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    resolve({ raw: data });
                }
            });
        });

        // 🔍 DIAGNOSTIC: Track socket lifecycle events
        req.on('socket', (socket) => {
            const isReused = socket._reusedSocket || false;
            const socketId = socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort}` : 'not-connected-yet';

            // Track socket start time for age calculation
            if (!socket._socketStart) {
                socket._socketStart = Date.now();
            }
            const socketAge = Date.now() - (socket._socketStart || Date.now());

            jobLog(`🔌 SOCKET_ASSIGNED: id=${socketId}`);
            jobLog(`   Reused: ${isReused ? '✅ YES (from pool)' : '❌ NO (new connection)'}`);
            jobLog(`   Destroyed: ${socket.destroyed}`);
            jobLog(`   Writable: ${socket.writable}`);
            jobLog(`   Readable: ${socket.readable}`);
            jobLog(`🔧 DIAG_SOCKET_ASSIGNED: socket_id=${socketId}, reused=${isReused}, age_ms=${socketAge}, destroyed=${socket.destroyed}, writable=${socket.writable}`);

            // Track socket reuse statistics
            if (isReused) {
                vertexStats.socketReusedCount++;
            } else {
                vertexStats.socketNewCount++;
            }

            socket.on('connect', () => {
                const connectedId = `${socket.remoteAddress}:${socket.remotePort}`;
                jobLog(`🔌 SOCKET_CONNECTED: id=${connectedId}`);
            });

            socket.on('close', (hadError) => {
                const ageAtClose = socket._socketStart ? Date.now() - socket._socketStart : 'unknown';
                jobLog(`🔌 SOCKET_CLOSED: id=${socketId}, hadError=${hadError}`);
                jobLog(`🔧 DIAG_SOCKET_CLOSED: socket_id=${socketId}, had_error=${hadError}, age_at_close=${ageAtClose}ms`);
            });

            socket.on('error', (err) => {
                const socketAgeAtError = socket._socketStart ? Date.now() - socket._socketStart : 'unknown';
                jobLog(`🔌 SOCKET_ERROR: id=${socketId}, error=${err.code || err.message}`);
                jobLog(`🔧 DIAG_SOCKET_ERROR: socket_id=${socketId}, error_code=${err.code}, error_msg=${err.message}, socket_age=${socketAgeAtError}ms, reused=${isReused}`);
            });
        });

        // Implement timeout to prevent indefinite hangs
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            const done = endAttempt(attemptMeta);
            const error = new Error(`Request timeout after ${timeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            jobLog(JSON.stringify({
                t: Date.now(),
                kind: 'ATTEMPT_END',
                status: 'TIMEOUT',
                inflightAtStart: done.inflightAtStart,
                inflightAtEnd: done.inflightAtEnd,
                latencyMs: done.latencyMs
            }));
            reject(error);
        });

        req.on('error', (err) => {
            // 🔬 DIAGNOSTIC v2: End attempt tracking on error
            const done = endAttempt(attemptMeta);

            jobLog(JSON.stringify({
                t: Date.now(),
                kind: 'ATTEMPT_END',
                status: 'ERROR',
                errorCode: err.code,
                inflightAtStart: done.inflightAtStart,
                inflightAtEnd: done.inflightAtEnd,
                latencyMs: done.latencyMs
            }));

            // 🔍 DIAGNOSTIC: Enhanced error logging with socket state
            const socketReused = req.socket?._reusedSocket || false;
            const socketDestroyed = req.socket?.destroyed || false;
            const socketAge = req.socket?._socketStart ? Date.now() - req.socket._socketStart : 'unknown';

            // Capture full socket pool state at error time
            const errorSocketState = {
                active: (globalAgent.sockets[socketKey] || []).length,
                free: (globalAgent.freeSockets[socketKey] || []).length,
                queued: (globalAgent.requests[socketKey] || []).length
            };

            jobLog(`🔍 REQUEST ERROR: ${err.message}`);
            jobLog(`   error code: ${err.code}`);
            jobLog(`   socket reused: ${socketReused}`);
            jobLog(`   socket destroyed: ${socketDestroyed}`);
            jobLog(`   active calls: ${activeVertexCalls}`);
            jobLog(`   peak concurrency: ${peakConcurrency}`);

            // Enhanced diagnostic logging
            jobLog(`❌ DIAG_ERROR_CONTEXT: error_code=${err.code}, error_msg=${err.message}`);
            jobLog(`🔧 DIAG_ERROR_SOCKET: socket_reused=${socketReused}, socket_age=${socketAge}ms, socket_destroyed=${socketDestroyed}`);
            jobLog(`🔧 DIAG_ERROR_POOL: active=${errorSocketState.active}, free=${errorSocketState.free}, queued=${errorSocketState.queued}`);
            jobLog(`🔧 DIAG_ERROR_CONCURRENCY: current_calls=${activeVertexCalls}, peak_calls=${peakConcurrency}, utilization=${((activeVertexCalls/Math.max(peakConcurrency,1))*100).toFixed(1)}%`);

            reject(err);
        });

        req.write(body);
        req.end();
    });
}
// REMOVED: groundedFreeform function - replaced with deterministic vertexGenerate
// Service account token generation
async function getServiceAccountToken(sa, scope) {
    jobLog('🔍 TOKEN DEBUG 1: getServiceAccountToken called');
    jobLog('🔍 TOKEN DEBUG 2: sa type:', typeof sa);
    jobLog('🔍 TOKEN DEBUG 3: sa is null/undefined:', sa === null || sa === undefined);
    jobLog('🔍 TOKEN DEBUG 4: sa keys:', sa ? Object.keys(sa) : 'NO SA OBJECT');
    jobLog('🔍 TOKEN DEBUG 5: sa.private_key exists:', !!sa?.private_key);
    jobLog('🔍 TOKEN DEBUG 6: sa.private_key type:', typeof sa?.private_key);
    jobLog('🔍 TOKEN DEBUG 7: sa.private_key length:', sa?.private_key?.length || 'NO LENGTH');
    jobLog('🔍 TOKEN DEBUG 8: sa.client_email:', sa?.client_email || 'NO CLIENT EMAIL');

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600;
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = { iss: sa.client_email, scope, aud: sa.token_uri, exp, iat };
    const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const unsigned = `${base64url(header)}.${base64url(claims)}`;
    // Import crypto synchronously for ES modules
    const { createSign } = await import('node:crypto');
    const sign = createSign('RSA-SHA256');
    sign.update(unsigned);
    jobLog('🔍 TOKEN DEBUG 9: About to call sign.sign(sa.private_key)');
    jobLog('🔍 TOKEN DEBUG 10: Final sa.private_key check:', !!sa.private_key);

    // Fix private key format - replace literal \n with actual newlines
    const formattedPrivateKey = sa.private_key.replace(/\\n/g, '\n');
    jobLog('🔍 TOKEN DEBUG 11: Private key formatted, checking format...');

    const signature = sign.sign(formattedPrivateKey).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const assertion = `${unsigned}.${signature}`;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const resp = await httpsPostForm(sa.token_uri, body.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' }, 60000);
    if (!resp?.access_token)
        throw new Error('sa-token-failed');
    return resp.access_token;
}
async function httpsPostForm(url, body, headers, timeoutMs) {
    return await new Promise((resolve, reject) => {
        const u = new URL(url);

        // 🔧 [AGENT_USE_OAUTH] Using custom agent for OAuth token request
        jobLog(`🔧 [AGENT_USE_OAUTH] Hostname: ${u.hostname}, using agent: ${!!vertexHttpAgent}`);

        if (!vertexHttpAgent) {
            const error = new Error('[AGENT_USE_OAUTH_FAILED] vertexHttpAgent is not initialized');
            jobLog('❌ [AGENT_USE_OAUTH_FAILED] Custom agent not available for OAuth');
            reject(error);
            return;
        }

        const req = https.request({
            method: 'POST',
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body).toString()
            },
            agent: vertexHttpAgent  // ✅ Use custom agent for OAuth too
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try {
                resolve(JSON.parse(data));
            }
            catch {
                resolve(null);
            } });
        });

        // Implement timeout to prevent indefinite hangs
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            const error = new Error(`Request timeout after ${timeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            reject(error);
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
// Direct vertex generate function for LLM parsing
export async function vertexGenerate(opts) {
    // S0-v2 Note: S0 validation is now handled by withVertexLimiter via ATTEMPT_START events
    // The limiter tracks pre/post inflight counts - violations are detected by summarize-429.js
    // We removed the blocking check here because ALL Vertex calls now go through wrappers

    const caller = opts.caller || 'unknown';
    const callId = `${caller}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    jobLog(`📞 VERTEX_CALL from ${caller}, call_id=${callId}`);
    jobLog(`🔧 DIAG_CALL_START: call_id=${callId}, caller=${caller}, grounded=${opts.grounded}, timeout=${opts.timeoutMs}ms`);
    jobLog(`🔍 VERTEX DEBUG 1: vertexGenerate called with opts keys:`, Object.keys(opts));
    jobLog(`🔍 VERTEX DEBUG 2: projectId="${opts.projectId}", location="${opts.location}", model="${opts.model}"`);
    jobLog(`🔍 VERTEX DEBUG 3: prompt length=${opts.prompt?.length}, grounded=${opts.grounded}, json=${opts.json}`);
    jobLog(`🔍 VERTEX DEBUG 4: timeoutMs=${opts.timeoutMs}`);

    jobLog(`🔍 VERTEX DEBUG 5: Getting service account token`);
    // Accept either opts.token (v13.3 style) or opts.sa (legacy style)
    const token = opts.token || await getServiceAccountToken(opts.sa, 'https://www.googleapis.com/auth/cloud-platform');
    jobLog(`🔍 VERTEX DEBUG 6: Token obtained, length=${token?.length}`);

    const endpoint = `https://aiplatform.googleapis.com/v1/projects/${opts.projectId}/locations/${opts.location}/publishers/google/models/${opts.model}:generateContent`;
    jobLog(`🔍 VERTEX DEBUG 7: Endpoint=${endpoint}`);

    const payload = {
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        generationConfig: {
            temperature: 0, // Maximum determinism
            seed: 12345, // Fixed seed for reproducibility
            maxOutputTokens: 8192, // Maximum tokens for Gemini 2.0 Flash on Vertex AI (reduced from 65535)
            ...(opts.json ? { responseMimeType: 'application/json' } : {})
        },
    };

    // Use legacy grounding tool name expected by this project
    if (opts.grounded)
        payload.tools = [{ google_search: {} }];
    if (opts.responseSchema)
        payload.generationConfig.responseSchema = opts.responseSchema;

    jobLog(`🔍 VERTEX DEBUG 8: Payload created, contents length=${payload.contents.length}`);
    jobLog(`🔍 VERTEX DEBUG 9: Payload generationConfig:`, JSON.stringify(payload.generationConfig));
    jobLog(`🔍 VERTEX DEBUG 10: About to call httpsPostJson`);

    // Enhanced logging for future analysis
    const callType = opts.grounded ? 'GROUNDED' : 'NON-GROUNDED';
    const startTime = Date.now();
    vertexStats.totalCalls++;

    jobLog(`📊 VERTEX_CALL_START: type=${callType}, grounded=${opts.grounded}, json=${opts.json}, timeout=${opts.timeoutMs}ms`);
    jobLog(`🔬 IMPLEMENTATION: Using retry logic v1.0 with exponential backoff`);
    jobLog(`🔬 AGENT_CONFIG: agent=CUSTOM keepAlive=${vertexHttpAgent.keepAlive} maxSockets=${vertexHttpAgent.maxSockets} maxFreeSockets=${vertexHttpAgent.maxFreeSockets} freeSocketTimeout=${vertexHttpAgent.freeSocketTimeout ?? vertexHttpAgent.options?.freeSocketTimeout ?? 'n/a'}`);

    let res;
    try {
        // Use retry wrapper instead of direct httpsPostJson call
        res = await httpsPostJsonWithRetry(
            endpoint,
            payload,
            { Authorization: `Bearer ${token}` },
            opts.timeoutMs,
            callType
        );
    } catch (error) {
        const duration = Date.now() - startTime;
        if (error.code === 'ETIMEDOUT') {
            jobLog(`❌ VERTEX_TIMEOUT_ERROR: type=${callType}, duration=${duration}ms, timeout=${opts.timeoutMs}ms`);
            jobLog(`❌ VERTEX_TIMEOUT_DETAILS: caller=${caller}, error=${error.message}`);
        } else {
            jobLog(`❌ VERTEX_HTTP_ERROR: type=${callType}, duration=${duration}ms, error=${error.code || 'unknown'}`);
            jobLog(`❌ VERTEX_HTTP_ERROR_DETAILS: caller=${caller}, message=${error.message}`);
        }
        jobLog(`📊 VERTEX_CALL_FAILED: type=${callType}, duration=${duration}ms, error=${error.code}`);

        // Log statistics for this failed call
        logVertexStats();

        return '';
    }

    const duration = Date.now() - startTime;
    jobLog(`📊 VERTEX_CALL_COMPLETE: type=${callType}, duration=${duration}ms, success=${!!res}`);
    jobLog(`🔍 VERTEX DEBUG 11: httpsPostJson returned, response type:`, typeof res);
    jobLog(`🔍 VERTEX DEBUG 12: Response keys:`, res ? Object.keys(res) : 'null');
    jobLog(`🔍 VERTEX DEBUG 13: Full response:`, JSON.stringify(res, null, 2));

    if (!res) {
        jobLog(`🔍 VERTEX DEBUG 14: NULL RESPONSE - returning empty string`);
        jobLog(`❌ VERTEX_EXIT_NULL_RESPONSE: caller=${caller}`);
        return '';
    }

    if (!res.candidates) {
        jobLog(`🔍 VERTEX DEBUG 15: NO CANDIDATES - response:`, res);
        if (res.error) {
            jobLog(`🔍 VERTEX DEBUG 15.1: ERROR DETAILS:`, JSON.stringify(res.error, null, 2));
            const errorCode = res.error.code || 'unknown';
            const errorStatus = res.error.status || 'unknown';
            jobLog(`❌ VERTEX_EXIT_NO_CANDIDATES: caller=${caller}, reason=${errorStatus}, httpCode=${errorCode}`);
        } else {
            jobLog(`❌ VERTEX_EXIT_NO_CANDIDATES: caller=${caller}, reason=NO_ERROR_OBJECT`);
        }
        return '';
    }

    jobLog(`🔍 VERTEX DEBUG 16: Candidates found, length=${res.candidates.length}`);

    if (!res.candidates[0]) {
        jobLog(`🔍 VERTEX DEBUG 17: NO FIRST CANDIDATE`);
        jobLog(`❌ VERTEX_EXIT_NO_FIRST_CANDIDATE: caller=${caller}`);
        return '';
    }

    jobLog(`🔍 VERTEX DEBUG 18: First candidate:`, JSON.stringify(res.candidates[0], null, 2));

    if (!res.candidates[0].content) {
        jobLog(`🔍 VERTEX DEBUG 19: NO CONTENT in first candidate`);
        jobLog(`❌ VERTEX_EXIT_NO_CONTENT: caller=${caller}`);
        return '';
    }

    jobLog(`🔍 VERTEX DEBUG 20: Content found:`, JSON.stringify(res.candidates[0].content, null, 2));

    if (!res.candidates[0].content.parts) {
        jobLog(`🔍 VERTEX DEBUG 21: NO PARTS in content`);
        jobLog(`❌ VERTEX_EXIT_NO_PARTS: caller=${caller}`);
        return '';
    }

    jobLog(`🔍 VERTEX DEBUG 22: Parts found, length=${res.candidates[0].content.parts.length}`);

    const parts = res.candidates[0].content.parts;
    for (let i = 0; i < parts.length; i++) {
        jobLog(`🔍 VERTEX DEBUG 23.${i}: Part ${i}:`, JSON.stringify(parts[i], null, 2));
    }

    const text = res?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') || '';
    jobLog(`🔍 VERTEX DEBUG 24: Final extracted text: "${text}"`);
    jobLog(`🔍 VERTEX DEBUG 25: Final text length: ${text.length}`);
    jobLog(`✅ VERTEX_SUCCESS: caller=${caller}, textLength=${text.length}`);

    // Log cumulative statistics periodically (every 10 calls)
    if (vertexStats.totalCalls % 10 === 0) {
        logVertexStats();
    }

    return text;
}

// Authentication helper functions for vertexDeduplicator
export async function getCloudAuthClient() {
    const b64 = process.env.GCP_SA_JSON_B64;
    const jsonPath = process.env.GCP_SA_JSON || process.env.SERVICE_ACCOUNT_JSON;

    authClientInstanceCount++;
    const instanceId = authClientInstanceCount;
    jobLog(`🔑 DIAG_AUTH_CLIENT_CREATE: instance_id=${instanceId}, has_b64=${!!b64}, has_json_path=${!!jsonPath}`);

    if (b64 || jsonPath) {
        let json;
        if (b64) {
            // Base64-encoded JSON credentials
            json = Buffer.from(b64, 'base64').toString('utf8');
        } else if (jsonPath) {
            // File path to JSON credentials
            json = fs.readFileSync(jsonPath, 'utf-8');
        }
        const credentials = JSON.parse(json);
        const auth = new GoogleAuth({ credentials, scopes: VERTEX_SCOPES });
        jobLog(`🔑 DIAG_AUTH_CLIENT_CREATED: instance_id=${instanceId}, type=explicit_credentials`);
        return auth.getClient();
    }

    // Default: keyless ADC on Cloud Run
    const auth = new GoogleAuth({ scopes: VERTEX_SCOPES });
    jobLog(`🔑 DIAG_AUTH_CLIENT_CREATED: instance_id=${instanceId}, type=ADC`);
    return auth.getClient();
}

export async function resolveProjectId(auth) {
    const explicit =
        process.env.VERTEX_AI_PROJECT_ID ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT;
    if (explicit) return explicit;
    const a = auth ?? new GoogleAuth();
    const pid = await a.getProjectId();
    return typeof pid === 'string' ? pid : String(pid);
}

export function resolveLocation() {
    return process.env.VERTEX_AI_LOCATION || 'us-central1';
}

export async function getAccessTokenViaAuth() {
  if (localDemoEnabled()) return getLocalDemoToken();
    const now = Date.now();

    // Check if token is cached and fresh (within 55 minutes = 3300000ms)
    if (tokenCache.token && tokenCache.fetchedAt && (now - tokenCache.fetchedAt) < 3300000) {
        const age = now - tokenCache.fetchedAt;
        jobLog(`🎫 DIAG_TOKEN_CACHE_HIT: age=${age}ms, will_reuse=true`);
        return tokenCache.token;
    }

    jobLog(`🎫 DIAG_TOKEN_FETCH_START: cached=${!!tokenCache.token}, cache_age=${tokenCache.fetchedAt ? now - tokenCache.fetchedAt : 'none'}ms`);
    const fetchStart = Date.now();

    const authClient = await getCloudAuthClient();
    const tokenObj = await authClient.getAccessToken();
    const token = typeof tokenObj === 'string'
        ? tokenObj
        : (tokenObj?.token || tokenObj?.access_token);

    if (!token) throw new Error('Failed to obtain access token via ADC');

    const fetchDuration = Date.now() - fetchStart;
    tokenCache.token = token;
    tokenCache.fetchedAt = Date.now();

    jobLog(`🎫 DIAG_TOKEN_FETCHED: duration=${fetchDuration}ms, length=${token.length}, cached_for_reuse=true`);
    return token;
}
