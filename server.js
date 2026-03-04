import 'dotenv/config';
import http from 'http';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// ──────────────────────────────────────────────
// Supported audio formats (Whisper-compatible via ffmpeg)
// ──────────────────────────────────────────────
const SUPPORTED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma', '.mp4', '.mpeg', '.mpga']);

function isSupportedAudioExt(ext) {
    return SUPPORTED_AUDIO_EXTS.has(ext.toLowerCase());
}

function isTranscriptExt(ext) {
    return ext.toLowerCase() === '.txt';
}

// ──────────────────────────────────────────────
// Read full request body as buffer
// ──────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// ──────────────────────────────────────────────
// Parse multipart (audio + fields)
// ──────────────────────────────────────────────
function parseMultipart(buffer, boundary) {
    const parts = {};
    const raw = buffer.toString('binary');
    const sections = raw.split(`--${boundary}`);

    for (const section of sections) {
        if (!section.includes('Content-Disposition')) continue;
        const [headers, ...rest] = section.split('\r\n\r\n');
        const content = rest.join('\r\n\r\n').replace(/\r\n$/, '');
        const nameMatch = headers.match(/name="([^"]+)"/);
        const fileMatch = headers.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;

        if (fileMatch) {
            parts[nameMatch[1]] = { filename: fileMatch[1], data: Buffer.from(content, 'binary') };
        } else {
            parts[nameMatch[1]] = content.trim();
        }
    }
    return parts;
}

