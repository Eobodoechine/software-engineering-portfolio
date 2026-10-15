import { NextResponse } from 'next/server';

// Operational cache diagnostics are not exposed in the public source package.
export async function GET() {
  return new NextResponse('Not found', { status: 404 });
}
