/**
 * pythonServer.js — manages the Python sidecar server lifecycle.
 *
 * Follows the same child-process + IPC pattern as localInference.js.
 * The sidecar serves Python-only AI features (ESRGAN, GFPGAN, InsightFace,
 * Diffusers) on a local-only HTTP port so the Next.js proxy can reach them
 * without any changes to the existing JS inference stack.
 *
 * IPC channels exposed to the renderer:
 *   python:status  — returns { status, port, error }
 *   python:start   — (re)starts the server, returns { ok, port, status, error }
 *   python:stop    — stops the server, returns { ok }
 */

const { ipcMain, app } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────
const PYTHON_PORT = parseInt(process.env.PYTHON_SERVER_PORT || '7861', 10);
const SERVER_SCRIPT = path.join(__dirname, '../../python/server.py');
const REQUIREMENTS = path.join(__dirname, '../../python/requirements.txt');
// Project-level pip config: points pip at the local wheel directory.
const PIP_INI = path.join(__dirname, '../../python/pip.ini');

// ─── State ────────────────────────────────────────────────────────────────────
let pythonProcess = null;
// status: 'stopped' | 'starting' | 'running' | 'error' | 'unavailable'
let serverStatus = 'stopped';
let lastError = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the Python executable name on the current platform.
 * Tries python3 first, then python.  Resolves with the executable name or
 * null if Python is not found.
 */
function findPython() {
    return new Promise((resolve) => {
        const candidates = process.platform === 'win32'
            ? ['python', 'python3']
            : ['python3', 'python'];

        let idx = 0;
        const tryNext = () => {
            if (idx >= candidates.length) { resolve(null); return; }
            const candidate = candidates[idx++];
            execFile(candidate, ['--version'], (err) => {
                if (err) { tryNext(); } else { resolve(candidate); }
            });
        };
        tryNext();
    });
}

/**
 * Build the pip env block — inherits process.env and overlays:
 *   PIP_CONFIG_FILE  → project pip.ini (sets find-links + prefer-binary)
 *   PIP_FIND_LINKS   → WHEELS_DIR / PIP_FIND_LINKS env override
 *   PIP_NO_INDEX     → set to '1' when WHEELS_NO_INDEX is truthy
 */
function buildPipEnv() {
    const wheelsDir = process.env.WHEELS_DIR || process.env.PIP_FIND_LINKS || '';
    const env = {
        ...process.env,
        PIP_CONFIG_FILE: PIP_INI,
    };
    if (wheelsDir) {
        env.PIP_FIND_LINKS = wheelsDir;
    }
    if (process.env.WHEELS_NO_INDEX) {
        env.PIP_NO_INDEX = '1';
    }
    return env;
}

/**
 * Run `pip install -r requirements.txt` using the local wheel directory.
 * Non-fatal — a warning is logged if it fails so the sidecar can still
 * attempt to start with whatever packages are already installed.
 */
function installDeps(python) {
    return new Promise((resolve) => {
        const args = ['-m', 'pip', 'install', '-r', REQUIREMENTS];
        const proc = spawn(python, args, {
            env: buildPipEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        proc.stdout.on('data', (d) =>
            console.log('[python-deps]', d.toString().trimEnd()),
        );
        proc.stderr.on('data', (d) =>
            console.warn('[python-deps]', d.toString().trimEnd()),
        );
        proc.on('close', (code) => {
            if (code !== 0) {
                console.warn(`[python-deps] pip install exited with code ${code} — continuing anyway`);
            } else {
                console.log('[python-deps] requirements installed');
            }
            resolve(); // always resolve so startup is not blocked
        });
        proc.on('error', (err) => {
            console.warn('[python-deps] pip install failed:', err.message);
            resolve();
        });
    });
}

/**
 * Poll the /health endpoint until it responds 200 or we run out of retries.
 */
function waitForServer(port, retries = 30, delayMs = 500) {
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get(
                { hostname: '127.0.0.1', port, path: '/health', timeout: 1000 },
                (res) => {
                    res.resume(); // drain
                    if (res.statusCode === 200) {
                        resolve();
                    } else if (retries-- > 0) {
                        setTimeout(attempt, delayMs);
                    } else {
                        reject(new Error('Python server did not become healthy'));
                    }
                },
            );
            req.on('error', () => {
                if (retries-- > 0) {
                    setTimeout(attempt, delayMs);
                } else {
                    reject(new Error('Python server failed to start — check that dependencies from python/requirements.txt are installed'));
                }
            });
            req.end();
        };
        attempt();
    });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