// ──────────────────────────────────────────────
// Find account output folder by company slug
// ──────────────────────────────────────────────
function slugifyCompany(company) {
    return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function findAccountOutputDir(company) {
    const slug = slugifyCompany(company);
    const base = path.resolve(__dirname, 'outputs', 'accounts');
    if (!await fs.pathExists(base)) return null;
    const exact = path.join(base, slug);
    if (await fs.pathExists(exact)) return exact;
    // Fallback: prefix match (handles legacy {accountId}_{slug} folders)
    const entries = await fs.readdir(base);
    const match = entries.find(e => e === slug || e.endsWith('_' + slug) || e.startsWith(slug + '_'));
    return match ? path.join(base, match) : null;
}

// ──────────────────────────────────────────────
// Get latest version folder
// ──────────────────────────────────────────────
async function getLatestVersion(accountDir) {
    const entries = await fs.readdir(accountDir);
    const versions = entries.filter(e => /^v\d+$/.test(e)).sort();
    return versions.length > 0 ? versions[versions.length - 1] : null;
}

// ──────────────────────────────────────────────
// Read outputs for a given version
// ──────────────────────────────────────────────
async function readOutputs(company, version) {
    const dir = await findAccountOutputDir(company);
    if (!dir) return null;

    const v = version || await getLatestVersion(dir);
    if (!v) return null;

    const result = { company, version: v, files: {} };
    const vDir = path.join(dir, v);

    for (const file of ['memo.json', 'agentDraftSpec.json', 'changes.json', 'onboarding_update.json', 'form_submission.json', 'conflicts.json']) {
        const fp = path.join(vDir, file);
        if (await fs.pathExists(fp)) {
            result.files[file.replace('.json', '')] = await fs.readJson(fp);
        }
    }
    return result;
}

// ──────────────────────────────────────────────
// Parse input — supports JSON or multipart
// ──────────────────────────────────────────────
async function parseInput(req) {
    const contentType = req.headers['content-type'] || '';
    const body = await readBody(req);

    if (contentType.includes('multipart/form-data')) {
        const boundary = contentType.split('boundary=')[1];
        const parts = parseMultipart(body, boundary);
        return {
            account_id      : parts.account_id,
            company         : parts.company,
            transcript      : parts.transcript || null,
            audio           : parts.audio || null,
            form_data       : parts.form_data ? JSON.parse(parts.form_data) : null,
            transcript_path : parts.transcript_path || null,
            onboarding_path : parts.onboarding_path || null,
        };
    }

    const json = JSON.parse(body.toString());
    return {
        account_id      : json.account_id,
        company         : json.company,
        transcript      : json.transcript || null,
        form_data       : json.form_data  || null,
        transcript_path : json.transcript_path  || null,
        onboarding_path : json.onboarding_path  || null,
        audio           : json.audio_base64
            ? { filename: json.audio_filename || 'upload.mp3', data: Buffer.from(json.audio_base64, 'base64') }
            : null,
    };
}

// ──────────────────────────────────────────────
// Save input and transcribe if needed
// ──────────────────────────────────────────────
async function saveInputAndTranscribe(company, type, transcript, audio) {
    const transcriptDir = path.resolve(__dirname, 'inputs', company, 'transcripts', type);
    const transcriptPath = path.join(transcriptDir, 'transcript.txt');
    await fs.ensureDir(transcriptDir);

    if (transcript) {
        await fs.writeFile(transcriptPath, transcript, 'utf-8');
        console.log(`   📄 Transcript saved: ${transcriptPath}`);
        return;
    }

    if (audio) {
        const audioDir = path.resolve(__dirname, 'inputs', company, 'audio', type);
        await fs.ensureDir(audioDir);
        const audioPath = path.join(audioDir, audio.filename);
        await fs.writeFile(audioPath, audio.data);
        console.log(`   🎵 Audio saved: ${audioPath}`);

        const relPath = path.relative(__dirname, audioPath);
        console.log(`   🎵 Transcribing...`);
        await execAsync(`node scripts/transcribeAudio.js "${relPath}"`, { cwd: __dirname, timeout: 120000 });
        console.log(`   ✅ Transcription complete`);
        return;
    }

    if (!await fs.pathExists(transcriptPath)) {
        throw new Error(`No transcript or audio provided and no existing transcript at ${transcriptPath}`);
    }
    console.log(`   📄 Using existing transcript: ${transcriptPath}`);
}

// ──────────────────────────────────────────────
// Deep merge with conflict detection
// ──────────────────────────────────────────────
function deepMergeWithConflicts(existing, patch, path = '') {
    const merged = { ...existing };
    const conflicts = [];

    for (const [key, newVal] of Object.entries(patch)) {
        if (newVal === null || newVal === undefined) continue;
        if (Array.isArray(newVal) && newVal.length === 0) continue;
        if (typeof newVal === 'object' && !Array.isArray(newVal) && Object.keys(newVal).length === 0) continue;

        const fieldPath = path ? `${path}.${key}` : key;
        const oldVal = existing[key];

        // No existing value — just set
        if (oldVal === null || oldVal === undefined) {
            merged[key] = newVal;
            continue;
        }

        // Both are objects — recurse
        if (typeof oldVal === 'object' && !Array.isArray(oldVal) && typeof newVal === 'object' && !Array.isArray(newVal)) {
            const sub = deepMergeWithConflicts(oldVal, newVal, fieldPath);
            merged[key] = sub.merged;
            conflicts.push(...sub.conflicts);
            continue;
        }

        // Both are arrays — union
        if (Array.isArray(oldVal) && Array.isArray(newVal)) {
            const union = [...new Set([...oldVal, ...newVal])];
            if (JSON.stringify(oldVal.sort()) !== JSON.stringify(newVal.sort())) {
                conflicts.push({
                    field    : fieldPath,
                    type     : 'array_merge',
                    existing : oldVal,
                    incoming : newVal,
                    resolved : union,
                    note     : 'Arrays merged (union). Review if replacement was intended.',
                });
            }
            merged[key] = union;
            continue;
        }

        // Scalar conflict — incoming wins but flag it
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
            conflicts.push({
                field    : fieldPath,
                type     : 'override',
                existing : oldVal,
                incoming : newVal,
                resolved : newVal,
                note     : 'Form data overrides existing value. Verify correctness.',
            });
        }
        merged[key] = newVal;
    }

    return { merged, conflicts };
}

