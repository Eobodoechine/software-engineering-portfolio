// Job Queue with Redis Streams for async processing
import { getRedisCache } from './redisCache';
import { ComprehensiveComparableSearchV5 } from '../comprehensive-comp-search-v5';
import { ComprehensiveComparableSearchV10 } from '../comprehensive-comp-search-v10';
import { parallelSearchConfig } from './parallelSearchConfig';
import { sendErrorNotification, sendSuccessNotification } from './emailNotification';
import { GoogleMapsGeocoder } from './googleMapsGeocoder';
import { randomUUID } from 'crypto';
import os from 'os';
import { jobLog, setJobContext, runInJobContext } from './jobLogger';
import { setCurrentJobContext, PHASES as JOB_PHASES } from './jobProgress';

// Global job context - allows comprehensive-comp-search to update progress
// Initialized immediately to avoid Temporal Dead Zone issues during module imports

// Environment-aware stream/group names to isolate staging from production
const ENV_PREFIX = process.env.IS_STAGING === 'true' ? 'staging:' : 'prod:';
const STREAM = `${ENV_PREFIX}jobs`;
const GROUP = `${ENV_PREFIX}workers`;
const HEARTBEAT_MS = 7_000; // 7 seconds
const MIN_IDLE_MS = 28_000; // 28 seconds (4x heartbeat - prevents premature reclaim)
// 🔧 PHASE 1 FIX: Increased MIN_IDLE_MS from 12000 to 28000
// WHY: MIN_IDLE_MS should be 4-6x HEARTBEAT_MS to prevent race conditions
// BEFORE: 12s was only 1.7x heartbeat (7s) - too aggressive
// AFTER: 28s is 4x heartbeat - safe buffer for network delays
console.log('🔧 MIN_IDLE_MS Configuration: 28000ms (4x heartbeat interval)');
console.log('   HEARTBEAT_MS: 7000ms');
console.log('   MIN_IDLE_MS: 28000ms (safe buffer for crash recovery)');
const MAX_ATTEMPTS = 1; // Fast failure detection - maximizes speed + error handling
const JOB_TTL = process.env.PV_LOCAL_DEMO === 'true' ? 86400 : 3600;

// Get unique consumer ID per container
const CONSUMER = `${os.hostname()}:${process.pid}`;

interface JobData {
  jobId: string;
  address: string;
  userId?: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  phase: string;
  phaseMessage?: string; // User-friendly message for current phase
  estimatedTimeRemaining?: number; // Seconds remaining (estimated)
  phaseStartTime?: number; // Timestamp when current phase started (for real ETA calculation)
  result?: any;
  error?: string;
  attempts: number;
  createdAt: number;
  lastHeartbeat: number;
  completedAt?: number;
  processingBy?: string; // Track which worker is processing this job
  processingMessageId?: string; // Track which stream message is being processed (prevents same consumer re-processing)
  cancelRequested?: boolean; // User requested cancellation
}



// Helper function to check if job is cancelled

export class JobQueue {
  private redis = getRedisCache();
  private analysisService: ComprehensiveComparableSearchV5 | ComprehensiveComparableSearchV10;
  private isProcessing = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reclaimInterval: NodeJS.Timeout | null = null;
  private shouldRestart = false;

  // 🔧 CONCURRENCY FIX v1.0: Semaphore pattern to limit concurrent job processing
  private maxConcurrentJobs = Number(process.env.PV_MAX_CONCURRENT_JOBS || 3);
  private activeJobs = 0;
  private jobCompletedCallbacks: Array<() => void> = [];

  // 🔧 BUG FIX: Track jobs currently being processed to prevent PEL duplicate processing
  private processingJobIds = new Map<string, boolean>();

  constructor() {
    // Use V10 if parallel search is enabled, otherwise V5
    const useV10 = parallelSearchConfig.enabled;
    this.analysisService = useV10
      ? new ComprehensiveComparableSearchV10()
      : new ComprehensiveComparableSearchV5();

    jobLog(`✅ JobQueue initialized with ${useV10 ? 'V10 (Parallel Search)' : 'V5 (Sequential Search)'}`);
    jobLog(`🔧 [CONCURRENCY_CONFIG] Max concurrent jobs: ${this.maxConcurrentJobs} (env: PV_MAX_CONCURRENT_JOBS)`);

    // Register reconnect callback to restart worker
    this.redis.onReconnect(() => {
      if (this.shouldRestart && !this.isProcessing) {
        jobLog('♻️  Redis reconnected, restarting worker...');
        this.processJobs().catch((error) => {
          console.error('❌ Worker restart failed:', error);
        });
      }
    });
  }

