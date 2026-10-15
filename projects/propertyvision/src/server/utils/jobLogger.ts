// Job-aware logger that sends to both console and Cloud Logging
// 🔧 PHASE 2 FIX: Replaced global variable with AsyncLocalStorage
import logger from './logger';
import { AsyncLocalStorage } from 'async_hooks';

// 🔧 AsyncLocalStorage provides isolated context per async operation
// BEFORE: Global variable `let currentJobId` caused context contamination
// AFTER: Each async task gets its own isolated storage
const jobContextStorage = new AsyncLocalStorage<string>();

console.log('🔧 PHASE 2: JobLogger initialized with AsyncLocalStorage');
console.log('   BEFORE: Global variable caused 85% log contamination in job 11e48fb1');
console.log('   AFTER: Each async operation has isolated job context');

/**
 * Run a function within an isolated job context
 * This prevents log contamination when processing multiple jobs concurrently
 *
 * Example:
 *   await runInJobContext('abc-123', async () => {
 *     jobLog('Processing'); // Will show [abc-123] Processing
 *   });
 */
export function runInJobContext<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const shortId = jobId.slice(0, 8);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`🔵 runInJobContext: Starting isolated context for job ${shortId}`);
  console.log(`   Full Job ID: ${jobId}`);
  console.log(`   AsyncLocalStorage will isolate all logs within this context`);

  return jobContextStorage.run(jobId, async () => {
    console.log(`✅ AsyncLocalStorage context ACTIVE for ${shortId}`);
    console.log(`   All jobLog() calls will now use bracket [${shortId}]`);

    try {
      const result = await fn();
      console.log(`✅ runInJobContext: Completed successfully for ${shortId}`);
      console.log(`   Context will be automatically cleaned up`);
      return result;
    } catch (error) {
      console.log(`❌ runInJobContext: Error in job ${shortId}`);
      console.log(`   Error: ${error}`);
      console.log(`   Context will be cleaned up despite error`);
      throw error;
    }
  });
}

/**
 * DEPRECATED: Use runInJobContext instead
 * Kept for backward compatibility during migration
 */
export function setJobContext(jobId: string | null) {
  console.warn('⚠️  setJobContext is DEPRECATED - use runInJobContext instead');
  console.warn('   This function does nothing now - AsyncLocalStorage handles context');
}

export function getCurrentJobId(): string | undefined {
  return jobContextStorage.getStore();
}

export function jobLog(...args: any[]): void {
  // Get job ID from AsyncLocalStorage (isolated per async context)
  const currentJobId = jobContextStorage.getStore();

  // Format message for Winston
  const message = args.map(arg =>
    typeof arg === 'string' ? arg : JSON.stringify(arg)
  ).join(' ');

  if (currentJobId) {
    const shortId = currentJobId.slice(0, 8);
    const prefixedMessage = `[${shortId}] ${message}`;
    // Send to both console (for terminal) and Winston (for Cloud Logging)
    console.log(prefixedMessage);
    logger.info(prefixedMessage, { jobId: currentJobId, source: 'jobLog' });
  } else {
    console.log(message);
    logger.info(message, { source: 'jobLog' });
  }
}

// Gracefully close Winston logger and wait for all transports to flush
export async function closeLogger(): Promise<void> {
  return new Promise((resolve) => {
    logger.close(() => {
      resolve();
    });
  });
}
