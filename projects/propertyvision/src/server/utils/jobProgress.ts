// Job progress tracking with zero dependencies to avoid circular imports
// Used by search classes to update progress without importing jobQueue

// Global job context - allows comprehensive-comp-search to update progress
// Initialized immediately to avoid Temporal Dead Zone issues during module imports
let currentJobContext: { jobId: string; jobQueue: any } | null = null;

// Phase definitions (re-exported from jobQueue for convenience)
export const PHASES = {
  QUEUED: { name: 'Queued', progress: 0, message: 'Waiting to start analysis...', estimatedSeconds: 5 },
  SUBJECT_PROPERTY: { name: 'Subject Property Research', progress: 10, message: 'Fetching property details from public records...', estimatedSeconds: 60 },
  COMPARABLE_SEARCH_L1: { name: 'Parallel Comparable Search', progress: 30, message: 'Running parallel comparable search (Levels 1-4)...', estimatedSeconds: 180 },
  COMPARABLE_SEARCH_L2: { name: 'Parallel Comparable Search', progress: 30, message: 'Running parallel comparable search (Levels 1-4)...', estimatedSeconds: 0 },
  COMPARABLE_SEARCH_L3: { name: 'Parallel Comparable Search', progress: 30, message: 'Running parallel comparable search (Levels 1-4)...', estimatedSeconds: 0 },
  COMPARABLE_SEARCH_L4: { name: 'Parallel Comparable Search', progress: 30, message: 'Running parallel comparable search (Levels 1-4)...', estimatedSeconds: 0 },
  DEDUPLICATION: { name: 'Deduplication', progress: 60, message: 'Removing duplicate listings...', estimatedSeconds: 40 },
  ARV_CALCULATION: { name: 'ARV Calculation', progress: 75, message: 'Calculating After Repair Value...', estimatedSeconds: 10 },
  FINALIZING: { name: 'Finalizing', progress: 90, message: 'Preparing your analysis report...', estimatedSeconds: 5 },
  COMPLETED: { name: 'Completed', progress: 100, message: 'Analysis complete! 🎉', estimatedSeconds: 0 }
} as const;

// Set the job context (called by jobQueue when processing a job)
export function setCurrentJobContext(context: { jobId: string; jobQueue: any } | null): void {
  currentJobContext = context;
}

// Helper function to update progress from anywhere (e.g., comprehensive-comp-search)
export async function updateJobProgress(phaseKey: keyof typeof PHASES): Promise<void> {
  if (!currentJobContext) return;
  await currentJobContext.jobQueue.updateProgress(currentJobContext.jobId, phaseKey);
}

// Helper function to check if job is cancelled
export async function isJobCancelled(): Promise<boolean> {
  if (!currentJobContext) return false;
  const job = await currentJobContext.jobQueue.getJobStatus(currentJobContext.jobId);
  return job?.cancelRequested === true;
}
