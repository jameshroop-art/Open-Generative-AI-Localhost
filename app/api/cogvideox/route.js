import { NextResponse } from 'next/server';
import path from 'path';

// Base directory for CogVideoX model folders.
// Resolved from: COGVIDEOX_DIR → MODELS_ROOT/CogVideoX → cwd/CogVideoX
const COGVIDEOX_ROOT = process.env.COGVIDEOX_DIR
    || (process.env.MODELS_ROOT ? path.join(process.env.MODELS_ROOT, 'CogVideoX') : null)
    || path.join(process.cwd(), 'CogVideoX');

// Python sidecar base URL (always localhost-only).
const PYTHON_SERVER = `http://127.0.0.1:${process.env.PYTHON_SERVER_PORT || 7861}`;

/**
 * POST /api/cogvideox
 *
 * Accepts a generation request from the UI, resolves the model path to an
 * absolute path on disk, then proxies the request to the Python sidecar's
 * /cogvideox/generate endpoint.
 *
 * Request JSON (all fields forwarded to Python, extra fields resolved here):
 *   model_id   str  — 'cogvideox-2b' | 'cogvideox-5b'  (resolved to abs path)
 *   model_path str  — absolute path override (takes precedence over model_id)
 *   prompt     str
 *   image      str  — base64 input image for I2V (optional)
 *   num_frames int
 *   steps      int
 *   guidance_scale float
 *   seed       int
 *   lora_path  str  — absolute path to a LoRA .safetensors file (optional)
 *   lora_weight float
 *   fps        int
 *
 * Response JSON:
 *   video  str  — base64-encoded MP4 video
 */
export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Resolve model_path from model_id if not already absolute
    if (!body.model_path && body.model_id) {
        const folderMap = {
            'cogvideox-2b': 'CogVideoX-2b',
            'cogvideox-5b': 'CogVideoX-5b',
        };
        const folder = folderMap[body.model_id] || body.model_id;
        body.model_path = path.join(COGVIDEOX_ROOT, folder);
    }

    if (!body.model_path) {
        return NextResponse.json(
            { error: 'model_path or model_id is required' },
            { status: 400 },
        );
    }

    try {
        const pyRes = await fetch(`${PYTHON_SERVER}/cogvideox/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const data = await pyRes.json();
        return NextResponse.json(data, { status: pyRes.status });
    } catch (err) {
        return NextResponse.json(
            { error: `Python sidecar unavailable: ${err.message}` },
            { status: 503 },
        );
    }
}
