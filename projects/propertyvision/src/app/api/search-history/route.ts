import { NextRequest, NextResponse } from 'next/server';
import { SearchHistoryService } from '../../../services/searchHistory';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const status = url.searchParams.get('status') as 'all' | 'completed' | 'failed' | null;
    const limit = url.searchParams.get('limit');

    if (!userId) {
      return NextResponse.json(
        { error: 'userId is required' },
        { status: 400 }
      );
    }

    const filters = {
      status: status || 'all',
      limit: limit ? parseInt(limit) : 20
    };

    const searchHistory = await SearchHistoryService.getUserSearchHistory(userId, filters);

    return NextResponse.json({ searches: searchHistory });
  } catch (error: any) {
    console.error('❌ Failed to fetch search history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch search history', details: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, address } = body;

    if (!userId || !address) {
      return NextResponse.json(
        { error: 'userId and address are required' },
        { status: 400 }
      );
    }

    const searchId = await SearchHistoryService.createSearch(userId, address);

    return NextResponse.json({ searchId });
  } catch (error: any) {
    console.error('❌ Failed to create search record:', error);
    return NextResponse.json(
      { error: 'Failed to create search record', details: error.message },
      { status: 500 }
    );
  }
}