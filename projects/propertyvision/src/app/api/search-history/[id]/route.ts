import { NextRequest, NextResponse } from 'next/server';
import { SearchHistoryService } from '../../../../services/searchHistory';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const searchId = params.id;
    const search = await SearchHistoryService.getSearchById(searchId);

    if (!search) {
      return NextResponse.json(
        { error: 'Search not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ search });
  } catch (error: any) {
    console.error('❌ Failed to fetch search:', error);
    return NextResponse.json(
      { error: 'Failed to fetch search', details: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const searchId = params.id;
    const body = await request.json();
    const { status, result, error } = body;

    if (!status || !['completed', 'failed'].includes(status)) {
      return NextResponse.json(
        { error: 'Valid status (completed or failed) is required' },
        { status: 400 }
      );
    }

    await SearchHistoryService.updateSearchStatus(searchId, status, result, error);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('❌ Failed to update search status:', error);
    return NextResponse.json(
      { error: 'Failed to update search status', details: error.message },
      { status: 500 }
    );
  }
}