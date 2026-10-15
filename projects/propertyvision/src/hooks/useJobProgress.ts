import { useState, useEffect, useMemo } from 'react';

interface JobStatus {
  status: string;
  progress: number;
  phase?: string;
  phaseMessage?: string;
  estimatedTimeRemaining?: number;
  phaseStartTime?: number;
  serverNow?: number;
}

// Phase progression map for smooth interpolation (V10 parallel search)
const PHASE_NEXT_PROGRESS: Record<number, number> = {
  0: 10,    // QUEUED → SUBJECT_PROPERTY
  10: 30,   // SUBJECT_PROPERTY → COMPARABLE_SEARCH_L1 (parallel levels launch)
  30: 60,   // All 4 levels running in parallel
  60: 75,   // DEDUPLICATION
  75: 90,   // ARV_CALCULATION
  90: 97,   // FINALIZING
  97: 100   // COMPLETED
};

/**
 * Hook for real-time countdown with clock-skew correction
 */
export function useCountdown(jobStatus?: JobStatus) {
  const [countdown, setCountdown] = useState(0);

  // Calculate clock drift once per status update
  const driftMs = useMemo(() => {
    return jobStatus?.serverNow ? Date.now() - jobStatus.serverNow : 0;
  }, [jobStatus?.serverNow]);

  useEffect(() => {
    if (!jobStatus?.phaseStartTime || !jobStatus?.estimatedTimeRemaining) {
      setCountdown(0);
      return;
    }

    const updateCountdown = () => {
      // Use server-synced time to avoid clock-skew
      const now = Date.now() - driftMs;
      const elapsed = (now - jobStatus.phaseStartTime!) / 1000;
      const remaining = Math.max(0, jobStatus.estimatedTimeRemaining! - elapsed);

      // Clamp to minimum 1 second until phase actually changes
      // This prevents "0 seconds" showing while phase is still running
      const clamped = jobStatus.status === 'processing' && remaining > 0
        ? Math.max(1, Math.ceil(remaining))
        : Math.ceil(remaining);

      setCountdown(clamped);
    };

    // Update immediately
    updateCountdown();

    // Update every second
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [jobStatus?.phaseStartTime, jobStatus?.estimatedTimeRemaining, jobStatus?.status, driftMs]);

  return countdown;
}

/**
 * Hook for smooth progress interpolation
 * Progress bar smoothly animates from current phase to next milestone
 */
export function useInterpolatedProgress(jobStatus?: JobStatus) {
  const baseProgress = jobStatus?.progress ?? 0;
  const nextProgress = PHASE_NEXT_PROGRESS[baseProgress] ?? baseProgress;
  const estimatedSeconds = jobStatus?.estimatedTimeRemaining ?? 0;
  const phaseStartTime = jobStatus?.phaseStartTime;
  const serverNow = jobStatus?.serverNow;

  const [smoothProgress, setSmoothProgress] = useState(baseProgress);

  // Calculate clock drift
  const driftMs = useMemo(() => {
    return serverNow ? Date.now() - serverNow : 0;
  }, [serverNow]);

  useEffect(() => {
    // If no phase timing info, just use base progress
    if (!phaseStartTime || !estimatedSeconds) {
      setSmoothProgress(baseProgress);
      return;
    }

    let rafId = 0;

    const update = () => {
      // Use server-synced time
      const now = Date.now() - driftMs;
      const elapsed = (now - phaseStartTime) / 1000;

      // Calculate fraction of phase completed (0 to 1)
      const fraction = Math.min(1, Math.max(0, elapsed / estimatedSeconds));

      // Interpolate between base and next progress
      // Never let it reach the next milestone until phase actually changes
      const maxProgress = nextProgress - 0.5; // Stop just before next milestone
      const interpolated = baseProgress + (maxProgress - baseProgress) * fraction;

      setSmoothProgress(interpolated);

      // Continue animating
      rafId = requestAnimationFrame(update);
    };

    // Start animation
    rafId = requestAnimationFrame(update);

    return () => cancelAnimationFrame(rafId);
  }, [baseProgress, nextProgress, estimatedSeconds, phaseStartTime, driftMs]);

  // Round to whole number for display
  return Math.round(smoothProgress);
}

/**
 * Hook to check if phase is taking longer than usual
 * Useful for showing "taking longer than expected" messages
 */
export function useIsSlowPhase(jobStatus?: JobStatus, p90Threshold?: number) {
  const [isSlow, setIsSlow] = useState(false);

  const driftMs = useMemo(() => {
    return jobStatus?.serverNow ? Date.now() - jobStatus.serverNow : 0;
  }, [jobStatus?.serverNow]);

  useEffect(() => {
    if (!jobStatus?.phaseStartTime || !p90Threshold) {
      setIsSlow(false);
      return;
    }

    const checkIfSlow = () => {
      const now = Date.now() - driftMs;
      const elapsed = (now - jobStatus.phaseStartTime!) / 1000;
      setIsSlow(elapsed > p90Threshold);
    };

    checkIfSlow();
    const interval = setInterval(checkIfSlow, 2000); // Check every 2 seconds

    return () => clearInterval(interval);
  }, [jobStatus?.phaseStartTime, p90Threshold, driftMs]);

  return isSlow;
}
