import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

// Root of the on-disk LoRA directory (repository root / lora).
const LORA_ROOT = process.env.LORA_DIR || path.join(process.cwd(), 'lora');

// Map subdirectory names to a human-readable category used by the UI.
const SUBFOLDER_LABELS = {
    'flux'                      : 'Flux',
    'ill'                       : 'Illustrious / SDXL',
    'motion_loras'              : 'Motion / Video (WAN)',
    'cogvideox-loras'           : 'CogVideoX',
    'civitai_celeb-lora-archive': 'Civitai Celeb Archive',
    'archive'                   : 'Archive',
    ''                          : 'General (SD1 / SDXL)',
};

/**
 * Recursively scan dir for .safetensors files.
 * Returns an array of LoRA descriptor objects.
 */
function scanDir(dir, loraRoot, results = []) {
    if (!fs.existsSync(dir)) return results;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return results; }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Recurse only one level into named subdirectories (skip deep nesting like images/)
            const relative = path.relative(loraRoot, fullPath);
            if (!relative.includes(path.sep)) {
                scanDir(fullPath, loraRoot, results);
            }
        } else if (entry.name.endsWith('.safetensors')) {
            const relative = path.relative(loraRoot, fullPath);
            const parts = relative.split(path.sep);
            const subfolder = parts.length > 1 ? parts[0] : '';
            const label = SUBFOLDER_LABELS[subfolder] ?? subfolder;

            let sizeBytes = 0;
            try { sizeBytes = fs.statSync(fullPath).size; } catch { /* ignore */ }

            results.push({
                // Human-readable display name (strip leading "lora_" prefix)
                name     : entry.name.replace(/\.safetensors$/, '').replace(/^lora_/, ''),
                filename : entry.name,
                relative,                // path relative to LORA_ROOT
                subfolder,
                label,
                absPath  : fullPath,
                sizeBytes,
            });
        }
    }
    return results;
}

/** GET /api/loras — returns the full catalog of available local LoRA files. */
export async function GET() {
    if (!fs.existsSync(LORA_ROOT)) {
        return NextResponse.json(
            { error: `LoRA directory not found: ${LORA_ROOT}`, loras: [] },
            { status: 200 }, // soft error — UI shows empty picker instead of crashing
        );
    }

    const loras = scanDir(LORA_ROOT, LORA_ROOT);

    // Sort: by subfolder then by name
    loras.sort((a, b) =>
        a.subfolder.localeCompare(b.subfolder) || a.name.localeCompare(b.name),
    );

    return NextResponse.json({ loras });
}