// ──────────────────────────────────────────────
// Apply onboarding form data to a memo (any base version)
//   baseVersion: which version to read memo from ('v1' or 'v2')
//   targetVersion: which version to write to ('v2')
// ──────────────────────────────────────────────
async function applyFormData(accountId, company, formData, baseVersion = 'v1', targetVersion = 'v2') {
    console.log(`   📋 Applying onboarding form data (base: ${baseVersion} → target: ${targetVersion})...`);

    const accountDir = await findAccountOutputDir(company);
    if (!accountDir) {
        throw new Error(`No existing account found for company '${company}'. Run Pipeline A (demo) first.`);
    }

    const baseMemoPath = path.join(accountDir, baseVersion, 'memo.json');
    if (!await fs.pathExists(baseMemoPath)) {
        throw new Error(`No memo.json found at ${baseMemoPath}. Run Pipeline A first.`);
    }

    const existingMemo = await fs.readJson(baseMemoPath);

    // Merge with conflict detection
    const { merged, conflicts } = deepMergeWithConflicts(existingMemo, formData);

    const nextDir = path.join(accountDir, targetVersion);
    await fs.ensureDir(nextDir);

    // Save merged memo
    merged.account_id = accountId;
    await fs.writeJson(path.join(nextDir, 'memo.json'), merged, { spaces: 2 });
    console.log(`   ✅ Merged memo saved: ${targetVersion}/memo.json`);

    // Save form submission record
    await fs.writeJson(path.join(nextDir, 'form_submission.json'), {
        submitted_at : new Date().toISOString(),
        base_version : baseVersion,
        form_data    : formData,
    }, { spaces: 2 });

    // Save conflicts
    if (conflicts.length > 0) {
        await fs.writeJson(path.join(nextDir, 'conflicts.json'), {
            detected_at : new Date().toISOString(),
            total       : conflicts.length,
            conflicts,
        }, { spaces: 2 });
        console.log(`   ⚠️  ${conflicts.length} conflict(s) detected → conflicts.json`);
    } else {
        console.log(`   ✅ No conflicts`);
    }

    // Build changes list
    const changes = [];
    for (const c of conflicts) {
        changes.push({ field: c.field, old: c.existing, new: c.resolved, source: 'form', conflict: true });
    }
    for (const [key, val] of Object.entries(formData)) {
        if (!conflicts.find(c => c.field === key)) {
            const oldVal = existingMemo[key];
            if (JSON.stringify(oldVal) !== JSON.stringify(val) && val !== null && val !== undefined) {
                changes.push({ field: key, old: oldVal ?? null, new: val, source: 'form', conflict: false });
            }
        }
    }

    // Save / append to changes.json
    const changesPath = path.join(nextDir, 'changes.json');
    let existingChanges = null;
    if (await fs.pathExists(changesPath)) {
        existingChanges = await fs.readJson(changesPath);
    }

    if (existingChanges && existingChanges.changes) {
        // Pipeline B already wrote changes — append form changes
        existingChanges.source = (existingChanges.source || 'onboarding_call') + ' + onboarding_form';
        existingChanges.changes.push(...changes.map(c => ({ ...c, source: 'form' })));
        existingChanges.total_form_conflicts = conflicts.length;
        await fs.writeJson(changesPath, existingChanges, { spaces: 2 });
    } else {
        await fs.writeJson(changesPath, {
            version_from : baseVersion,
            version_to   : targetVersion,
            generated_at : new Date().toISOString(),
            source       : 'onboarding_form',
            changes,
        }, { spaces: 2 });
    }
    console.log(`   ✅ Changes saved: ${targetVersion}/changes.json`);

    // Regenerate agent spec from merged memo
    console.log(`   🤖 Regenerating agent spec...`);
    try {
        const { generateAgentDraftSpec } = await import('./scripts/v1/generateAgentDraftSpec.js');
        const spec = generateAgentDraftSpec(accountId, merged, targetVersion);

        // Carry forward agent_id & llm_id from v1
        for (const idFile of ['agent_id.json', 'llm_id.json']) {
            const src = path.join(accountDir, 'v1', idFile);
            if (await fs.pathExists(src)) {
                const data = await fs.readJson(src);
                if (data.agent_id) spec.agent_id = data.agent_id;
                if (data.llm_id)   spec.llm_id   = data.llm_id;
            }
        }

        await fs.writeJson(path.join(nextDir, 'agentDraftSpec.json'), spec, { spaces: 2 });
        console.log(`   ✅ agentDraftSpec.json regenerated`);
    } catch (specErr) {
        console.warn(`   ⚠️  Agent spec regeneration failed: ${specErr.message}`);
        const fallbackSpec = path.join(accountDir, 'v1', 'agentDraftSpec.json');
        if (await fs.pathExists(fallbackSpec)) {
            await fs.copy(fallbackSpec, path.join(nextDir, 'agentDraftSpec.json'));
            console.log(`   ⚠️  Copied v1 agentDraftSpec.json as fallback`);
        }
    }

    return { nextVersion: targetVersion, merged, conflicts, changes };
}