  /**
   * 🔧 CONCURRENCY FIX: Acquire slot for job processing (semaphore pattern)
   * Waits if max concurrent jobs already running
   */
  private async acquireJobSlot(): Promise<void> {
    jobLog(`🔧 [SEMAPHORE_ACQUIRE_START] Current: ${this.activeJobs}/${this.maxConcurrentJobs}, waiting: ${this.jobCompletedCallbacks.length}`);

    if (this.activeJobs < this.maxConcurrentJobs) {
      this.activeJobs++;
      jobLog(`✅ [SEMAPHORE_ACQUIRED] Slot acquired immediately (${this.activeJobs}/${this.maxConcurrentJobs} active)`);
      return;
    }

    // Wait for a job to complete
    const waitStartTime = Date.now();
    jobLog(`⏸️  [SEMAPHORE_WAITING] Max concurrency reached (${this.maxConcurrentJobs}), waiting for slot...`);

    await new Promise<void>((resolve) => {
      this.jobCompletedCallbacks.push(resolve);
      jobLog(`🔧 [SEMAPHORE_QUEUED] Added to wait queue (position: ${this.jobCompletedCallbacks.length})`);
    });

    const waitDuration = Date.now() - waitStartTime;
    this.activeJobs++;
    jobLog(`✅ [SEMAPHORE_ACQUIRED_AFTER_WAIT] Slot acquired after ${waitDuration}ms wait (${this.activeJobs}/${this.maxConcurrentJobs} active)`);
  }

  /**
   * 🔧 CONCURRENCY FIX: Release slot after job completion
   */
  private releaseJobSlot(): void {
    const beforeCount = this.activeJobs;
    this.activeJobs = Math.max(0, this.activeJobs - 1); // Guard against negative

    jobLog(`🔧 [SEMAPHORE_RELEASE] Slot released (${beforeCount} -> ${this.activeJobs}/${this.maxConcurrentJobs})`);

    if (beforeCount === this.activeJobs && this.activeJobs > 0) {
      console.warn(`⚠️  [SEMAPHORE_RELEASE_WARNING] activeJobs didn't decrement (stuck at ${this.activeJobs})`);
    }

    // Wake up waiting job if any
    const callback = this.jobCompletedCallbacks.shift();
    if (callback) {
      jobLog(`🔧 [SEMAPHORE_WAKE] Waking up waiting job (${this.jobCompletedCallbacks.length} still waiting)`);
      try {
        callback();
        jobLog(`✅ [SEMAPHORE_WAKE_SUCCESS] Waiting job notified`);
      } catch (error) {
        console.error(`❌ [SEMAPHORE_WAKE_FAILED] Failed to notify waiting job:`, error);
      }
    } else {
      jobLog(`🔧 [SEMAPHORE_WAKE] No waiting jobs in queue`);
    }
  }

  /**
   * Initialize stream and consumer group
   */
  async initialize(): Promise<void> {
    // Ensure Redis is connected before operations
    await this.redis.ensureConnected();
    await this.redis.xgroupCreate(STREAM, GROUP, '$');
    jobLog(`✅ Job queue initialized: stream=${STREAM}, group=${GROUP}, consumer=${CONSUMER}`);
  }

