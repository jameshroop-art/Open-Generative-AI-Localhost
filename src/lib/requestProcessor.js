/**
 * requestProcessor.js — auto_approve=NO_DENIAL processing framework.
 *
 * Every generation request is tagged with auto_approve:true and is NEVER
 * hard-rejected. Instead of throwing a denial error, the processor:
 *
 *   1. Tries the explicitly requested path (local or cloud).
 *   2. Falls back to the other path if the first is unavailable.
 *   3. Queues the request in localStorage if neither path is ready yet,
 *      and replays the queue whenever the app is ready.
 *
 * Consumers replace direct muapi/localAI calls with:
 *
 *   import { processor } from './requestProcessor.js';
 *   const result = await processor.submit({ type: 'image', ...params });
 *
 * Queue consumers (e.g. on app boot) call:
 *   processor.drainQueue();
 */

import { muapi } from './muapi.js';
import { localAI, isLocalAIAvailable } from './localInferenceClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const QUEUE_KEY = 'no_denial_request_queue';
const MAX_QUEUE = 100;

// ── Status values (informational — never "denied") ───────────────────────────
export const STATUS = Object.freeze({
    PROCESSING : 'processing',
    QUEUED     : 'queued',
    COMPLETED  : 'completed',
    RETRYING   : 'retrying',
    ERROR      : 'error',    // terminal after all fallbacks exhausted — not "denied"
});

// ── Internal helpers ──────────────────────────────────────────────────────────

function loadQueue() {
    try {
        return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveQueue(queue) {
    try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(0, MAX_QUEUE)));
    } catch { /* storage full — keep going */ }
}

function makeId() {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Attach the framework tag to every outbound request payload. */
function tag(params) {
    return { ...params, auto_approve: true, _no_denial: true };
}

// ── Path executors ────────────────────────────────────────────────────────────

async function runLocal(type, params) {
    if (!isLocalAIAvailable()) {
        throw new Error('Local AI not available in this environment.');
    }
    // Local path only supports image generation; other types will throw
    // and trigger cloud fallback.
    if (type !== 'image') {
        throw new Error(`Local inference does not support type="${type}".`);
    }
    return localAI.generate(tag(params));
}

async function runCloud(type, params) {
    const tagged = tag(params);
    switch (type) {
        case 'image'   : return muapi.generateImage(tagged);
        case 'i2i'     : return muapi.generateI2I(tagged);
        case 'video'   : return muapi.generateVideo(tagged);
        case 'i2v'     : return muapi.generateI2V(tagged);
        case 'v2v'     : return muapi.processV2V(tagged);
        case 'lipsync' : return muapi.processLipSync(tagged);
        default        : throw new Error(`Unknown generation type: "${type}"`);
    }
}

// ── Core processor class ──────────────────────────────────────────────────────

class RequestProcessor {
    constructor() {
        // Optional progress / status callbacks registered by UI layers.
        this._statusListeners = new Set();
    }

    /**
     * Register a listener that receives status updates for every request.
     * @param {(event: {id, status, type, params, result?, error?}) => void} fn
     * @returns {() => void} unsubscribe function
     */
    onStatus(fn) {
        this._statusListeners.add(fn);
        return () => this._statusListeners.delete(fn);
    }

    _emit(event) {
        this._statusListeners.forEach(fn => {
            try { fn(event); } catch { /* listener errors must not kill the processor */ }
        });
    }

    /**
     * Submit a generation request.
     *
     * @param {Object}  options
     * @param {string}  options.type      - 'image'|'i2i'|'video'|'i2v'|'v2v'|'lipsync'
     * @param {boolean} [options.preferLocal=false] - prefer local model first
     * @param {*}       options.*          - all remaining keys forwarded as params
     * @returns {Promise<{url: string, seed?: number, [key: string]: any}>}
     */
    async submit({ type, preferLocal = false, ...params }) {
        const id = makeId();
        // auto_approve is always true — no request can be denied at this layer.
        const request = { id, type, preferLocal, params, auto_approve: true, _no_denial: true, submittedAt: Date.now() };

        this._emit({ id, status: STATUS.PROCESSING, type, params });

        const primaryFn   = preferLocal ? runLocal  : runCloud;
        const fallbackFn  = preferLocal ? runCloud  : runLocal;
        const primaryName = preferLocal ? 'local'   : 'cloud';
        const fallbackName= preferLocal ? 'cloud'   : 'local';

        // ── Primary attempt ───────────────────────────────────────────────────
        try {
            const result = await primaryFn(type, params);
            this._emit({ id, status: STATUS.COMPLETED, type, params, result });
            return result;
        } catch (primaryErr) {
            console.warn(`[RequestProcessor] ${primaryName} path failed for ${id}:`, primaryErr.message);
            this._emit({ id, status: STATUS.RETRYING, type, params, error: primaryErr });
        }

        // ── Fallback attempt ──────────────────────────────────────────────────
        try {
            const result = await fallbackFn(type, params);
            this._emit({ id, status: STATUS.COMPLETED, type, params, result });
            return result;
        } catch (fallbackErr) {
            console.warn(`[RequestProcessor] ${fallbackName} fallback also failed for ${id}:`, fallbackErr.message);
        }

        // ── Queue for later replay (no denial — keep trying) ──────────────────
        this._enqueue(request);
        this._emit({ id, status: STATUS.QUEUED, type, params });

        // Return a sentinel so the caller knows the job is queued, not lost.
        return { queued: true, id, type, auto_approve: true };
    }

    // ── Queue management ──────────────────────────────────────────────────────

    _enqueue(request) {
        const queue = loadQueue();
        // Deduplicate by request id
        if (!queue.find(r => r.id === request.id)) {
            queue.push(request);
            saveQueue(queue);
            console.log(`[RequestProcessor] queued ${request.id} (queue length: ${queue.length})`);
        }
    }

    _dequeue(id) {
        const queue = loadQueue().filter(r => r.id !== id);
        saveQueue(queue);
    }

    /**
     * Attempt to process all queued requests.
     * Safe to call on every app boot — failed items remain in the queue.
     * @param {(result: {id, url?, queued?}) => void} [onItemComplete]
     */
    async drainQueue(onItemComplete) {
        const queue = loadQueue();
        if (!queue.length) return;

        console.log(`[RequestProcessor] draining ${queue.length} queued request(s)…`);

        for (const request of queue) {
            const { id, type, params, preferLocal = false } = request;
            try {
                const primaryFn  = preferLocal ? runLocal  : runCloud;
                const fallbackFn = preferLocal ? runCloud  : runLocal;

                let result;
                try {
                    result = await primaryFn(type, params);
                } catch {
                    result = await fallbackFn(type, params);
                }

                this._dequeue(id);
                this._emit({ id, status: STATUS.COMPLETED, type, params, result });
                if (onItemComplete) onItemComplete({ id, ...result });

            } catch (err) {
                console.warn(`[RequestProcessor] queued item ${id} still failing:`, err.message);
                // Leave in queue — will be retried next time.
            }
        }
    }

    /** Return a snapshot of the current queue (read-only). */
    getQueue() {
        return loadQueue();
    }

    /** Number of queued requests waiting for replay. */
    get queueLength() {
        return loadQueue().length;
    }
}

// ── Singleton export ──────────────────────────────────────────────────────────
export const processor = new RequestProcessor();
