import https from 'https';
import pLimit from 'p-limit';
import { jobLog } from '../utils/jobLogger';

/**
 * Vertex AI Client with Connection Pooling, Token Caching, and Retry Logic
 * - Keep-alive agent for connection reuse
 * - OAuth token caching with auto-refresh
 * - Exponential backoff retries
 * - Bounded concurrency (default: 10 concurrent requests)
 */

interface VertexGenerateOptions {
  projectId: string;
  location: string;
  model: string;
  prompt: string;
  grounded?: boolean;
  json?: boolean;
  responseSchema?: any;
  timeoutMs?: number;
  sa: any; // Service account credentials
}

interface TokenCache {
  token: string;
  expiresAt: number; // Unix timestamp in ms
}

class VertexClient {
  private agent: https.Agent;
  private tokenCache: Map<string, TokenCache> = new Map();
  private limiter: ReturnType<typeof pLimit>;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_BASE_DELAY_MS = 1000;
  private readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
  private readonly DEFAULT_TIMEOUT_MS = 90000; // 90 seconds

  constructor(concurrency: number = 10) {
    // Create keep-alive agent for connection pooling
    this.agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000, // Send keepalive probes every 30s
      maxSockets: concurrency,
      maxFreeSockets: 10,
      timeout: 120000, // Socket timeout 2 minutes
    });

    // Bounded concurrency limiter
    this.limiter = pLimit(concurrency);

    jobLog(`✅ VertexClient initialized: concurrency=${concurrency}, keepAlive=true`);
  }

  /**
   * Get or refresh OAuth token for service account
   */
  private async getToken(sa: any, scope: string): Promise<string> {
    const cacheKey = `${sa.client_email}:${scope}`;
    const cached = this.tokenCache.get(cacheKey);

    // Return cached token if still valid
    if (cached && cached.expiresAt > Date.now() + this.TOKEN_REFRESH_BUFFER_MS) {
      return cached.token;
    }

    // Generate new token
    jobLog(`🔑 Generating new OAuth token for ${sa.client_email}`);
    const token = await this.generateServiceAccountToken(sa, scope);

    // Cache token (expires in 3600s, refresh 5 min early)
    this.tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + 3600 * 1000,
    });

    return token;
  }

  /**
   * Generate service account OAuth token
   */
  private async generateServiceAccountToken(sa: any, scope: string): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600;
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = { iss: sa.client_email, scope, aud: sa.token_uri, exp, iat };

    const base64url = (obj: any) =>
      Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    const unsigned = `${base64url(header)}.${base64url(claims)}`;

    // Fix private key format
    const formattedPrivateKey = sa.private_key.replace(/\\n/g, '\n');

    // Sign JWT
    const { createSign } = await import('node:crypto');
    const sign = createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign
      .sign(formattedPrivateKey)
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const assertion = `${unsigned}.${signature}`;

    // Exchange JWT for OAuth token
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const resp = await this.httpsPostForm(sa.token_uri, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (!resp?.access_token) {
      throw new Error('Failed to get service account token');
    }

    return resp.access_token;
  }

  /**
   * HTTPS POST with form data
   */
  private async httpsPostForm(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number = 20000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          method: 'POST',
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body).toString(),
          },
          agent: this.agent,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        }
      );

      // Implement timeout to prevent indefinite hangs
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        const error = new Error(`Request timeout after ${timeoutMs}ms`);
        (error as any).code = 'ETIMEDOUT';
        reject(error);
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * HTTPS POST with JSON payload and retry logic
   */
  private async httpsPostJson(
    url: string,
    payload: any,
    headers: Record<string, string>,
    timeoutMs: number,
    retryCount: number = 0
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const body = JSON.stringify(payload);

      const req = https.request(
        {
          method: 'POST',
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
            ...headers,
          },
          agent: this.agent,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ raw: data });
            }
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        const error = new Error(`Request timeout after ${timeoutMs}ms`);
        (error as any).code = 'ETIMEDOUT';
        reject(error);
      });

      req.on('error', (err) => {
        (err as any).retryCount = retryCount;
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Generate content with Vertex AI (with exponential backoff retries)
   */
  async generate(opts: VertexGenerateOptions): Promise<string> {
    return this.limiter(async () => {
      const timeoutMs = opts.timeoutMs || this.DEFAULT_TIMEOUT_MS;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
        try {
          const startTime = Date.now();
          const callType = opts.grounded ? 'GROUNDED' : 'NON-GROUNDED';

          if (attempt > 0) {
            const delay = this.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            jobLog(`🔄 VERTEX RETRY ${attempt}/${this.MAX_RETRIES} after ${delay}ms delay`);
            await new Promise((r) => setTimeout(r, delay));
          }

          jobLog(
            `📊 VERTEX_CALL_START: attempt=${attempt + 1}, type=${callType}, timeout=${timeoutMs}ms`
          );

          // Get OAuth token (cached)
          const token = await this.getToken(
            opts.sa,
            'https://www.googleapis.com/auth/cloud-platform'
          );

          const endpoint = `https://aiplatform.googleapis.com/v1/projects/${opts.projectId}/locations/${opts.location}/publishers/google/models/${opts.model}:generateContent`;

          const payload: any = {
            contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
            generationConfig: {
              temperature: 0,
              seed: 12345,
              maxOutputTokens: 8192,
              ...(opts.json ? { responseMimeType: 'application/json' } : {}),
            },
          };

          if (opts.grounded) {
            payload.tools = [{ google_search: {} }];
          }
          if (opts.responseSchema) {
            payload.generationConfig.responseSchema = opts.responseSchema;
          }

          const res = await this.httpsPostJson(
            endpoint,
            payload,
            { Authorization: `Bearer ${token}` },
            timeoutMs,
            attempt
          );

          const duration = Date.now() - startTime;
          jobLog(
            `📊 VERTEX_CALL_COMPLETE: attempt=${attempt + 1}, type=${callType}, duration=${duration}ms`
          );

          if (!res || !res.candidates || !res.candidates[0]) {
            if (res?.error) {
              console.error(`❌ VERTEX API ERROR:`, JSON.stringify(res.error, null, 2));
              // Check if retryable error
              const statusCode = res.error.code;
              if (statusCode === 429 || statusCode === 503 || statusCode >= 500) {
                throw new Error(`Vertex API error: ${res.error.message} (retryable)`);
              }
            }
            return '';
          }

          const text =
            res.candidates[0].content?.parts?.map((p: any) => p?.text || '').join('') || '';
          return text;
        } catch (error: any) {
          lastError = error;

          // Check if error is retryable
          const isRetryable =
            error.code === 'ETIMEDOUT' ||
            error.code === 'ECONNRESET' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ECONNREFUSED' ||
            error.message?.includes('socket hang up') ||
            error.message?.includes('retryable');

          console.error(
            `❌ VERTEX ERROR (attempt ${attempt + 1}/${this.MAX_RETRIES + 1}):`,
            error.message,
            `retryable=${isRetryable}`
          );

          // Don't retry if not retryable or out of retries
          if (!isRetryable || attempt === this.MAX_RETRIES) {
            break;
          }
        }
      }

      // All retries exhausted
      console.error(`❌ VERTEX CALL FAILED after ${this.MAX_RETRIES + 1} attempts:`, lastError);
      return '';
    });
  }

  /**
   * Shutdown client (close keep-alive connections)
   */
  destroy() {
    this.agent.destroy();
    jobLog('🔌 VertexClient destroyed');
  }
}

// Declare global type for development mode hot reload persistence
declare global {
  var __vertexClient: VertexClient | undefined;
}

// Singleton instance
let vertexClientInstance: VertexClient | null = null;

export function getVertexClient(concurrency: number = 10): VertexClient {
  // In development, use globalThis to persist across hot reloads
  if (process.env.NODE_ENV !== 'production') {
    if (!global.__vertexClient) {
      global.__vertexClient = new VertexClient(concurrency);
    }
    return global.__vertexClient;
  }

  // In production, use regular singleton
  if (!vertexClientInstance) {
    vertexClientInstance = new VertexClient(concurrency);
  }
  return vertexClientInstance;
}

// Export singleton instance
export const vertexClient = getVertexClient();
