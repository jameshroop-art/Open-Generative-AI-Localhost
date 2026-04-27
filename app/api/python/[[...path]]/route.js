import { NextResponse } from 'next/server';

// The Python sidecar always binds to 127.0.0.1 on this port.
// PYTHON_SERVER_PORT can be overridden via environment variable when running
// the Next.js dev server independently (without Electron).
const PYTHON_PORT = process.env.PYTHON_SERVER_PORT || '7861';
const PYTHON_BASE = `http://127.0.0.1:${PYTHON_PORT}`;

async function proxy(request, params, method) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const targetPath = pathSegments.join('/');
    const { search } = new URL(request.url);
    const targetUrl = `${PYTHON_BASE}/${targetPath}${search}`;

    try {
        const opts = {
            method,
            headers: { 'content-type': request.headers.get('content-type') || 'application/json' },
        };
        if (method !== 'GET' && method !== 'HEAD') {
            opts.body = await request.arrayBuffer();
        }
        const response = await fetch(targetUrl, opts);
        const data = await response.json();
        return NextResponse.json(data, { status: response.status });
    } catch (err) {
        return NextResponse.json(
            { error: `Python sidecar unavailable: ${err.message}` },
            { status: 503 },
        );
    }
}

export const GET    = (req, { params }) => proxy(req, params, 'GET');
export const POST   = (req, { params }) => proxy(req, params, 'POST');
export const PUT    = (req, { params }) => proxy(req, params, 'PUT');
export const DELETE = (req, { params }) => proxy(req, params, 'DELETE');