async function startServer() {
    if (pythonProcess) {
        // Already running
        return { ok: true, port: PYTHON_PORT, status: 'running' };
    }

    const python = await findPython();
    if (!python) {
        serverStatus = 'unavailable';
        lastError = 'Python not found. Install Python 3.8+ and run: pip install -r python/requirements.txt';
        console.warn('[python-server]', lastError);
        return { ok: false, error: lastError };
    }

    // Install / update Python dependencies from local wheels before starting.
    console.log('[python-server] installing dependencies (wheels: ' + (process.env.WHEELS_DIR || process.env.PIP_FIND_LINKS || 'PyPI') + ')');
    await installDeps(python);

    serverStatus = 'starting';
    lastError = null;

    // Forward all model-path env vars to the sidecar so it can locate models
    // without needing a separate configuration step.  All vars derive from
    // MODELS_ROOT (set in .env.local) if the individual overrides are absent.
    const modelsRoot = process.env.MODELS_ROOT || '';
    const wheelsDir = process.env.WHEELS_DIR || process.env.PIP_FIND_LINKS || '';
    const env = {
        ...process.env,
        PYTHON_SERVER_PORT: String(PYTHON_PORT),
        // Always point subprocesses at the project pip config
        PIP_CONFIG_FILE: PIP_INI,
        ...(wheelsDir && { PIP_FIND_LINKS: wheelsDir }),
        ...(modelsRoot && {
            MODELS_ROOT: modelsRoot,
            ESRGAN_MODELS_DIR:     process.env.ESRGAN_MODELS_DIR     || path.join(modelsRoot, 'esrgan_models'),
            GFPGAN_WEIGHTS_DIR:    process.env.GFPGAN_WEIGHTS_DIR    || path.join(modelsRoot, 'gfpgan'),
            INSIGHTFACE_MODELS_DIR:process.env.INSIGHTFACE_MODELS_DIR|| path.join(modelsRoot, 'extensions', 'insightface', 'models'),
            COGVIDEOX_DIR:         process.env.COGVIDEOX_DIR         || path.join(modelsRoot, 'CogVideoX'),
            COGVIDEOX_MODEL_PATH:  process.env.COGVIDEOX_MODEL_PATH  || path.join(modelsRoot, 'CogVideoX', 'CogVideoX-5b'),
        }),
    };
    pythonProcess = spawn(python, [SERVER_SCRIPT], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    pythonProcess.stdout.on('data', (d) =>
        console.log('[python-server]', d.toString().trimEnd()),
    );
    pythonProcess.stderr.on('data', (d) =>
        console.error('[python-server]', d.toString().trimEnd()),
    );
    pythonProcess.on('close', (code) => {
        pythonProcess = null;
        if (code === 0 || code === null) {
            serverStatus = 'stopped';
        } else {
            serverStatus = 'error';
            lastError = `Python server exited with code ${code}`;
            console.error('[python-server]', lastError);
        }
    });

    try {
        await waitForServer(PYTHON_PORT);
        serverStatus = 'running';
        console.log(`[python-server] running on port ${PYTHON_PORT}`);
        return { ok: true, port: PYTHON_PORT, status: 'running' };
    } catch (err) {
        lastError = err.message;
        serverStatus = 'error';
        return { ok: false, error: err.message };
    }
}

function stopServer() {
    if (pythonProcess) {
        pythonProcess.kill('SIGTERM');
        pythonProcess = null;
    }
    serverStatus = 'stopped';
    return { ok: true };
}

function getStatus() {
    return { status: serverStatus, port: PYTHON_PORT, error: lastError };
}

// ─── IPC Registration ─────────────────────────────────────────────────────────
function register() {
    ipcMain.handle('python:status', () => getStatus());
    ipcMain.handle('python:start', () => startServer());
    ipcMain.handle('python:stop', () => stopServer());

    // Attempt auto-start; failures are non-fatal — JS inference keeps working.
    startServer().then((result) => {
        if (!result.ok) {
            console.warn('[python-server] auto-start skipped:', result.error);
        }
    });

    // Clean up the sidecar when the Electron app exits.
    app.on('before-quit', () => stopServer());
}

module.exports = { register, getStatus, PYTHON_PORT };
