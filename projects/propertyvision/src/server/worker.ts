import 'dotenv/config';
import os from 'os';
import { getJobQueue } from './utils/jobQueue';
import { jobLog } from './utils/jobLogger';
import { getRedisCache } from './utils/redisCache';
import http from 'http';

async function startWorker() {
  if (process.env.RUN_WORKER !== 'true') {
    jobLog('⏭️  Worker disabled (RUN_WORKER != true)');
    return;
  }

  // Emit WORKER_ANNOUNCE for diagnostics
  console.log(JSON.stringify({
    t: Date.now(),
    kind: 'WORKER_ANNOUNCE',
    pid: process.pid,
    hostname: os.hostname(),
    run_label: process.env.RUN_LABEL || 'default',
    vertex_concurrency_limit: process.env.VERTEX_CONCURRENCY_LIMIT,
    vertex_pacing_ms: process.env.VERTEX_PACING_MS
  }));

  // S0: Acquire exclusive Redis lock for cross-host isolation
  if (process.env.RUN_LABEL?.startsWith('S0')) {
    const redis = getRedisCache();
    const LOCK_KEY = 'pv:s0_lock';
    const LOCK_TTL_SECONDS = 15 * 60; // 15 minutes
    const HEARTBEAT_MS = 60 * 1000;   // Renew every 60 seconds
    const lockValue = `${os.hostname()}:${process.pid}`;

    // Wait for Redis to connect before acquiring lock
    await redis.ensureConnected();

    const lockAcquired = await redis.acquireLock(
      LOCK_KEY,
      lockValue,
      LOCK_TTL_SECONDS
    );

    if (!lockAcquired) {
      console.error(JSON.stringify({
        t: Date.now(),
        kind: 'ISOLATION_WARNING',
        message: 'S0 requires exclusive lock pv:s0_lock - ABORTING'
      }));
      process.exit(1);
    }

    // Start heartbeat to renew lock TTL (prevents expiry during long jobs)
    const heartbeatInterval = setInterval(() => {
      redis.renewLock(LOCK_KEY, lockValue, LOCK_TTL_SECONDS).catch((err) => {
        console.error(JSON.stringify({
          t: Date.now(),
          kind: 'LOCK_RENEW_FAILED',
          error: err.message
        }));
      });
    }, HEARTBEAT_MS);
    // Prevent heartbeat from keeping node alive
    heartbeatInterval.unref?.();

    // Safe release function (clears heartbeat and releases lock)
    const safeRelease = () => {
      clearInterval(heartbeatInterval);
      redis.releaseLock(LOCK_KEY, lockValue).catch(() => {});
    };

    // Register cleanup handlers
    process.on('exit', safeRelease);
    process.on('SIGINT', () => { safeRelease(); process.exit(0); });
    process.on('SIGTERM', () => { safeRelease(); process.exit(0); });

    console.log(JSON.stringify({
      t: Date.now(),
      kind: 'NO_OTHER_WORKERS',
      message: 'S0 isolation verified (Redis lock acquired)',
      lock_value: lockValue,
      heartbeat_ms: HEARTBEAT_MS
    }));
  }

  jobLog('🚀 Starting job worker...');
  const jobQueue = getJobQueue();

  // Start HTTP server for Cloud Run health checks and wake-up endpoint
  const PORT = parseInt(process.env.PORT || '8080', 10);
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else if (req.url === '/wake' && req.method === 'POST') {
      // Wake-up endpoint to trigger Cloud Run scale-up from zero
      // Worker will pick up jobs from Redis Stream in background
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Worker waking up' }));
      jobLog('👋 Wake-up call received - worker is active');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  // Start HTTP server and wait for it to be ready
  await new Promise<void>((resolve) => {
    const host = process.env.PV_LOCAL_DEMO === 'true' ? '127.0.0.1' : '0.0.0.0';
    server.listen(PORT, host, () => {
      jobLog(`✅ Worker health check server listening on ${host}:${PORT}`);
      resolve();
    });
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    jobLog('📪 SIGTERM received, stopping worker...');
    server.close();
    await jobQueue.stop();
    process.exit(0);
  });

  // Start processing jobs (non-blocking - runs in background)
  jobQueue.processJobs().catch((error) => {
    console.error('❌ Job processing error:', error);
  });
}

startWorker().catch((error) => {
  console.error('❌ Worker failed:', error);
  process.exit(1);
});
