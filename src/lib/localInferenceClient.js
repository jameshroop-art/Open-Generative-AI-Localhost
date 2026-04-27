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
