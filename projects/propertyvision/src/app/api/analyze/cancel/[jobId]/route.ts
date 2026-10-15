import { NextRequest, NextResponse } from 'next/server';
import { getJobQueue } from '../../../../../server/utils/jobQueue';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function POST(
  _request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  try {
    const jobQueue = getJobQueue();
    const cancelled = await jobQueue.cancelJob(params.jobId);

    if (!cancelled) {
      return NextResponse.json(
        { error: 'Job not found or already completed' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      jobId: params.jobId,
      cancelled: true,
      message: 'Cancellation requested'
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to cancel job', details: error.message },
      { status: 500 }
    );
  }
}
