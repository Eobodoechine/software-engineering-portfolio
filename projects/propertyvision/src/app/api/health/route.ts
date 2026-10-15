import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    ok: true,
    time: new Date().toISOString(),
    service: 'PropertyVision1 API',
    version: '3.0'
  });
}