// ──────────────────────────────────────────────
// SERVER
// ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    console.log(`\n→ ${route}`);

    try {

        // ── Health ──
        if (route === 'GET /health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, service: 'clara-automation', time: new Date().toISOString() }));
            return;
        }

        // ── Pipeline A: Demo → v1 ──
        // runDemo.js handles both .txt and audio files internally
        if (route === 'POST /run') {
            const { account_id, company, transcript_path } = await parseInput(req);

            if (!account_id || !company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'account_id and company are required' }));
                return;
            }

            console.log(`▶ PIPELINE A: ${company} → ${account_id}`);

            // Normalize path — relative to inputs/, forward slashes, no leading "inputs/"
            const relativeToInputs = (transcript_path || `${company}/transcripts/demo/transcript.txt`)
                .replace(/^inputs[\\/]/, '')
                .replace(/\\/g, '/');

            // ── Format validation ──
            const ext = path.extname(relativeToInputs).toLowerCase();
            if (!isTranscriptExt(ext) && !isSupportedAudioExt(ext)) {
                console.error(`❌ Unsupported file format: ${ext}`);
                console.error(`   Supported audio: ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`);
                console.error(`   Supported text:  .txt`);
                console.error(`   ⛔ Stopping pipeline — no API calls made.`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Unsupported file format: ${ext}. Supported: .txt, ${[...SUPPORTED_AUDIO_EXTS].join(', ')}` }));
                return;
            }

            console.log(`   🔵 Running Pipeline A with: ${relativeToInputs}`);
            const { stdout } = await execAsync(
                `node scripts/v1/runDemo.js "${relativeToInputs}" "${account_id}"`,
                { cwd: __dirname, timeout: 300000 }
            );
            console.log(`   ✅ Pipeline A complete`);

            const outputs = await readOutputs(company);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pipeline: 'A', ...outputs }));
            return;
        }

        // ── Pipeline B: Onboarding → v2 ──
        // Accepts any combination of:
        //   • onboarding_path (audio or .txt)  → transcribe if audio, then LLM
        //   • transcript (inline text)          → save, then LLM
        //   • audio (uploaded binary)           → save + transcribe, then LLM
        //   • form_data (JSON object)           → direct merge on top (can be standalone OR combined)
        //
        // Combined: transcript/audio runs Pipeline B first → produces v2.
        //           Then form_data is merged ON TOP of the v2 memo.
        // Form only: skips LLM, merges form onto v1 memo → v2.
        //
        // Unsupported formats → reject with console error BEFORE any API calls.
        if (route === 'POST /onboard') {
            const { account_id, company, transcript, audio, onboarding_path, form_data } = await parseInput(req);

            if (!account_id || !company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'account_id and company are required' }));
                return;
            }

            console.log(`▶ PIPELINE B: ${company} → ${account_id}`);

            const hasTranscriptInput = !!(onboarding_path || audio || transcript);
            const hasFormData = !!(form_data && typeof form_data === 'object' && Object.keys(form_data).length > 0);

            if (!hasTranscriptInput && !hasFormData) {
                // Check for existing transcript on disk as last resort
                const existing = path.resolve(__dirname, 'inputs', company, 'transcripts', 'onboarding', 'transcript.txt');
                if (!await fs.pathExists(existing)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'No input provided. Send at least one of: onboarding_path, transcript, audio, or form_data',
                    }));
                    return;
                }
                // Fallback to existing transcript
                console.log(`   📄 Using existing transcript on disk`);
            }

            // ──────────────────────────────────────────
            // PHASE 1: Audio / Transcript → LLM → v2
            // ──────────────────────────────────────────
            let pipelineBRan = false;

            if (hasTranscriptInput || (!hasFormData)) {
                let relativeToInputs;

                if (onboarding_path) {
                    const cleaned = onboarding_path.replace(/^inputs[\\/]/, '').replace(/\\/g, '/');
                    const ext = path.extname(cleaned).toLowerCase();

                    // Format validation — reject early
                    if (!isTranscriptExt(ext) && !isSupportedAudioExt(ext)) {
                        console.error(`❌ Unsupported file format: "${ext}"`);
                        console.error(`   Supported audio: ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`);
                        console.error(`   Supported text:  .txt`);
                        console.error(`   ⛔ Stopping pipeline — no API calls made.`);
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: `Unsupported file format: "${ext}". Supported: .txt, ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`,
                        }));
                        return;
                    }

                    if (isSupportedAudioExt(ext)) {
                        const existingTranscript = path.resolve(__dirname, 'inputs', company, 'transcripts', 'onboarding', 'transcript.txt');
                        if (await fs.pathExists(existingTranscript)) {
                            console.log(`   ⏭️  Transcript already exists, skipping Whisper`);
                        } else {
                            console.log(`   🎵 Audio detected (${ext}): ${cleaned}`);
                            const absAudioPath = path.resolve(__dirname, 'inputs', cleaned);
                            if (!await fs.pathExists(absAudioPath)) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: `Audio file not found: inputs/${cleaned}` }));
                                return;
                            }
                            console.log(`   🎵 Transcribing with Whisper...`);
                            await execAsync(`node scripts/transcribeAudio.js "${absAudioPath}"`, { cwd: __dirname, timeout: 300000 });
                            console.log(`   ✅ Transcription complete`);
                        }
                        relativeToInputs = `${company}/transcripts/onboarding/transcript.txt`;
                    } else {
                        relativeToInputs = cleaned;
                    }
                } else if (audio) {
                    const ext = path.extname(audio.filename).toLowerCase();
                    if (!isSupportedAudioExt(ext)) {
                        console.error(`❌ Unsupported uploaded audio format: "${ext}" (file: ${audio.filename})`);
                        console.error(`   Supported: ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`);
                        console.error(`   ⛔ Stopping pipeline — no API calls made.`);
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: `Unsupported audio format: "${ext}". Supported: ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`,
                        }));
                        return;
                    }
                    const existingTranscript = path.resolve(__dirname, 'inputs', company, 'transcripts', 'onboarding', 'transcript.txt');
                    if (await fs.pathExists(existingTranscript)) {
                        console.log(`   ⏭️  Transcript already exists, skipping upload+transcription`);
                    } else {
                        console.log(`   🎵 Uploaded audio (${ext}): ${audio.filename}`);
                        await saveInputAndTranscribe(company, 'onboarding', null, audio);
                    }
                    relativeToInputs = `${company}/transcripts/onboarding/transcript.txt`;
                } else if (transcript) {
                    console.log(`   📄 Saving inline transcript...`);
                    await saveInputAndTranscribe(company, 'onboarding', transcript, null);
                    relativeToInputs = `${company}/transcripts/onboarding/transcript.txt`;
                } else {
                    relativeToInputs = `${company}/transcripts/onboarding/transcript.txt`;
                }

                console.log(`   🟢 Running Pipeline B (LLM) with: ${relativeToInputs}`);
                await execAsync(
                    `node scripts/v2/runOnboarding.js "${relativeToInputs}" "${account_id}" "${company}"`,
                    { cwd: __dirname, timeout: 300000 }
                );
                console.log(`   ✅ Pipeline B (LLM) complete`);
                pipelineBRan = true;
            }

            // ──────────────────────────────────────────
            // PHASE 2: Form data → merge on top
            // ──────────────────────────────────────────
            let formResult = null;
            if (hasFormData) {
                // If Pipeline B just wrote v2, merge form on top of v2.
                // If Pipeline B didn't run, merge form onto v1 → v2.
                const baseVer = pipelineBRan ? 'v2' : 'v1';
                console.log(`   📋 Applying form data on top of ${baseVer}...`);
                formResult = await applyFormData(account_id, company, form_data, baseVer, 'v2');
                console.log(`   ✅ Form merge complete`);
            }

            const outputs = await readOutputs(company, 'v2');
            const response = { ok: true, pipeline: 'B', ...outputs };
            if (formResult) {
                response.form_applied = true;
                response.conflicts    = formResult.conflicts;
                response.form_changes = formResult.changes;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            return;
        }

        // ── Pipeline C: Standalone form → v2 (kept for backward compat) ──
        if (route === 'POST /form') {
            const { account_id, company, form_data } = await parseInput(req);

            if (!account_id || !company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'account_id and company are required' }));
                return;
            }

            if (!form_data || typeof form_data !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'form_data object is required' }));
                return;
            }

            console.log(`▶ FORM SUBMISSION: ${company} → ${account_id}`);

            const result = await applyFormData(account_id, company, form_data, 'v1', 'v2');
            const outputs = await readOutputs(company, result.nextVersion);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok        : true,
                pipeline  : 'C (form)',
                ...outputs,
                conflicts : result.conflicts,
                changes   : result.changes,
            }));
            return;
        }

        // ── Get outputs ──
        if (route === 'GET /outputs') {
            const url = new URL(req.url, 'http://localhost');
            const company = url.searchParams.get('company') || url.searchParams.get('account_id');
            if (!company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'company query param required' }));
                return;
            }

            const outputs = await readOutputs(company);
            if (!outputs) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No outputs for ${company}` }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(outputs));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
        console.error(`❌ ${route}:`, err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message, stderr: err.stderr || null }));
    }
});

server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════');
    console.log('✅ Clara Automation Server');
    console.log('═══════════════════════════════════════════');
    console.log(`POST /run      → Pipeline A (demo → v1)`);
    console.log(`POST /onboard  → Pipeline B (onboarding call → v2)`);
    console.log(`POST /form     → Pipeline C (onboarding form → v(n+1))`);
    console.log(`GET  /outputs  → Read account outputs`);
    console.log(`GET  /health   → Health check`);
    console.log('═══════════════════════════════════════════');
});