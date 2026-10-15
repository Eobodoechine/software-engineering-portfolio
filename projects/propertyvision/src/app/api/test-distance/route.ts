import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    console.log('🧪 Distance test disabled - DistanceValidator removed');

    return NextResponse.json({
      success: false,
      message: 'Distance test disabled - DistanceValidator removed'
    });
  } catch (error: any) {
    console.error('❌ Distance test failed:', error);
    return NextResponse.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}