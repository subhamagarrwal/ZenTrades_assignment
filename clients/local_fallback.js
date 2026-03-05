/**
 * Local fallback inference — whisper.cpp (STT) + llama.cpp (LLM)
 * Activated when Groq API returns 429 (rate limit exceeded).
 * Runs entirely on CPU inside Docker — no GPU, torch, or Python needed.
 *
 * Models are downloaded on first use and cached in MODELS_DIR.
 * Pre-download with:  node scripts/downloadModels.js
 */

import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = process.env.MODELS_DIR || path.join(PROJECT_ROOT, 'models');

// ─── Model definitions ────────────────────────────────────
const WHISPER_MODEL = {
    file: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    label: 'whisper-small (~466 MB)',
};

const LLM_MODEL = {
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    label: 'Qwen2.5-1.5B-Instruct Q4_K_M (~1.0 GB)',
};

const LLAMA_PORT = 8081;
let _llamaProc = null;
let _llamaReady = false;

// ─── Binary check ──────────────────────────────────────────
function hasBinary(name) {
    try {
        execFileSync(name, ['--help'], { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch (e) {
        // ENOENT = binary doesn't exist; anything else = exists but errored
        return e.code !== 'ENOENT';
    }
}

export const WHISPER_AVAILABLE = hasBinary('whisper-cli');
export const LLAMA_AVAILABLE = hasBinary('llama-server');

// ─── Model download (curl, progress to stderr) ────────────
async function ensureModel(model) {
    const dest = path.join(MODELS_DIR, model.file);
    if (await fs.pathExists(dest)) return dest;

    await fs.ensureDir(MODELS_DIR);
    console.log(`⬇️  Downloading ${model.label} — one-time download...`);

    return new Promise((resolve, reject) => {
        const proc = spawn('curl', ['-L', '--progress-bar', '-o', dest, model.url], {
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                fs.removeSync(dest);   // remove partial download
                return reject(new Error(`curl exited ${code} downloading ${model.file}`));
            }
            console.log(`✅ Downloaded ${model.file}`);
            resolve(dest);
        });
        proc.on('error', reject);
    });
}

/** Pre-download both models. Call from scripts/downloadModels.js */
export async function ensureModels() {
    if (!WHISPER_AVAILABLE) console.warn('⚠️  whisper-cli not found — whisper model will download but binary unavailable outside Docker');
    if (!LLAMA_AVAILABLE) console.warn('⚠️  llama-server not found — LLM model will download but binary unavailable outside Docker');
    await ensureModel(WHISPER_MODEL);
    await ensureModel(LLM_MODEL);
    console.log('✅ All fallback models ready');
}

// ─── Local Whisper STT ─────────────────────────────────────
export async function localTranscribe(audioChunkPath) {
    if (!WHISPER_AVAILABLE) {
        throw new Error('whisper-cli binary not found. Run inside the Docker container or install whisper.cpp.');
    }

    const modelPath = await ensureModel(WHISPER_MODEL);

    // Convert to 16 kHz mono WAV (whisper.cpp requirement)
    const wavPath = audioChunkPath + '.fallback.wav';
    await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
            '-y', '-i', audioChunkPath,
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
            wavPath,
        ]);
        ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
        ff.on('error', reject);
    });

    // Run whisper-cli  →  writes <outputPrefix>.json
    const outputPrefix = wavPath.replace(/\.wav$/, '');

    return new Promise((resolve, reject) => {
        const args = [
            '-m', modelPath,
            '-f', wavPath,
            '-oj',                   // output JSON
            '-of', outputPrefix,     // output file prefix
            '-l', 'en',
            '--no-prints',
        ];
        let stderr = '';
        const proc = spawn('whisper-cli', args);
        proc.stderr.on('data', (d) => (stderr += d));

        proc.on('close', async (code) => {
            await fs.remove(wavPath).catch(() => {});

            if (code !== 0) {
                return reject(new Error(`whisper-cli exit ${code}: ${stderr.slice(0, 500)}`));
            }

            const jsonPath = outputPrefix + '.json';
            try {
                const raw = await fs.readJson(jsonPath);
                await fs.remove(jsonPath).catch(() => {});

                // Convert whisper.cpp JSON → Groq-compatible format
                const segments = (raw.transcription || []).map((seg) => ({
                    start: seg.offsets?.from != null ? seg.offsets.from / 1000 : 0,
                    end:   seg.offsets?.to   != null ? seg.offsets.to   / 1000 : 0,
                    text:  (seg.text || '').trim(),
                }));

                resolve({
                    text: segments.map((s) => s.text).join(' '),
                    segments,
                });
            } catch (e) {
                reject(new Error(`Failed to parse whisper output: ${e.message}`));
            }
        });

        proc.on('error', reject);
    });
}

