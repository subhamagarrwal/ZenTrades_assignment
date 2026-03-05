import 'dotenv/config';
import http from 'http';
import fs from 'fs-extra';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const SUPPORTED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma', '.mp4', '.mpeg', '.mpga']);

function isSupportedAudioExt(ext) {
    return SUPPORTED_AUDIO_EXTS.has(ext.toLowerCase());
}

function isTranscriptExt(ext) {
    return ext.toLowerCase() === '.txt';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

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

function slugifyCompany(company) {
    return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function findAccountOutputDir(company) {
    const slug = slugifyCompany(company);
    const base = path.resolve(__dirname, 'outputs', 'accounts');
    if (!await fs.pathExists(base)) return null;
    const exact = path.join(base, slug);
    if (await fs.pathExists(exact)) return exact;
    const entries = await fs.readdir(base);
    const match = entries.find(e => e === slug || e.endsWith('_' + slug) || e.startsWith(slug + '_'));
    return match ? path.join(base, match) : null;
}

async function getLatestVersion(accountDir) {
    const entries = await fs.readdir(accountDir);
    const versions = entries.filter(e => /^v\d+$/.test(e)).sort();
    return versions.length > 0 ? versions[versions.length - 1] : null;
}

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

function spawnWithSSE(cmd, args, res) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: __dirname, env: process.env });
        child.stdout.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim()) res.write(`data: ${JSON.stringify({ type: 'log', text: line })}\n\n`);
            }
        });
        child.stderr.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim()) res.write(`data: ${JSON.stringify({ type: 'error', text: line })}\n\n`);
            }
        });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) resolve(code);
            else reject(Object.assign(new Error(`Process exited with code ${code}`), { code }));
        });
    });
}

