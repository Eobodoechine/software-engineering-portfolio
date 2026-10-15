import { NextResponse } from 'next/server';
import { getRedisCache } from '../../../../server/utils/redisCache';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Lets the bare site link open the newest finished report instead of an empty form.
export async function GET() {
  try {
    const redis = getRedisCache();
    await redis.ensureConnected();
    const jobId = await redis.get('latestReport');
    const valid = jobId && /^[0-9a-f-]{36}$/i.test(jobId) ? jobId : null;
    return NextResponse.json({ jobId: valid });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to read latest report', details: error.message },
      { status: 500 }
    );
  }
}
