/**
 * Vertex AI Proxy Client
 * Routes Vertex AI calls through vertex-proxy service to avoid VPC network bottlenecks
 *
 * Model Strategy:
 * - gemini-2.0-flash-001 (default): Fast (262ms), for deduplication, parsing, coordinate extraction
 * - gemini-2.5-pro: Slower (2252ms) but supports grounded search for property details
 */

import { jobLog } from './jobLogger';

const USE_VERTEX_PROXY = process.env.USE_VERTEX_PROXY === 'true';
const VERTEX_PROXY_URL = process.env.VERTEX_PROXY_URL || '';
const PROXY_SHARED_KEY = process.env.PROXY_SHARED_KEY || '';

// Default to flash for speed (8.5x faster than pro)
const DEFAULT_MODEL = 'gemini-2.0-flash-001';

function diag(event: string, data?: any) {
  jobLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...data
  }));
}

interface VertexProxyGenerateOptions {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

interface VertexProxyDedupeOptions {
  comparables: any[];
  model?: string;
  timeoutMs?: number;
}

/**
 * Call Vertex AI generate endpoint via proxy
 */
export async function vertexProxyGenerate(opts: VertexProxyGenerateOptions): Promise<string> {
  if (!USE_VERTEX_PROXY) {
    throw new Error('USE_VERTEX_PROXY not enabled');
  }

  const startTime = Date.now();

  diag('vertex.proxy.generate.call', {
    promptLength: opts.prompt.length,
    model: opts.model || DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs
  });

  try {
    const response = await fetch(`${VERTEX_PROXY_URL}/vertex/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-proxy-key': PROXY_SHARED_KEY
      },
      body: JSON.stringify({
        prompt: opts.prompt,
        model: opts.model || DEFAULT_MODEL,
        timeoutMs: opts.timeoutMs || 30000,
        temperature: opts.temperature ?? 0.1,
        maxOutputTokens: opts.maxOutputTokens || 8192
      }),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs + 1000) : undefined
    });

    const elapsedMs = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'unknown' }));
      diag('vertex.proxy.generate.error', {
        status: response.status,
        error,
        elapsedMs
      });
      throw new Error(`Vertex proxy error: ${response.status} - ${JSON.stringify(error)}`);
    }

    const result = await response.json();

    diag('vertex.proxy.generate.success', {
      elapsedMs,
      textLength: result.text?.length || 0
    });

    return result.text || '';
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;

    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      diag('vertex.proxy.generate.timeout', {
        timeoutMs: opts.timeoutMs,
        elapsedMs
      });
      throw new Error(`Vertex proxy timeout after ${elapsedMs}ms`);
    }

    diag('vertex.proxy.generate.error', {
      error: error.message,
      elapsedMs
    });
    throw error;
  }
}

/**
 * Call Vertex AI deduplicate endpoint via proxy
 */
export async function vertexProxyDeduplicate(opts: VertexProxyDedupeOptions): Promise<any> {
  if (!USE_VERTEX_PROXY) {
    throw new Error('USE_VERTEX_PROXY not enabled');
  }

  const startTime = Date.now();

  diag('vertex.proxy.dedupe.call', {
    comparablesCount: opts.comparables.length,
    model: opts.model || DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs
  });

  try {
    const response = await fetch(`${VERTEX_PROXY_URL}/vertex/deduplicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-proxy-key': PROXY_SHARED_KEY
      },
      body: JSON.stringify({
        comparables: opts.comparables,
        model: opts.model || DEFAULT_MODEL,
        timeoutMs: opts.timeoutMs || 30000
      }),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs + 1000) : undefined
    });

    const elapsedMs = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'unknown' }));
      diag('vertex.proxy.dedupe.error', {
        status: response.status,
        error,
        elapsedMs
      });
      throw new Error(`Vertex dedupe proxy error: ${response.status} - ${JSON.stringify(error)}`);
    }

    const result = await response.json();

    diag('vertex.proxy.dedupe.success', {
      elapsedMs,
      duplicateGroups: result.duplicate_groups?.length || 0,
      droppedCount: result.dropped_record_ids?.length || 0
    });

    return result;
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;

    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      diag('vertex.proxy.dedupe.timeout', {
        timeoutMs: opts.timeoutMs,
        elapsedMs
      });
      throw new Error(`Vertex dedupe proxy timeout after ${elapsedMs}ms`);
    }

    diag('vertex.proxy.dedupe.error', {
      error: error.message,
      elapsedMs
    });
    throw error;
  }
}

/**
 * Check if vertex proxy is enabled and configured
 */
export function isVertexProxyEnabled(): boolean {
  return USE_VERTEX_PROXY && !!VERTEX_PROXY_URL && !!PROXY_SHARED_KEY;
}