  /**
   * Enqueue a new job
   */
  async enqueueJob(address: string, userId?: string): Promise<string> {
    const jobId = randomUUID();
    const now = Date.now();

    const jobData: JobData = {
      jobId,
      address,
      userId,
      status: 'queued',
      progress: 0,
      phase: 'Queued',
      attempts: 0,
      createdAt: now,
      lastHeartbeat: now
    };

    // Store job status in Redis hash
    await this.redis.setJob(jobId, jobData, JOB_TTL);

    // Add to stream
    const streamId = await this.redis.xadd(STREAM, {
      jobId,
      address,
      userId: userId || '',
      createdAt: now.toString()
    });

    if (!streamId) {
      throw new Error('Failed to enqueue job');
    }

    jobLog(`📋 Job ${jobId} enqueued for address: ${address}`);

    // Wake up worker (fire-and-forget HTTP call to trigger Cloud Run scale-up)
    this.wakeWorker().catch((error) => {
      // Don't fail the enqueue if wake call fails - worker will pick up job eventually
      jobLog(`⚠️  Wake call failed (non-fatal): ${error.message}`);
    });

    return jobId;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<JobData | null> {
    return await this.redis.getJob(jobId);
  }

  /**
   * Update job progress with phase information and estimated time
   */
  async updateProgress(jobId: string, phaseKey: keyof typeof JOB_PHASES): Promise<void> {
    const phase = JOB_PHASES[phaseKey];
    const job = await this.getJobStatus(jobId);
    if (!job) return;

    const now = Date.now();

    // Calculate countdown: total max time minus sum of previous phases' allocated times
    const TOTAL_MAX_TIME = 300; // Total max time in seconds
    const phaseOrder: (keyof typeof JOB_PHASES)[] = [
      'QUEUED', 'SUBJECT_PROPERTY', 'COMPARABLE_SEARCH_L1',
      'DEDUPLICATION', 'ARV_CALCULATION', 'FINALIZING', 'COMPLETED'
    ];

    const currentPhaseIndex = phaseOrder.indexOf(phaseKey);
    const allocatedTimeConsumed = phaseOrder
      .slice(0, currentPhaseIndex)
      .reduce((sum, key) => sum + JOB_PHASES[key].estimatedSeconds, 0);

    const countdownRemaining = TOTAL_MAX_TIME - allocatedTimeConsumed;

    // If we're running over time, update the message to reflect that
    const phaseMessage = countdownRemaining <= 0
      ? `${phase.message} (Taking a bit longer than usual...)`
      : phase.message;

    // Store phase start time for real ETA calculation
    await this.updateJob(jobId, {
      progress: phase.progress,
      phase: phase.name,
      phaseMessage,
      estimatedTimeRemaining: Math.max(0, countdownRemaining),
      phaseStartTime: now
    });
  }

  /**
   * Request job cancellation
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.getJobStatus(jobId);
    if (!job) return false;

    if (job.status === 'completed' || job.status === 'failed') {
      return false; // Can't cancel completed jobs
    }

    await this.updateJob(jobId, {
      cancelRequested: true,
      phaseMessage: 'Cancellation requested...'
    });

    jobLog(`🚫 Cancellation requested for job ${jobId}`);
    return true;
  }

  /**
   * Update job data
   */
  private async updateJob(jobId: string, updates: Partial<JobData>): Promise<void> {
    // Only log if it's more than just a heartbeat update
    const isHeartbeatOnly = Object.keys(updates).length === 1 && 'lastHeartbeat' in updates;
    if (!isHeartbeatOnly) {
      jobLog(`💾 Updating job ${jobId} with:`, JSON.stringify(updates));
    }

    const job = await this.getJobStatus(jobId);
    if (job) {
      const updated = { ...job, ...updates, lastHeartbeat: Date.now() };
      await this.redis.setJob(jobId, updated, JOB_TTL);
      if (!isHeartbeatOnly) {
        jobLog(`✅ Job ${jobId} saved to Redis: status=${updated.status}, progress=${updated.progress}`);
      }
    } else {
      console.error(`❌ CRITICAL: Job ${jobId} not found in Redis during updateJob! Creating new entry.`);
      const newJob = {
        jobId,
        ...updates,
        lastHeartbeat: Date.now(),
        createdAt: updates.createdAt || Date.now()
      };
      await this.redis.setJob(jobId, newJob, JOB_TTL);
      jobLog(`✅ Job ${jobId} created in Redis: status=${newJob.status}, progress=${newJob.progress}`);
    }

    // The bare site link opens this pointer, so a shared URL lands on a finished
    // report instead of an empty form. Same TTL as the job record so it can never
    // point at a report that has already expired.
    if (updates.status === 'completed') {
      await this.redis.setex('latestReport', JOB_TTL, jobId);
    }
  }

  /**
   * Process jobs from stream (main worker loop)
   */
  async processJobs(): Promise<void> {
    if (this.isProcessing) {
      console.warn('⚠️  Worker already running');
      return;
    }

    await this.initialize();
    this.isProcessing = true;
    this.shouldRestart = true; // Mark that worker should restart if Redis reconnects

    // Start heartbeat reaper (reclaim stuck jobs)
    this.startReaper();

    jobLog(`🔄 Worker started: ${CONSUMER}`);

    try {
      while (this.isProcessing) {
        // Reduced block timeout from 15s to 5s for better connection stability
        const messages = await this.redis.xreadGroup(GROUP, CONSUMER, STREAM, 10, 5000);

        if (!messages || messages.length === 0) {
          jobLog('⏱️  No messages received (timeout or empty queue)');
          continue;
        }

        jobLog(`📬 Received ${messages.length} stream(s) with messages`);

        for (const streamData of messages) {
          if (!streamData || !Array.isArray(streamData) || streamData.length < 2) {
            continue;
          }

          const messagesArray = streamData[1];
          if (!Array.isArray(messagesArray)) {
            continue;
          }

          for (const message of messagesArray) {
            if (!Array.isArray(message) || message.length < 2) {
              continue;
            }

            const [messageId, fields] = message;
            const jobData = this.parseStreamMessage(fields);

            if (!jobData || !jobData.jobId) {
              console.error('❌ Invalid job data:', fields);
              await this.redis.xack(STREAM, GROUP, messageId);
              continue;
            }

            // 🔧 BUG FIX: Skip if this job is already being processed (PEL deduplication)
            if (this.processingJobIds.has(jobData.jobId)) {
              jobLog(`⚠️  Job ${jobData.jobId.substring(0, 8)} already being processed, skipping duplicate PEL entry`);
              await this.redis.xack(STREAM, GROUP, messageId);
              continue;
            }

            // Mark as processing
            this.processingJobIds.set(jobData.jobId, true);

            try {
              await this.processJob(jobData.jobId, jobData.address, messageId);
            } catch (error: any) {
              await this.handleJobFailure(jobData.jobId, error, messageId);
            } finally {
              // Clean up tracking map
              this.processingJobIds.delete(jobData.jobId);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Worker error:', error);
      this.isProcessing = false;
    }
  }

  /**
   * Parse stream message to job data
   */
  private parseStreamMessage(fields: any): { jobId: string; address: string; userId?: string } | null {
    if (Array.isArray(fields)) {
      const obj: any = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      return obj;
    }
    return fields;
  }

  /**
   * Process a single job
   */
  private async processJob(jobId: string, address: string, messageId: string): Promise<void> {
    // 🔧 PHASE 3 FIX: Wrap entire method in runInJobContext for isolated logging
    console.log('═══════════════════════════════════════════════════════');
    console.log(`🚀 processJob ENTRY`);
    console.log(`   jobId: ${jobId.slice(0, 8)}...`);
    console.log(`   address: ${address}`);
    console.log(`   messageId: ${messageId}`);
    console.log(`   About to enter runInJobContext - all logs will be isolated`);

    return runInJobContext(jobId, async () => {
      // 🔧 BUG FIX (CRITICAL): Check job status BEFORE acquiring semaphore
      // This prevents zombie jobs from waiting 6-8 minutes on semaphore before discovering they're already done
      jobLog(`🔍 [PRE_SEMAPHORE_CHECK] Checking if job ${jobId.substring(0, 8)} is already completed/failed...`);

      const existingJob = await this.getJobStatus(jobId);

      // Skip jobs that are already completed, failed, or cancelled
      if (existingJob && (existingJob.status === 'completed' || existingJob.status === 'failed')) {
        jobLog(`✅ [PRE_SEMAPHORE_SKIP] Job ${jobId.substring(0, 8)} already ${existingJob.status}, acknowledging and skipping (NO semaphore wait)`);
        await this.redis.xack(STREAM, GROUP, messageId);
        return;
      }

      if (existingJob?.cancelRequested) {
        jobLog(`⚠️  [PRE_SEMAPHORE_SKIP] Job ${jobId.substring(0, 8)} has cancel request, acknowledging and skipping (NO semaphore wait)`);
        await this.redis.xack(STREAM, GROUP, messageId);
        return;
      }

      // 🔧 [CONCURRENCY_CONTROL] Acquire semaphore slot before processing
      jobLog(`🔧 [PROCESS_JOB_START] Job ${jobId.substring(0, 8)} starting, acquiring slot...`);

      let slotAcquired = false;
      try {
        await this.acquireJobSlot();
        slotAcquired = true;
        jobLog(`✅ [PROCESS_JOB_SLOT_ACQUIRED] Job ${jobId.substring(0, 8)} has slot, proceeding...`);
      } catch (error) {
        console.error(`❌ [PROCESS_JOB_ACQUIRE_FAILED] Failed to acquire slot for job ${jobId}:`, error);
        throw new Error(`[PROCESS_JOB_ACQUIRE_FAILED] Semaphore acquire failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        jobLog(`⚙️  [${messageId}] Processing job ${jobId}: ${address}`);

        // 🔧 PHASE 5 FIX: Acquire distributed lock to prevent concurrent processing
        const lockKey = `lock:job:${jobId}`;
        const lockValue = `${CONSUMER}:${randomUUID()}`;
        const lockTTL = 300; // 5 minutes - auto-release if worker crashes

        console.log('🔧 PHASE 5: Attempting distributed lock acquisition');
        console.log(`   Lock prevents multiple workers from processing same job`);

        const lockAcquired = await this.redis.acquireLock(lockKey, lockValue, lockTTL);

        if (!lockAcquired) {
          jobLog(`⚠️  [${messageId}] Job ${jobId} is locked by another worker, skipping`);
          console.log('🔧 PHASE 5: Lock acquisition FAILED - another worker is processing this job');
          console.log('   This is EXPECTED behavior - prevents duplicate processing');
          return;
        }

        console.log('🔧 PHASE 5: Lock acquisition SUCCEEDED - we have exclusive access');
        console.log(`   Lock will auto-expire in ${lockTTL}s if we crash`);

        // Declare heartbeat before try block so it's accessible in catch/finally
        let heartbeat: NodeJS.Timeout | null = null;

        try {
          // ALL PROCESSING CODE INSIDE TRY BLOCK

    // Check if job is already being processed (use message ID for same-consumer detection)
    console.log('📊 STEP 1: Checking existing job status in Redis');
    console.log(`   Looking for key: job:${jobId}`);
    const existingJob = await this.getJobStatus(jobId);
    console.log(`   Existing job found: ${!!existingJob}`);
    if (existingJob) {
      console.log(`   Status: ${existingJob.status}`);
      console.log(`   Progress: ${existingJob.progress}%`);
      console.log(`   Processing by: ${existingJob.processingBy || 'none'}`);
      console.log(`   Processing message ID: ${existingJob.processingMessageId || 'none'}`);
    }

    // Skip jobs that are already completed or failed
    if (existingJob && (existingJob.status === 'completed' || existingJob.status === 'failed')) {
      jobLog(`✅ [${messageId}] Job ${jobId} already ${existingJob.status}, acknowledging and skipping`);
      console.log('📊 STEP 1 RESULT: Job already terminal, acknowledging and exiting');
      await this.redis.xack(STREAM, GROUP, messageId);
      return;
    }

    if (existingJob && existingJob.status === 'processing') {
      console.log('📊 STEP 2: Job is currently processing, checking heartbeat');
      jobLog(`🔍 [${messageId}] Job ${jobId} status=${existingJob.status}, messageId=${existingJob.processingMessageId || 'none'}`);

      // ALWAYS check heartbeat when job is processing (even if same message ID - handles XAUTOCLAIM reclaims)
      const timeSinceHeartbeat = Date.now() - (existingJob.lastHeartbeat || 0);
      console.log(`   Last heartbeat: ${existingJob.lastHeartbeat}`);
      console.log(`   Current time: ${Date.now()}`);
      console.log(`   Time since heartbeat: ${timeSinceHeartbeat}ms (${Math.round(timeSinceHeartbeat / 1000)}s)`);
      console.log(`   Heartbeat threshold: 60000ms (60s)`);
      jobLog(`🔍 [${messageId}] Heartbeat age: ${Math.round(timeSinceHeartbeat / 1000)}s`);

      if (timeSinceHeartbeat < 60000) { // If heartbeat within last 60 seconds, job is still active
        console.log('📊 STEP 2 RESULT: Heartbeat is fresh, job still active');
        console.log('   ACTION: Acknowledging message and skipping (another worker is processing)');
        console.warn(`⚠️  [${messageId}] Job ${jobId} still active (heartbeat ${Math.round(timeSinceHeartbeat / 1000)}s ago), skipping XAUTOCLAIM reclaim`);
        await this.redis.xack(STREAM, GROUP, messageId); // Acknowledge to prevent re-processing
        return;
      }
      console.log('📊 STEP 2 RESULT: Heartbeat is stale, taking over job');
      console.log('   Previous worker likely crashed or is stuck');
      jobLog(`⏰ [${messageId}] Job ${jobId} heartbeat stale (${Math.round(timeSinceHeartbeat / 1000)}s), taking over`);
    } else {
      console.log('📊 STEP 2: Job not currently processing (may be new or queued)');
      console.log(`   Status: ${existingJob?.status || 'none'}`);
      jobLog(`🔍 [${messageId}] Job ${jobId} not currently processing (status: ${existingJob?.status || 'none'})`);
    }

    // Update status to processing and claim ownership with message ID
    console.log('📊 STEP 3: Claiming ownership of job');
    console.log(`   Setting processingBy: ${CONSUMER}`);
    console.log(`   Setting processingMessageId: ${messageId}`);
    console.log(`   Setting status: processing`);
    console.log(`   Setting initial progress: 10%`);
    jobLog(`📝 [${messageId}] Claiming ownership of job ${jobId}`);
    await this.updateJob(jobId, {
      status: 'processing',
      phase: 'Getting subject details',
      progress: 10,
      processingBy: CONSUMER,
      processingMessageId: messageId
    });
    console.log('✅ STEP 3 COMPLETE: Ownership claimed in Redis');

    // Set global job context for progress updates
    console.log('📊 STEP 4: Setting global job context for progress updates');
    setCurrentJobContext({ jobId, jobQueue: this });
    console.log('✅ STEP 4 COMPLETE: Global job context set');

    // Start heartbeat
    console.log('📊 STEP 5: Starting heartbeat interval');
    console.log(`   Heartbeat interval: ${HEARTBEAT_MS}ms (${HEARTBEAT_MS / 1000}s)`);
    console.log('   Heartbeat will update lastHeartbeat timestamp in Redis every 7s');
    heartbeat = setInterval(async () => {
      const now = Date.now();
      console.log(`💓 HEARTBEAT: Updating lastHeartbeat to ${now}`);
      await this.updateJob(jobId, { lastHeartbeat: now });
      console.log(`💓 HEARTBEAT: Update complete`);
    }, HEARTBEAT_MS);
    console.log('✅ STEP 5 COMPLETE: Heartbeat started');

      // **FAST-FAIL: Early geocode validation**
      // Validate address can be geocoded before running expensive Vertex searches
      // Invalid addresses like "333" will fail here in ~10s instead of ~4 minutes
      console.log('📊 STEP 6: Geocode validation (FAST-FAIL check)');
      console.log(`   Address to validate: ${address}`);
      console.log('   This validates address BEFORE expensive Vertex API calls');
      jobLog(`🗺️  [${messageId}] Validating address via geocoding: ${address}`);
      const geocodeStart = Date.now();

      // Use GoogleMapsGeocoder for address validation (works with both V5 and V10)
      try {
        const geocoder = new GoogleMapsGeocoder();
        const result = await geocoder.geocodeAddress(address);
        const geocodeDuration = Date.now() - geocodeStart;

        if (!result || !result.lat || !result.lng) {
          console.error(`❌ [${messageId}] Address geocoding failed in ${geocodeDuration}ms - invalid address`);
          throw new Error(`Invalid address: could not geocode "${address}"`);
        }

        console.log(`✅ STEP 6 COMPLETE: Geocoding successful in ${geocodeDuration}ms`);
        console.log(`   Latitude: ${result.lat}`);
        console.log(`   Longitude: ${result.lng}`);
        jobLog(`✅ [${messageId}] Address validated via geocoding in ${geocodeDuration}ms: ${result.lat}, ${result.lng}`);
      } catch (error) {
        const geocodeDuration = Date.now() - geocodeStart;
        console.error(`❌ STEP 6 FAILED: Geocoding failed in ${geocodeDuration}ms`);
        console.error(`❌ [${messageId}] Geocoder initialization or geocoding failed in ${geocodeDuration}ms:`);
        console.error(`   Error type: ${typeof error}`);
        console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
        console.error('   This job will FAIL without calling Vertex API (FAST-FAIL)');
        throw new Error(`Invalid address: could not geocode "${address}"${error instanceof Error ? ` - ${error.message}` : ''}`);
      }

      // Run analysis
      console.log('📊 STEP 7: Running comprehensive comparable search');
      console.log('   This will call Vertex API and find comparable properties');
      console.log('   Expected duration: 30-120 seconds depending on cache hits');
      const result = await this.analysisService.findComparables(address);
      console.log('✅ STEP 7 COMPLETE: Comparable search finished');
      console.log(`   ARV: $${result.arv?.estimate || (result.arv as any)?.conservative?.arv_price || 0}`);
      console.log(`   Qualified comps: ${result.qualified_comps?.length || 0}`);

      // Mark complete
      console.log('📊 STEP 8: Marking job as completed in Redis');
      console.log('   Setting status: completed');
      console.log('   Setting progress: 100%');
      console.log('   Storing result data (subject, ARV, comps, etc.)');
      await this.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        phase: 'Complete',
        result: {
          subject: result.subject,
          arv: result.arv,
          twoBathArv: result.twoBathARV,
          bathroomAnalysis: result.bathroomAnalysis,
          renovationAnalysis: result.renovation_analysis,
          compsUsed: result.qualified_comps,
          allComps: result.all_comps,
          confidenceScores: Object.fromEntries(result.consistency_scores.entries()),
          searchMetadata: result.searchMetadata
        },
        completedAt: Date.now()
      });
      console.log('✅ STEP 8 COMPLETE: Job marked as completed in Redis');

      // Acknowledge message
      console.log('📊 STEP 9: Acknowledging message in Redis Streams');
      console.log(`   Stream: ${STREAM}`);
      console.log(`   Group: ${GROUP}`);
      console.log(`   Message ID: ${messageId}`);
      await this.redis.xack(STREAM, GROUP, messageId);
      console.log('✅ STEP 9 COMPLETE: Message acknowledged (removed from pending)');

      console.log('📊 STEP 10: Cleanup - stopping heartbeat and clearing context');
      clearInterval(heartbeat);
      console.log('   Heartbeat interval cleared');
      setCurrentJobContext(null); // Clear job context
      console.log('   Global job context cleared');
      // 🔧 PHASE 3: No need to call setJobContext(null) - runInJobContext auto-cleans
      console.log('✅ STEP 10 COMPLETE: Cleanup finished');
      jobLog(`✅ Job ${jobId} completed`);

      // Validate ARV before sending success notification
      console.log('📊 STEP 11: Validating ARV result');
      const completedAt = Date.now();
      const duration = completedAt - (existingJob?.createdAt || Date.now());
      console.log(`   Job duration: ${duration}ms (${Math.round(duration / 1000)}s)`);

      // Handle both V10 (result.arv?.estimate) and V5 (result.arv?.conservative?.arv_price) structures
      const arvValue = result.arv?.estimate || (result.arv as any)?.conservative?.arv_price;
      const compsCount = result.qualified_comps?.length || 0;
      console.log(`   ARV value: $${arvValue || 0}`);
      console.log(`   Comps count: ${compsCount}`);

      // ARV=$0 or 0 comps is a failed run, not a success
      if (!arvValue || arvValue === 0 || compsCount === 0) {
        console.error('❌ STEP 11 VALIDATION FAILED: Invalid ARV or no comps');
        const errorMessage = !arvValue || arvValue === 0
          ? `ARV unavailable (ARV=$${arvValue || 0}, comps=${compsCount})`
          : `No comparable properties found (comps=${compsCount})`;
        console.error(`   Error: ${errorMessage}`);
        console.error('   Job will be marked as FAILED despite completing');
        console.error(`❌ Job ${jobId} completed but failed validation: ${errorMessage}`);

        // Send error notification instead of success
        await sendErrorNotification({
          jobId,
          address,
          error: errorMessage,
          phase: 'ARV Calculation',
          attempts: 1,
          timestamp: completedAt,
          userId: existingJob?.userId
        });

        // Mark job as failed
        await this.updateJob(jobId, {
          status: 'failed',
          error: errorMessage,
          completedAt
        });

        // Acknowledge message to remove from queue
        await this.redis.xack(STREAM, GROUP, messageId);
        clearInterval(heartbeat);
        setCurrentJobContext(null);
        // 🔧 PHASE 3: No need to call setJobContext(null) - runInJobContext auto-cleans
        return;
      }

      // Send success notification email
      await sendSuccessNotification({
        jobId,
        address,
        arv: arvValue,
        compsCount,
        duration,
        timestamp: completedAt,
        userId: existingJob?.userId
      });

        } catch (error: any) {
          if (heartbeat) clearInterval(heartbeat);
          setCurrentJobContext(null); // Clear job context
          // 🔧 PHASE 3: No need to call setJobContext(null) - runInJobContext auto-cleans
          throw error;
        } finally {
          // 🔧 PHASE 5: Always release the lock, even if job failed
          console.log('🔧 PHASE 5: FINALLY block - releasing distributed lock');
          console.log(`   Lock Key: ${lockKey}`);
          console.log(`   Lock Value: ${lockValue}`);

          const lockReleased = await this.redis.releaseLock(lockKey, lockValue);

          if (lockReleased) {
            console.log('✅ PHASE 5: Lock released successfully');
            console.log('   Other workers can now process this job if needed');
          } else {
            console.log('⚠️  PHASE 5: Lock release returned false');
            console.log('   Lock may have already expired (TTL reached) or was never acquired');
          }
        } // End of inner finally block (lock release)
      } catch (error: any) {
        console.error(`❌ [PROCESS_JOB_FAILED] Job ${jobId.substring(0, 8)} failed:`, error);
        console.error(`   Error type: ${error?.constructor?.name || 'unknown'}`);
        console.error(`   Error message: ${error?.message || String(error)}`);
        console.error(`   Slot acquired: ${slotAcquired}`);
        throw error;
      } finally {
        // 🔧 [CONCURRENCY_CONTROL] Always release semaphore slot
        if (slotAcquired) {
          jobLog(`🔧 [PROCESS_JOB_FINALLY] Releasing slot for job ${jobId.substring(0, 8)}...`);
          try {
            this.releaseJobSlot();
            jobLog(`✅ [PROCESS_JOB_SLOT_RELEASED] Slot released successfully`);
          } catch (error) {
            console.error(`❌ [PROCESS_JOB_RELEASE_FAILED] Failed to release slot:`, error);
            // Don't throw - already in finally block
          }
        } else {
          jobLog(`⚠️  [PROCESS_JOB_FINALLY] No slot to release (acquire failed or not reached)`);
        }
      } // End of outer finally block (semaphore release)
    }); // End of runInJobContext wrapper - closes async arrow function
  } // End of processJob method

  /**
   * Handle job failure with retry logic
   */
  private async handleJobFailure(jobId: string, error: any, messageId: string): Promise<void> {
    const job = await this.getJobStatus(jobId);
    if (!job) {
      await this.redis.xack(STREAM, GROUP, messageId);
      return;
    }

    const attempts = (job.attempts || 0) + 1;
    const errorMessage = error?.message || String(error);

    console.error(`❌ Job ${jobId} failed (attempt ${attempts}/${MAX_ATTEMPTS}):`, errorMessage);

    if (attempts >= MAX_ATTEMPTS) {
      // Max retries reached - mark as failed and move to DLQ
      await this.updateJob(jobId, {
        status: 'failed',
        error: errorMessage,
        attempts,
        completedAt: Date.now()
      });

      // Add to dead letter queue
      await this.redis.xadd(`${ENV_PREFIX}jobs:dlq`, {
        jobId,
        address: job.address,
        error: errorMessage,
        attempts: attempts.toString(),
        failedAt: Date.now().toString()
      });

      // Send error notification email
      await sendErrorNotification({
        jobId,
        address: job.address,
        error: errorMessage,
        phase: job.phase,
        attempts,
        timestamp: Date.now(),
        userId: job.userId
      });

      // Acknowledge to remove from processing
      await this.redis.xack(STREAM, GROUP, messageId);
      jobLog(`💀 Job ${jobId} moved to DLQ after ${attempts} attempts`);
    } else {
      // Instant retry - acknowledge current message and re-add to stream immediately
      await this.updateJob(jobId, {
        status: 'queued',
        attempts,
        error: errorMessage,
        processingBy: undefined,
        processingMessageId: undefined
      });

      // ACK the current message
      await this.redis.xack(STREAM, GROUP, messageId);

      // Immediately re-add to stream for instant retry (don't wait for XAUTOCLAIM)
      await this.redis.xadd(STREAM, {
        jobId,
        address: job.address,
        userId: job.userId || '',
        attempts: attempts.toString(),
        createdAt: Date.now().toString()
      });

      jobLog(`🔄 Job ${jobId} retried immediately (attempt ${attempts}/${MAX_ATTEMPTS})`);
    }
  }

  /**
   * Start background reaper to reclaim stuck jobs
   */
  private startReaper(): void {
    this.reclaimInterval = setInterval(async () => {
      try {
        let cursor = '0-0';
        do {
          const [nextCursor, claimed] = await this.redis.xautoclaim(
            STREAM,
            GROUP,
            CONSUMER,
            MIN_IDLE_MS,
            cursor,
            50
          );

          cursor = nextCursor;

          if (claimed && claimed.length > 0) {
            jobLog(`♻️  Reclaimed ${claimed.length} stuck jobs`);

            for (const message of claimed) {
              if (!Array.isArray(message) || message.length < 2) {
                continue;
              }

              const [messageId, fields] = message;
              const jobData = this.parseStreamMessage(fields);

              if (jobData && jobData.jobId) {
                // 🔧 BUG FIX: Skip if this job is already being processed (PEL deduplication in reaper)
                if (this.processingJobIds.has(jobData.jobId)) {
                  jobLog(`⚠️  [REAPER] Job ${jobData.jobId.substring(0, 8)} already being processed, skipping reclaimed PEL entry`);
                  await this.redis.xack(STREAM, GROUP, messageId);
                  continue;
                }

                // Check if job has exceeded max attempts
                const job = await this.getJobStatus(jobData.jobId);
                if (job && (job.attempts || 0) >= MAX_ATTEMPTS) {
                  console.warn(`⚠️  Job ${jobData.jobId} exceeded max attempts (${job.attempts}), moving to DLQ`);
                  await this.handleJobFailure(jobData.jobId, new Error('Max reclaim attempts exceeded'), messageId);
                  continue;
                }

                // Mark as processing
                this.processingJobIds.set(jobData.jobId, true);

                try {
                  await this.processJob(jobData.jobId, jobData.address, messageId);
                } catch (error: any) {
                  await this.handleJobFailure(jobData.jobId, error, messageId);
                } finally {
                  // Clean up tracking map
                  this.processingJobIds.delete(jobData.jobId);
                }
              }
            }
          }
        } while (cursor !== '0-0');
      } catch (error) {
        console.error('❌ Reaper error:', error);
      }
    }, 15000); // Run every 15 seconds
  }

  /**
   * Wake up worker by making HTTP call to /wake endpoint
   * This triggers Cloud Run to scale up from zero if needed
   */
  private async wakeWorker(): Promise<void> {
    const workerUrl = process.env.IS_STAGING === 'true'
      ? process.env.WORKER_URL_STAGING
      : process.env.WORKER_URL_PROD;

    if (!workerUrl) {
      // Not configured - skip wake call (useful for local development)
      return;
    }

    try {
      const response = await fetch(`${workerUrl}/wake`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (response.ok) {
        jobLog(`👋 Wake call sent to worker: ${response.status}`);
      } else {
        jobLog(`⚠️  Wake call returned non-OK status: ${response.status}`);
      }
    } catch (error: any) {
      // Re-throw to be caught by enqueueJob's catch block
      throw new Error(`Wake call failed: ${error.message}`);
    }
  }

  /**
   * Stop processing (graceful shutdown)
   */
  async stop(): Promise<void> {
    jobLog('🛑 Stopping worker...');
    this.isProcessing = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.reclaimInterval) {
      clearInterval(this.reclaimInterval);
    }

    jobLog('✅ Worker stopped');
  }
}

// Singleton instance
let jobQueueInstance: JobQueue | null = null;

export function getJobQueue(): JobQueue {
  if (!jobQueueInstance) {
    jobQueueInstance = new JobQueue();
  }
  return jobQueueInstance;
}
