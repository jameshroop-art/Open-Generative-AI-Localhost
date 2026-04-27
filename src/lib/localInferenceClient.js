// Frontend client for local inference — wraps window.localAI (Electron IPC).
// Falls back gracefully when running in browser/dev mode.

export const isLocalAIAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron;

class LocalInferenceClient {
    async getBinaryStatus() {
        if (!isLocalAIAvailable()) return { exists: false };
        return window.localAI.getBinaryStatus();
    }

    async downloadBinary() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadBinary();
    }

    async listModels() {
        if (!isLocalAIAvailable()) return [];
        return window.localAI.listModels();
    }

    /**
     * List all available local LoRA files from the on-disk lora/ directory.
     * Falls back to fetching /api/loras when not running in Electron.
     * @returns {Promise<{loras: Array, loraDir?: string}>}
     */
    async listLoras() {
        if (isLocalAIAvailable()) {
            return window.localAI.listLoras();
        }
        // Browser / Next.js dev mode — fetch from the API route
        try {
            const res = await fetch('/api/loras');
            return await res.json();
        } catch {
            return { loras: [] };
        }
    }

    async downloadModel(modelId) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadModel(modelId);
    }

    async downloadAuxiliary(auxKey) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadAuxiliary(auxKey);
    }

    async deleteModel(modelId) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.deleteModel(modelId);
    }

    /**
     * Generate an image locally using sd.cpp.
     * Returns { url: 'data:image/png;base64,...', seed }
     */
    async generate(params) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.generate(params);
    }

    cancelGeneration() {
        if (isLocalAIAvailable()) window.localAI.cancelGeneration();
    }

    /**
     * Generate a video locally using a CogVideoX model via the Python sidecar.
     * Works in both Electron and browser/dev-server mode.
     *
     * @param {Object} params
     * @param {string} params.model_id   - 'cogvideox-2b' | 'cogvideox-5b'
     * @param {string} params.prompt     - text prompt
     * @param {string} [params.image]    - base64-encoded input image (I2V)
     * @param {number} [params.steps]    - inference steps (default 50)
     * @param {number} [params.guidance_scale] - CFG scale (default 6.0)
     * @param {number} [params.seed]     - RNG seed
     * @param {string} [params.lora_path]   - absolute LoRA file path
     * @param {number} [params.lora_weight] - LoRA adapter weight (default 1.0)
     * @returns {Promise<{url: string}>} data:video/mp4;base64,... URL
     */
    async generateCogVideoX(params) {
        const response = await fetch('/api/cogvideox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`CogVideoX generation failed: ${response.status} - ${errText.slice(0, 200)}`);
        }

        const data = await response.json();
        if (data.error) throw new Error(`CogVideoX error: ${data.error}`);
        if (!data.video) throw new Error('No video returned from CogVideoX');

        return { url: `data:video/mp4;base64,${data.video}` };
    }

    /**
     * Subscribe to generation progress events.
     * @param {function} callback - ({ step, totalSteps, progress, status }) => void
     * @returns unsubscribe function
     */
    onProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onProgress(callback);
    }

    /**
     * Subscribe to download progress events.
     * @param {function} callback - ({ id, phase, progress }) => void
     * @returns unsubscribe function
     */
    onDownloadProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onDownloadProgress(callback);
    }
}

export const localAI = new LocalInferenceClient();
