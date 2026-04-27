const { ipcMain, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const os = require('os');

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(app.getPath('userData'), 'local-ai');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const MODELS_DIR = path.join(DATA_DIR, 'models');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

// LoRA directory: env override → repo-root lora/ (dev) → app resources lora/ (packaged)
const LORA_DIR = process.env.LORA_DIR || (() => {
    const devPath = path.join(__dirname, '../../lora');
    if (fs.existsSync(devPath)) return devPath;
    return path.join(process.resourcesPath || __dirname, 'lora');
})();

for (const dir of [BIN_DIR, MODELS_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

const BINARY_NAME = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
const BINARY_PATH = path.join(BIN_DIR, BINARY_NAME);

// ─── State ────────────────────────────────────────────────────────────────────
let activeProcess = null;
const activeDownloads = new Map(); // modelId → request object

// ─── GitHub release asset matcher per platform ───────────────────────────────
// Asset names look like: sd-master-44cca3d-bin-Darwin-macOS-15.7.4-arm64.zip
// Returns a predicate that returns true when the asset name matches this platform.
function getBinaryAssetMatcher() {
    const { platform, arch } = process;
    if (platform === 'darwin') {
        const archToken = arch === 'arm64' ? 'arm64' : 'x86_64';
        return (name) => name.includes('Darwin') && name.includes(archToken);
    }
    if (platform === 'win32') {
        // Prefer avx2 (best balance); fall back to noavx
        return (name) => name.includes('win-avx2-x64') || name.includes('win-noavx-x64');
    }
    // Linux: prefer plain build over rocm/vulkan
    return (name) => name.includes('Linux') && name.includes('x86_64') && !name.includes('rocm') && !name.includes('vulkan');
}

// ─── Robust HTTPS download with redirect-following, range-resume, and retry ───
function downloadFile(url, destPath, onProgress) {
    const tmp = destPath + '.part';

    // Outer total so progress never goes backwards across retries/redirects
    let knownTotal = 0;

    const attempt = (requestUrl, redirectsLeft, retriesLeft) => new Promise((resolve, reject) => {
        // Resume from however many bytes are already on disk
        const alreadyDownloaded = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;

        const parsed = new URL(requestUrl);
        const mod = parsed.protocol === 'https:' ? https : http;

        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (compatible; open-generative-ai/1.0)',
            'Accept': '*/*',
            'Connection': 'keep-alive',
        };
        if (alreadyDownloaded > 0) reqHeaders['Range'] = `bytes=${alreadyDownloaded}-`;

        const req = mod.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders }, (res) => {
            const { statusCode, headers } = res;

            // Follow redirects
            if ([301, 302, 303, 307, 308].includes(statusCode)) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
                resolve(attempt(headers.location, redirectsLeft - 1, retriesLeft));
                return;
            }

            // 206 Partial Content (range accepted) or 200 OK (server ignored Range)
            if (statusCode !== 200 && statusCode !== 206) {
                res.resume();
                reject(new Error(`HTTP ${statusCode} from ${parsed.hostname}`));
                return;
            }

            // content-length on a 206 is the remaining bytes; on 200 it's the full file
            const chunkSize = parseInt(headers['content-length'] || '0', 10);
            if (statusCode === 200) {
                // Server ignored our Range header — restart the file
                if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
                knownTotal = chunkSize;
            } else {
                // 206: total = already downloaded + remaining
                knownTotal = alreadyDownloaded + chunkSize;
            }

            let received = alreadyDownloaded;
            const out = fs.createWriteStream(tmp, { flags: statusCode === 206 ? 'a' : 'w' });

            res.on('data', (chunk) => {
                received += chunk.length;
                if (knownTotal && onProgress) onProgress(received / knownTotal);
            });
            res.pipe(out);
            out.on('finish', () => { fs.renameSync(tmp, destPath); resolve(); });
            out.on('error', reject);
            res.on('error', reject);
        });

        req.on('error', (err) => {
            if (retriesLeft > 0) {
                console.warn(`[download] ${err.message} — retrying in 3s (${retriesLeft} left)`);
                setTimeout(() => resolve(attempt(requestUrl, redirectsLeft, retriesLeft - 1)), 3000);
            } else {
                reject(err);
            }
        });

        req.setTimeout(60000, () => req.destroy(new Error('Request timed out')));
    });

    return attempt(url, 10, 5);
}

