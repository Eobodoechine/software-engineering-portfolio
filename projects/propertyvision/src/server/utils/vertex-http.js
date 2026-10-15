// Single fortified HTTP client for Vertex AI
// ESM-friendly. If your project is CJS, see note at the bottom.

import Bottleneck from 'bottleneck';
import https from 'https';
import { probe } from './probe';

// ---- Tunables via env (sane defaults) ----
const RPS = Number(process.env.PV_VERTEX_RPS ?? 4);                  // requests/sec
const MAX_CONCURRENCY = Number(process.env.PV_VERTEX_MAX_CONCURRENCY ?? 2);
const MAX_ATTEMPTS = Number(process.env.PV_VERTEX_MAX_ATTEMPTS ?? 5);
const BASE_DELAY_MS = Number(process.env.PV_VERTEX_BASE_DELAY_MS ?? 500);
const RESERVOIR = Number(process.env.PV_VERTEX_RESERVOIR ?? 60);     // per minute
const TIMEOUT_MS = Number(process.env.PV_VERTEX_TIMEOUT_MS ?? 120000); // request timeout (2 minutes)

// ---- Keep-alive HTTPS agent for connection reuse ----
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: TIMEOUT_MS,
});

// ---- Global rate limiter (per instance) ----
const limiter = new Bottleneck({
  minTime: Math.ceil(1000 / Math.max(RPS, 1)),
  maxConcurrent: Math.max(MAX_CONCURRENCY, 1),
});
limiter.updateSettings({
  reservoir: RESERVOIR,
  reservoirRefreshInterval: 60_000,
  reservoirRefreshAmount: RESERVOIR,
});

// ---- Helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => {
  const span = Math.floor(ms * 0.2);
  return ms + Math.floor(Math.random() * (2 * span) - span);
};
const calcDelayMs = (attempt, retryAfterSec) => {
  if (retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000;
  const backoff = BASE_DELAY_MS * (2 ** (attempt - 1));
  return jitter(Math.min(backoff, 15_000));
};

// ---- Core: POST with backoff + probes ----
export async function postJsonWithBackoff(url, { headers = {}, bodyJson, jobLog }) {
  const reqId = Math.random().toString(36).slice(2, 10);
  probe({ probe: 'VERTEX_HTTP_SCHEDULE', reqId, urlPrefix: url?.slice(0, 80) });

  async function send(attempt) {
    const t0 = Date.now();
    probe({ probe: 'VERTEX_HTTP_ATTEMPT', attempt, reqId, t0 });
    let res, text, status = 0, retryAfter = 0;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        probe({ probe: 'VERTEX_HTTP_TIMEOUT', level: 'WARN', attempt, reqId, timeoutMs: TIMEOUT_MS });
        ctrl.abort();
      }, TIMEOUT_MS);

      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(bodyJson),
        signal: ctrl.signal,
        agent: url.startsWith('https:') ? httpsAgent : undefined,
      });
      clearTimeout(timer);

      text = await res.text();
      status = res.status;
      retryAfter = Number(res.headers.get('retry-after') || 0);

      probe({
        probe: 'VERTEX_HTTP_RESPONSE',
        attempt,
        reqId,
        status,
        durMs: Date.now() - t0,
        retryAfter
      });
    } catch (e) {
      // Network/timeout error: mark as retryable
      const durMs = Date.now() - t0;
      const delay = calcDelayMs(attempt, 0);
      const errorCode = e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';

      probe({
        probe: 'VERTEX_HTTP_ERROR',
        level: 'WARN',
        attempt,
        reqId,
        errorCode,
        errorName: e?.name,
        msg: String(e?.message || e),
        durMs,
        delayMs: delay
      });

      if (attempt < MAX_ATTEMPTS) {
        await sleep(delay);
        return send(attempt + 1);
      }

      probe({
        probe: 'VERTEX_HTTP_EXHAUSTED',
        level: 'ERROR',
        attempt,
        reqId,
        errorCode,
        msg: String(e?.message || e)
      });

      const err = new Error(`Vertex ${errorCode} error after ${attempt} attempts: ${String(e?.message || e)}`);
      err.code = errorCode;
      err.httpStatus = 0;
      err.retryable = true;
      throw err;
    }

    if (status >= 200 && status < 300) {
      try {
        const result = JSON.parse(text);
        probe({ probe: 'VERTEX_HTTP_OK', attempt, reqId, totalMs: Date.now() - t0 });
        return result;
      } catch (e) {
        probe({
          probe: 'VERTEX_HTTP_PARSE_ERROR',
          level: 'ERROR',
          reqId,
          status,
          msg: String(e),
          bodyPreview: text.slice(0, 200)
        });
        const err = new Error(`Vertex JSON parse failed: ${String(e)}`);
        err.code = 'PARSE_ERROR';
        err.httpStatus = status;
        err.retryable = false;
        throw err;
      }
    }

    const retryable = [429, 500, 502, 503, 504].includes(status);
    if (retryable && attempt < MAX_ATTEMPTS) {
      const delay = calcDelayMs(attempt, retryAfter);
      probe({
        probe: 'VERTEX_HTTP_RETRY',
        level: 'WARN',
        attempt,
        reqId,
        status,
        delayMs: delay
      });
      await sleep(delay);
      return send(attempt + 1);
    }

    // Non-retryable or attempts exhausted
    let message = `Vertex API error [${status}]`;
    let errorDetails = {};
    try {
      const body = JSON.parse(text);
      if (body?.error?.message) {
        message += `: ${body.error.message}`;
        errorDetails = body.error;
      }
    } catch {
      errorDetails = { bodyPreview: text.slice(0, 200) };
    }

    probe({
      probe: 'VERTEX_HTTP_FINAL_ERROR',
      level: 'ERROR',
      attempt,
      reqId,
      status,
      retryable,
      errorDetails
    });

    const err = new Error(message);
    err.code = status === 429 ? 'RATE_LIMIT' : 'API_ERROR';
    err.httpStatus = status;
    err.retryable = retryable;
    throw err;
  }

  return await limiter.schedule(() => send(1));
}

export default { postJsonWithBackoff };
