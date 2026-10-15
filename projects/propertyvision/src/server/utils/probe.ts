import { Logging } from '@google-cloud/logging';
import { getCurrentJobId } from './jobLogger';

// Cloud Logging client (lazy-loaded for local development)
// Pin projectId and resource explicitly to prevent logs going to different project/resource
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'your-google-cloud-project';
let cloudLogger: any = null;
let loggingClient: any = null;

function getCloudLogger() {
  if (!cloudLogger && process.env.NODE_ENV === 'development') {
    try {
      // Pin projectId explicitly (other AI agent recommendation #1)
      loggingClient = new Logging({ projectId: PROJECT_ID });
      cloudLogger = loggingClient.log('local-arv-test');
    } catch (err) {
      console.error('Failed to initialize Cloud Logging:', err);
      cloudLogger = false; // Prevent retry
    }
  }
  return cloudLogger === false ? null : cloudLogger;
}

/**
 * Extract caller file:line:col from Error stack trace
 * @param depth Stack depth to examine (default: 2)
 */
function callsite(depth = 2) {
  const s = new Error().stack?.split('\n')[depth] || '';
  const m = s.match(/\((.*?):(\d+):(\d+)\)/);
  return m ? { file: m[1], line: Number(m[2]), col: Number(m[3]) } : {};
}

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

type ProbeCommon = {
  probe: string;
  level?: Level;
  msg?: string;
  phase?: string;
  file?: string;
  line?: number;
  col?: number;
  jobId?: string;
  t0?: number;
  durMs?: number;
};

/**
 * Structured probe logging with automatic file:line:col capture
 *
 * Usage:
 *   probe({ probe: 'VERTEX_HTTP_ATTEMPT', attempt: 1, reqId: 'abc123' });
 *   probe({ probe: 'CACHE_HIT', level: 'DEBUG', key: 'vertex:result:abc' });
 *   probe({ probe: 'ERROR_OCCURRED', level: 'ERROR', msg: 'Timeout', httpStatus: 504 });
 */
export function probe(p: ProbeCommon & Record<string, any> = {}) {
  const { file, line, col } = callsite(3);
  const jobId = getCurrentJobId();

  const payload = {
    level: 'INFO',
    ...p,
    jobId,
    file: p.file || file,
    line: p.line || line,
    col: p.col || col,
  };

  // Always log to console (for local viewing and Cloud Run stdout capture)
  // Add [shortId] prefix like jobLog does
  const shortId = jobId ? jobId.slice(0, 8) : null;
  if (shortId) {
    console.log(`[${shortId}]`, JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }

  // In local development, also send to Cloud Logging API
  const logger = getCloudLogger();
  if (logger) {
    // Pin resource explicitly to prevent entries going to 'global' unexpectedly (other AI agent recommendation #2)
    const resource = {
      type: 'global',
      labels: { project_id: PROJECT_ID }
    };

    const entry = logger.entry({ severity: payload.level, resource }, payload);

    // Use partialSuccess=false to surface errors instead of silent drops (other AI agent recommendation #3)
    logger.write([entry], { partialSuccess: false }).catch((err: any) => {
      console.error(`❌ Cloud Logging write error (probe):`, err);
      console.error(`   Probe: ${payload.probe}`);
      console.error(`   Project: ${PROJECT_ID}`);
      console.error(`   Logger project: ${loggingClient?.projectId}`);
    });
  }
}
