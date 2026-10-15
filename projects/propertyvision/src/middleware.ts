import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  if (process.env.PV_LOCAL_DEMO === 'true') {
    const path = request.nextUrl.pathname;
    if (!/^\/api\/(health|analyze|analyze\/latest|analyze\/(status|cancel)\/[0-9a-f-]{36})\/?$/i.test(path)) {
      return new NextResponse('Not found', { status: 404 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
