import { NextResponse } from 'next/server';

export function middleware(request) {
    // All /api/* paths are handled by the dedicated Next.js route handlers in
    // app/api/. No direct rewrites to external hosts — all outbound traffic
    // goes through those local proxy routes, not from middleware.
    return NextResponse.next();
}

// Keep the matcher so Next.js still invokes middleware for these paths,
// allowing future middleware logic if needed.
export const config = {
    matcher: [
        '/api/workflow/:path*', 
        '/api/app/:path*',
        '/api/v1/:path*'
    ],
};
