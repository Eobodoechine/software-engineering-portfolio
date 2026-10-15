import { NextRequest, NextResponse } from 'next/server';
import { getJobQueue } from '../../../../../server/utils/jobQueue';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    console.log(`🔍 STATUS: Looking for job ${jobId}`);
    const jobQueue = getJobQueue();
    const job = await jobQueue.getJobStatus(jobId);
    console.log(`🔍 STATUS: Job ${jobId} result:`, job ? 'FOUND' : 'NOT FOUND');

    if (!job) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      );
    }

    // Calculate real-time countdown ETA
    let realTimeRemaining = job.estimatedTimeRemaining || 0;
    if (job.phaseStartTime && job.estimatedTimeRemaining) {
      const elapsedSeconds = Math.floor((Date.now() - job.phaseStartTime) / 1000);
      realTimeRemaining = Math.max(0, job.estimatedTimeRemaining - elapsedSeconds);
    }

    return NextResponse.json({
      jobId,
      status: job.status,
      progress: job.progress,
      phase: job.phase,
      phaseMessage: job.phaseMessage,
      estimatedTimeRemaining: job.estimatedTimeRemaining, // Original estimate for client calculation
      phaseStartTime: job.phaseStartTime, // For client-side countdown
      serverNow: Date.now(), // For clock-skew correction
      cancelRequested: job.cancelRequested,
      result: job.result,
      error: job.error
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to get job status', details: error.message },
      { status: 500 }
    );
  }
}