// ─── Lazy llama-server management ──────────────────────────
async function ensureLlamaServer() {
    if (_llamaReady) return;

    // If a previous process (from an earlier script invocation) is already
    // listening on the port, reuse it — no need to spawn a new one.
    try {
        await httpGet(`http://127.0.0.1:${LLAMA_PORT}/health`);
        _llamaReady = true;
        console.log('✅ Local LLM server already running — reusing');
        return;
    } catch { /* not up yet — fall through to spawn */ }

    if (!LLAMA_AVAILABLE) {
        throw new Error('llama-server binary not found. Run inside the Docker container or install llama.cpp.');
    }

    const modelPath = await ensureModel(LLM_MODEL);
    const os = await import('os');
    const threads = Math.max(2, Math.min(4, os.default.cpus().length - 1));

    console.log(`🚀 Starting local LLM server (Qwen2.5-1.5B, ${threads} threads, port ${LLAMA_PORT})...`);

    _llamaProc = spawn('llama-server', [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', String(LLAMA_PORT),
        '-c', '8192',       // context size
        '-ngl', '0',        // no GPU layers
        '-t', String(threads),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Unref the process and its streams so they don't prevent Node from
    // exiting once the calling script (runOnboarding.js, etc.) finishes.
    // The server keeps running; it's just no longer holding the event loop.
    _llamaProc.unref();
    if (_llamaProc.stdout) _llamaProc.stdout.unref();
    if (_llamaProc.stderr) _llamaProc.stderr.unref();

    // Log server stderr for debugging
    _llamaProc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) console.log(`   [llama] ${msg}`);
    });

    _llamaProc.on('exit', (code) => {
        console.log(`⚠️  llama-server exited (code ${code})`);
        _llamaReady = false;
        _llamaProc = null;
    });

    // Poll /health until ready (max 120s)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        try {
            await httpGet(`http://127.0.0.1:${LLAMA_PORT}/health`);
            _llamaReady = true;
            console.log('✅ Local LLM server ready');
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    // Timed out
    if (_llamaProc) _llamaProc.kill('SIGTERM');
    throw new Error('llama-server did not become ready within 120s');
}

// ─── Local LLM completion (OpenAI-compatible API) ──────────
export async function localChatCompletion(messages, maxTokens = 4096) {
    await ensureLlamaServer();
    console.log('🤖 Using local LLM fallback (Qwen2.5-1.5B — slower than Groq)...');

    const response = await httpPost(
        `http://127.0.0.1:${LLAMA_PORT}/v1/chat/completions`,
        { messages, max_tokens: maxTokens, temperature: 0, stream: false }
    );

    return response.choices[0].message.content;
}

// ─── HTTP helpers ──────────────────────────────────────────
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () =>
                res.statusCode === 200 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}`))
            );
        }).on('error', reject);
    });
}

function httpPost(url, body) {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                let d = '';
                res.on('data', (c) => (d += c));
                res.on('end', () => {
                    try {
                        if (res.statusCode < 300) resolve(JSON.parse(d));
                        else reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 500)}`));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ─── Cleanup on process exit ───────────────────────────────
function cleanup() {
    if (_llamaProc) {
        _llamaProc.kill('SIGTERM');
        _llamaProc = null;
        _llamaReady = false;
    }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