// ─── Extract zip on each platform ────────────────────────────────────────────
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        let cmd, args;
        if (process.platform === 'win32') {
            cmd = 'powershell';
            args = ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`];
        } else {
            cmd = 'unzip';
            args = ['-o', zipPath, '-d', destDir];
        }
        execFile(cmd, args, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ─── Binary management ────────────────────────────────────────────────────────
// Recursively find a file by name under dir; returns full path or null.
function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        } else if (entry.name === name) {
            return full;
        }
    }
    return null;
}

async function getBinaryStatus() {
    const exists = fs.existsSync(BINARY_PATH);
    return { exists, path: BINARY_PATH };
}

// Metal-enabled binaries hosted on our own release (macOS arm64 only).
// Other platforms fall back to the stock leejet release.
const CUSTOM_BINARIES = {
    'darwin-arm64': 'https://github.com/Anil-matcha/Open-Generative-AI/releases/download/v1.0.3-binaries/sd-cli-metal-macos-arm64.zip',
};

async function downloadBinary(mainWindow) {
    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id: '__binary__', ...data });

    try {
        send({ phase: 'fetching-release', progress: 0 });

        const platformKey = `${process.platform}-${process.arch}`;
        const customUrl = CUSTOM_BINARIES[platformKey];

        let downloadUrl, zipName;

        if (customUrl) {
            downloadUrl = customUrl;
            zipName = path.basename(customUrl);
        } else {
            const releaseData = await new Promise((resolve, reject) => {
                https.get(
                    'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest',
                    { headers: { 'User-Agent': 'open-generative-ai' } },
                    (res) => {
                        let body = '';
                        res.on('data', (d) => { body += d; });
                        res.on('end', () => {
                            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                        });
                        res.on('error', reject);
                    }
                ).on('error', reject);
            });

            const matches = getBinaryAssetMatcher();
            const allZips = releaseData.assets?.filter(a => a.name.endsWith('.zip')) || [];
            const asset = allZips.find(a => matches(a.name));
            if (!asset) {
                const available = allZips.map(a => a.name).join(', ');
                throw new Error(`No binary found for this platform. Available: ${available}`);
            }
            downloadUrl = asset.browser_download_url;
            zipName = asset.name;
        }

        send({ phase: 'downloading', progress: 0 });
        const zipPath = path.join(BIN_DIR, zipName);
        await downloadFile(downloadUrl, zipPath, (p) => {
            send({ phase: 'downloading', progress: p });
        });

        send({ phase: 'extracting', progress: 0.95 });
        await extractZip(zipPath, BIN_DIR);
        fs.unlinkSync(zipPath);

        // The zip may extract into a subdirectory — find the binary wherever it landed
        const foundBinary = findFile(BIN_DIR, BINARY_NAME);
        if (!foundBinary) throw new Error(`Extracted archive but could not find "${BINARY_NAME}" inside ${BIN_DIR}`);

        // Move it to the expected root location if it's nested
        if (foundBinary !== BINARY_PATH) {
            fs.renameSync(foundBinary, BINARY_PATH);
        }

        // Make binary executable on Unix
        if (process.platform !== 'win32') {
            fs.chmodSync(BINARY_PATH, 0o755);
            // Also chmod the dylib so it can be loaded
            const dylib = findFile(BIN_DIR, 'libstable-diffusion.dylib');
            if (dylib) fs.chmodSync(dylib, 0o755);
        }

        // macOS: strip Gatekeeper quarantine so the downloaded binary can run
        if (process.platform === 'darwin') {
            await new Promise((res) => execFile('xattr', ['-cr', BIN_DIR], () => res()));
        }

        send({ phase: 'done', progress: 1 });
        return { ok: true };
    } catch (err) {
        send({ phase: 'error', error: err.message });
        throw err;
    }
}

// ─── Model management ─────────────────────────────────────────────────────────
function getModelState(model) {
    const filePath = path.join(MODELS_DIR, model.filename);
    const partPath = filePath + '.part';
    if (fs.existsSync(filePath)) return 'downloaded';
    if (fs.existsSync(partPath)) return 'partial';
    return 'not-downloaded';
}

function getAuxState(aux) {
    const filePath = path.join(MODELS_DIR, aux.filename);
    return fs.existsSync(filePath) ? 'downloaded' : 'not-downloaded';
}

async function listModels() {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const auxStatus = {
        llm: getAuxState(ZIMAGE_AUXILIARY.llm),
        vae: getAuxState(ZIMAGE_AUXILIARY.vae),
    };
    return LOCAL_MODEL_CATALOG.map(m => ({
        ...m,
        state: getModelState(m),
        path: path.join(MODELS_DIR, m.filename),
        ...(m.requiresAuxiliary ? { auxiliaryStatus: auxStatus } : {}),
    }));
}

async function downloadModel(modelId, mainWindow) {
    const { LOCAL_MODEL_CATALOG } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const destPath = path.join(MODELS_DIR, model.filename);
    if (fs.existsSync(destPath)) return { ok: true, path: destPath };

    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id: modelId, ...data });
    send({ phase: 'downloading', progress: 0 });

    await downloadFile(model.downloadUrl, destPath, (p) => {
        send({ phase: 'downloading', progress: p });
    });

    send({ phase: 'done', progress: 1 });
    return { ok: true, path: destPath };
}

async function downloadAuxiliary(auxKey, mainWindow) {
    const { ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const aux = ZIMAGE_AUXILIARY[auxKey];
    if (!aux) throw new Error(`Unknown auxiliary file: ${auxKey}`);

    const destPath = path.join(MODELS_DIR, aux.filename);
    if (fs.existsSync(destPath)) return { ok: true, path: destPath };

    const id = aux.id;
    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id, ...data });
    send({ phase: 'downloading', progress: 0 });

    await downloadFile(aux.downloadUrl, destPath, (p) => {
        send({ phase: 'downloading', progress: p });
    });

    send({ phase: 'done', progress: 1 });
    return { ok: true, path: destPath };
}

async function deleteModel(modelId) {
    const { LOCAL_MODEL_CATALOG } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const filePath = path.join(MODELS_DIR, model.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const partPath = filePath + '.part';
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    return { ok: true };
}

// ─── LoRA management ──────────────────────────────────────────────────────────

// Map subdirectory names to a human-readable category.
const LORA_SUBFOLDER_LABELS = {
    'flux'                      : 'Flux',
    'ill'                       : 'Illustrious / SDXL',
    'motion_loras'              : 'Motion / Video (WAN)',
    'cogvideox-loras'           : 'CogVideoX',
    'civitai_celeb-lora-archive': 'Civitai Celeb Archive',
    'archive'                   : 'Archive',
    ''                          : 'General (SD1 / SDXL)',
};

function scanLoraDir(dir, loraRoot, results = []) {
    if (!fs.existsSync(dir)) return results;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return results; }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const relative = path.relative(loraRoot, fullPath);
            if (!relative.includes(path.sep)) {
                scanLoraDir(fullPath, loraRoot, results);
            }
        } else if (entry.name.endsWith('.safetensors')) {
            const relative = path.relative(loraRoot, fullPath);
            const parts = relative.split(path.sep);
            const subfolder = parts.length > 1 ? parts[0] : '';
            results.push({
                name     : entry.name.replace(/\.safetensors$/, '').replace(/^lora_/, ''),
                filename : entry.name,
                relative,
                subfolder,
                label    : LORA_SUBFOLDER_LABELS[subfolder] ?? subfolder,
                absPath  : fullPath,
            });
        }
    }
    return results;
}

function listLoras() {
    const loras = scanLoraDir(LORA_DIR, LORA_DIR);
    loras.sort((a, b) => a.subfolder.localeCompare(b.subfolder) || a.name.localeCompare(b.name));
    return { loras, loraDir: LORA_DIR };
}

// ─── Generation ───────────────────────────────────────────────────────────────
function arToDimensions(ar, modelType) {
    const base = (modelType === 'sdxl' || modelType === 'z-image') ? 1024 : 512;
    const map = {
        '1:1': [base, base],
        '16:9': [Math.round(base * 16 / 9 / 64) * 64, base],
        '9:16': [base, Math.round(base * 16 / 9 / 64) * 64],
        '4:3': [Math.round(base * 4 / 3 / 64) * 64, base],
        '3:4': [base, Math.round(base * 4 / 3 / 64) * 64],
    };
    return map[ar] || [base, base];
}

async function generate(params, mainWindow) {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);

    if (!fs.existsSync(BINARY_PATH)) throw new Error('sd.cpp binary not installed. Download it in Settings > Local Models.');

    const model = LOCAL_MODEL_CATALOG.find(m => m.id === params.model);
    if (!model) throw new Error(`Unknown local model: ${params.model}`);

    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found. Download "${model.name}" in Settings > Local Models.`);

    if (model.requiresAuxiliary) {
        const llmPath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.llm.filename);
        const vaePath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.vae.filename);
        if (!fs.existsSync(llmPath)) throw new Error('Text encoder (Qwen3-4B) not downloaded. Go to Settings > Local Models and download all required files for Z-Image.');
        if (!fs.existsSync(vaePath)) throw new Error('VAE (ae.safetensors) not downloaded. Go to Settings > Local Models and download all required files for Z-Image.');
    }

    const [width, height] = arToDimensions(params.aspect_ratio || '1:1', model.type);
    const seed = params.seed && params.seed !== -1 ? params.seed : Math.floor(Math.random() * 2147483647);
    const outPath = path.join(TMP_DIR, `gen-${Date.now()}.png`);

    const steps = model.defaultSteps || params.steps || 20;
    const cfgScale = model.defaultGuidance !== undefined ? model.defaultGuidance : (params.guidance_scale || 7.5);
    const sampler = model.sampler || 'euler_a';

    // z-image GGUFs are standalone diffusion transformers loaded via --diffusion-model.
    // -m triggers full-model SD version detection which fails for these files (0 KV metadata).
    const modelFlag = (model.type === 'z-image' || model.type === 'flux')
        ? '--diffusion-model'
        : '-m';

    const args = [
        modelFlag, modelPath,
        '-p', params.prompt || '',
        '-o', outPath,
        '--steps', String(steps),
        '-H', String(height),
        '-W', String(width),
        '--cfg-scale', String(cfgScale),
        '--seed', String(seed),
        '--sampling-method', sampler,
        '-v',
    ];

    if (params.negative_prompt) {
        args.push('-n', params.negative_prompt);
    }

    // ── LoRA support ──────────────────────────────────────────────────────────
    // params.lora: filename (e.g. "lora_feet.safetensors") or relative path
    // params.loraWeight: multiplier, default 1.0
    if (params.lora) {
        // Resolve full path — the file may live in a subdirectory of LORA_DIR
        let loraAbsPath = params.lora;
        if (!path.isAbsolute(loraAbsPath)) {
            loraAbsPath = path.join(LORA_DIR, params.lora);
        }
        if (fs.existsSync(loraAbsPath)) {
            const loraDir = path.dirname(loraAbsPath);
            const loraName = path.basename(loraAbsPath, '.safetensors');
            const weight = typeof params.loraWeight === 'number' ? params.loraWeight : 1.0;
            // sd.cpp: --lora-model-dir points to the dir; LoRA is activated via
            // <lora:name:weight> embedded in the prompt.
            args.push('--lora-model-dir', loraDir);
            // Append LoRA trigger to the prompt argument already set above.
            const promptIdx = args.indexOf('-p');
            if (promptIdx !== -1) {
                args[promptIdx + 1] = `${args[promptIdx + 1]} <lora:${loraName}:${weight}>`;
            }
        } else {
            console.warn(`[sd-cli] LoRA file not found, skipping: ${loraAbsPath}`);
        }
    }

    if (model.type === 'z-image') {
        const llmPath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.llm.filename);
        const vaePath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.vae.filename);
        args.push('--llm', llmPath);
        args.push('--vae', vaePath);
        if (model.scheduler) args.push('--scheduler', model.scheduler);
    } else if (model.type === 'sdxl') {
        args.push('--sd-version', 'sdxl');
    } else if (model.type === 'sd2') {
        args.push('--sd-version', 'sd2');
    } else if (model.type === 'flux') {
        args.push('--flux');
    }

    return new Promise((resolve, reject) => {
        send({ step: 0, totalSteps: params.steps || model.defaultSteps || 20, status: 'starting' });

        console.log('[sd-cli] command:', BINARY_PATH, args.join(' '));
        // DYLD_LIBRARY_PATH lets macOS find libstable-diffusion.dylib next to sd-cli
        const spawnEnv = { ...process.env, DYLD_LIBRARY_PATH: BIN_DIR, LD_LIBRARY_PATH: BIN_DIR };
        activeProcess = spawn(BINARY_PATH, args, { env: spawnEnv });
        const stepRegex = /step\s+(\d+)\/(\d+)/i;
        const outputLines = [];

        const handleOutput = (data) => {
            const line = data.toString();
            outputLines.push(line.trimEnd());
            const match = line.match(stepRegex);
            if (match) {
                const step = parseInt(match[1]);
                const total = parseInt(match[2]);
                send({ step, totalSteps: total, status: 'generating', progress: step / total });
            }
        };

        activeProcess.stdout.on('data', handleOutput);
        activeProcess.stderr.on('data', handleOutput);

        activeProcess.on('close', (code) => {
            activeProcess = null;
            const allOutput = outputLines.filter(l => l.trim()).join('\n');
            console.error('[sd-cli] full output:\n' + allOutput);
            if (code !== 0) {
                const tail = outputLines.filter(l => l.trim()).slice(-20).join('\n');
                reject(new Error(`sd-cli exited (code ${code}):\n${tail}`));
                return;
            }
            if (!fs.existsSync(outPath)) {
                reject(new Error('sd.cpp finished but no output image found'));
                return;
            }
            try {
                const imgBuffer = fs.readFileSync(outPath);
                const dataUrl = `data:image/png;base64,${imgBuffer.toString('base64')}`;
                fs.unlinkSync(outPath);
                send({ step: 1, totalSteps: 1, status: 'done', progress: 1 });
                resolve({ url: dataUrl, seed });
            } catch (err) {
                reject(err);
            }
        });

        activeProcess.on('error', (err) => {
            activeProcess = null;
            reject(err);
        });
    });
}

function cancelGeneration() {
    if (activeProcess) {
        activeProcess.kill('SIGTERM');
        activeProcess = null;
    }
    return { ok: true };
}

// ─── IPC Registration ─────────────────────────────────────────────────────────
function getMainWindow() {
    return BrowserWindow.getAllWindows()[0] || null;
}

function register() {
    ipcMain.handle('local-ai:binary-status', () => getBinaryStatus());
    ipcMain.handle('local-ai:download-binary', () => downloadBinary(getMainWindow()));
    ipcMain.handle('local-ai:list-models', () => listModels());
    ipcMain.handle('local-ai:list-loras', () => listLoras());
    ipcMain.handle('local-ai:download-model', (_, modelId) => downloadModel(modelId, getMainWindow()));
    ipcMain.handle('local-ai:download-auxiliary', (_, auxKey) => downloadAuxiliary(auxKey, getMainWindow()));
    ipcMain.handle('local-ai:delete-model', (_, modelId) => deleteModel(modelId));
    ipcMain.handle('local-ai:generate', (_, params) => generate(params, getMainWindow()));
    ipcMain.handle('local-ai:cancel-generation', () => cancelGeneration());
}

module.exports = { register };