const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    console.log(`\n→ ${route}`);

    try {

        if (route === 'GET /health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, service: 'clara-automation', time: new Date().toISOString() }));
            return;
        }

        if (req.method === 'GET') {
            const urlPath = req.url.split('?')[0];
            const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
            const staticFile = path.join(__dirname, 'public', safePath === '/' || safePath === '\\' ? 'index.html' : safePath);
            if (await fs.pathExists(staticFile) && (await fs.stat(staticFile)).isFile()) {
                const ext = path.extname(staticFile).toLowerCase();
                const mimeMap = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
                res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
                res.end(await fs.readFile(staticFile));
                return;
            }
        }

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

            let formResult = null;
            if (hasFormData) {
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

        if (req.method === 'GET' && req.url.startsWith('/api/changelog')) {
            const url = new URL(req.url, 'http://localhost');
            const company = url.searchParams.get('company');
            if (!company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'company query param required' }));
                return;
            }

            const changelogPath = path.join(__dirname, 'changelog', `${company}.json`);
            if (await fs.pathExists(changelogPath)) {
                const data = await fs.readJson(changelogPath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No changelog for ${company}` }));
            }
            return;
        }

        if (req.method === 'GET' && req.url.startsWith('/api/batch-status')) {
            const accountsDir = path.join(__dirname, 'outputs', 'accounts');
            const changelogDir = path.join(__dirname, 'changelog');
            const accounts = [];

            if (await fs.pathExists(accountsDir)) {
                const dirs = (await fs.readdir(accountsDir, { withFileTypes: true }))
                    .filter(d => d.isDirectory())
                    .map(d => d.name);

                for (const slug of dirs) {
                    const acct = { company: slug, v1: false, v2: false, changelog: null };
                    const v1Memo = path.join(accountsDir, slug, 'v1', 'memo.json');
                    const v2Memo = path.join(accountsDir, slug, 'v2', 'memo.json');
                    if (await fs.pathExists(v1Memo)) acct.v1 = true;
                    if (await fs.pathExists(v2Memo)) acct.v2 = true;

                    const clPath = path.join(changelogDir, `${slug}.json`);
                    if (await fs.pathExists(clPath)) {
                        try { acct.changelog = await fs.readJson(clPath); } catch { /* skip */ }
                    }

                    accounts.push(acct);
                }
            }

            // Sort: most recently changed first (v2 > v1 > none)
            accounts.sort((a, b) => (b.v2 - a.v2) || (b.v1 - a.v1) || a.company.localeCompare(b.company));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accounts, time: new Date().toISOString() }));
            return;
        }

        if (route === 'POST /api/v1') {
            const contentType = req.headers['content-type'] || '';
            const body = await readBody(req);
            let company, account_id, file;

            if (contentType.includes('multipart/form-data')) {
                const boundary = contentType.split('boundary=')[1];
                const parts = parseMultipart(body, boundary);
                company = parts.company;
                account_id = parts.account_id || parts.company;
                file = parts.file;
            } else {
                const json = JSON.parse(body.toString());
                company = json.company;
                account_id = json.account_id || json.company;
            }

            if (!company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'company is required' }));
                return;
            }
            if (!file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'file is required' }));
                return;
            }

            const ext = path.extname(file.filename).toLowerCase();
            if (!isTranscriptExt(ext) && !isSupportedAudioExt(ext)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Unsupported file format: ${ext}` }));
                return;
            }

            // Save uploaded file
            const isAudio = isSupportedAudioExt(ext);
            const subDir = isAudio ? 'audio' : 'transcripts';
            const saveDir = path.join(__dirname, 'inputs', company, subDir, 'demo');
            await fs.ensureDir(saveDir);
            const savedName = isAudio ? file.filename : 'transcript.txt';
            await fs.writeFile(path.join(saveDir, savedName), file.data);
            const relPath = `${company}/${subDir}/demo/${savedName}`;

            // Begin SSE stream
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            const startTime = Date.now();
            const sse = (type, text) => res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
            sse('log', `▶ Pipeline A: ${company} (${file.filename})`);

            try {
                await spawnWithSSE('node', ['scripts/v1/runDemo.js', relPath, account_id], res);
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                const outputs = await readOutputs(company);
                res.write(`data: ${JSON.stringify({ type: 'done', code: 0, duration, outputs })}\n\n`);
            } catch (err) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                res.write(`data: ${JSON.stringify({ type: 'done', code: err.code || 1, duration, error: err.message })}\n\n`);
            }
            res.end();
            return;
        }

        if (route === 'POST /api/v2') {
            const contentType = req.headers['content-type'] || '';
            const body = await readBody(req);
            let company, account_id, file, formDataStr;

            if (contentType.includes('multipart/form-data')) {
                const boundary = contentType.split('boundary=')[1];
                const parts = parseMultipart(body, boundary);
                company = parts.company;
                account_id = parts.account_id || parts.company;
                file = parts.file;
                formDataStr = parts.form_data || null;
            } else {
                const json = JSON.parse(body.toString());
                company = json.company;
                account_id = json.account_id || json.company;
                formDataStr = json.form_data ? JSON.stringify(json.form_data) : null;
            }

            if (!company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'company is required' }));
                return;
            }
            if (!file && !formDataStr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'file or form_data required' }));
                return;
            }

            // Begin SSE stream
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            const startTime = Date.now();
            const sse = (type, text) => res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
            sse('log', `▶ Pipeline B: ${company}`);

            let pipelineBRan = false;

            try {
                // Phase 1: File → LLM → v2
                if (file) {
                    const ext = path.extname(file.filename).toLowerCase();
                    if (!isTranscriptExt(ext) && !isSupportedAudioExt(ext)) {
                        sse('error', `Unsupported file format: ${ext}`);
                        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                        res.write(`data: ${JSON.stringify({ type: 'done', code: 1, duration, error: `Unsupported format: ${ext}` })}\n\n`);
                        res.end();
                        return;
                    }

                    const isAudio = isSupportedAudioExt(ext);
                    const subDir = isAudio ? 'audio' : 'transcripts';
                    const saveDir = path.join(__dirname, 'inputs', company, subDir, 'onboarding');
                    await fs.ensureDir(saveDir);
                    const savedName = isAudio ? file.filename : 'transcript.txt';
                    await fs.writeFile(path.join(saveDir, savedName), file.data);
                    sse('log', `   📄 Saved: inputs/${company}/${subDir}/onboarding/${savedName}`);

                    const transcriptRel = `${company}/transcripts/onboarding/transcript.txt`;

                    if (isAudio) {
                        sse('log', `   🎵 Transcribing with Whisper...`);
                        const audioAbs = path.join(__dirname, 'inputs', company, 'audio', 'onboarding', savedName);
                        await spawnWithSSE('node', ['scripts/transcribeAudio.js', audioAbs], res);
                        sse('log', `   ✅ Transcription complete`);
                    }

                    sse('log', `   🟢 Running Pipeline B (LLM)...`);
                    await spawnWithSSE('node', ['scripts/v2/runOnboarding.js', transcriptRel, account_id, company], res);
                    sse('log', `   ✅ Pipeline B (LLM) complete`);
                    pipelineBRan = true;
                }

                // Phase 2: Form merge
                if (formDataStr) {
                    const formObj = JSON.parse(formDataStr);
                    if (formObj && typeof formObj === 'object' && Object.keys(formObj).length > 0) {
                        const baseVer = pipelineBRan ? 'v2' : 'v1';
                        sse('log', `   📋 Applying form data on top of ${baseVer}...`);
                        await applyFormData(account_id, company, formObj, baseVer, 'v2');
                        sse('log', `   ✅ Form merge complete`);
                    }
                }

                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                const outputs = await readOutputs(company, 'v2');
                res.write(`data: ${JSON.stringify({ type: 'done', code: 0, duration, outputs })}\n\n`);
            } catch (err) {
                sse('error', `❌ ${err.message}`);
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                res.write(`data: ${JSON.stringify({ type: 'done', code: 1, duration, error: err.message })}\n\n`);
            }
            res.end();
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
    console.log(`GET  /          → Web UI`);
    console.log(`POST /run       → Pipeline A (demo → v1)`);
    console.log(`POST /onboard   → Pipeline B (onboarding call → v2)`);
    console.log(`POST /form      → Pipeline C (onboarding form → v(n+1))`);
    console.log(`POST /api/v1    → Pipeline A with SSE streaming`);
    console.log(`POST /api/v2    → Pipeline B with SSE streaming`);
    console.log(`GET  /outputs   → Read account outputs`);
    console.log(`GET  /api/changelog → Changelog for a company`);
    console.log(`GET  /api/batch-status → All accounts + changelogs`);
    console.log(`GET  /health    → Health check`);
    console.log('═══════════════════════════════════════════');
});