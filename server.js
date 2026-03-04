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
// Find account output folder
// ──────────────────────────────────────────────
async function findAccountOutputDir(accountId) {
    const base = path.resolve(__dirname, 'outputs', 'accounts');
    if (!await fs.pathExists(base)) return null;
    const entries = await fs.readdir(base);
    const match = entries.find(e => e.startsWith(accountId));
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
async function readOutputs(accountId, version) {
    const dir = await findAccountOutputDir(accountId);
    if (!dir) return null;

    const v = version || await getLatestVersion(dir);
    if (!v) return null;

    const result = { account_id: accountId, version: v, files: {} };
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
            account_id : parts.account_id,
            company    : parts.company,
            transcript : parts.transcript || null,
            audio      : parts.audio || null,
            form_data  : parts.form_data ? JSON.parse(parts.form_data) : null,
        };
    }

    const json = JSON.parse(body.toString());
    return {
        account_id : json.account_id,
        company    : json.company,
        transcript : json.transcript || null,
        form_data  : json.form_data || null,
        audio      : json.audio_base64
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
// Apply onboarding form to existing memo
// ──────────────────────────────────────────────
async function applyFormData(accountId, company, formData) {
    console.log(`   📋 Applying onboarding form data...`);

    // Find existing memo
    const accountDir = await findAccountOutputDir(accountId);
    if (!accountDir) {
        throw new Error(`No existing account found for ${accountId}. Run Pipeline A (demo) first.`);
    }

    const latestVersion = await getLatestVersion(accountDir);
    const memoPath = path.join(accountDir, latestVersion, 'memo.json');

    if (!await fs.pathExists(memoPath)) {
        throw new Error(`No memo.json found at ${memoPath}`);
    }

    const existingMemo = await fs.readJson(memoPath);

    // Merge with conflict detection
    const { merged, conflicts } = deepMergeWithConflicts(existingMemo, formData);

    // Determine next version
    const versionNum = parseInt(latestVersion.replace('v', ''), 10);
    const nextVersion = `v${versionNum + 1}`;
    const nextDir = path.join(accountDir, nextVersion);
    await fs.ensureDir(nextDir);

    // Save merged memo
    merged.account_id = accountId;
    await fs.writeJson(path.join(nextDir, 'memo.json'), merged, { spaces: 2 });
    console.log(`   ✅ Merged memo saved: ${nextDir}/memo.json`);

    // Save form submission
    await fs.writeJson(path.join(nextDir, 'form_submission.json'), {
        submitted_at : new Date().toISOString(),
        form_data    : formData,
    }, { spaces: 2 });

    // Save conflicts
    if (conflicts.length > 0) {
        await fs.writeJson(path.join(nextDir, 'conflicts.json'), {
            detected_at   : new Date().toISOString(),
            total         : conflicts.length,
            conflicts,
        }, { spaces: 2 });
        console.log(`   ⚠️  ${conflicts.length} conflict(s) detected → conflicts.json`);
    } else {
        console.log(`   ✅ No conflicts`);
    }

    // Build changes
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

    await fs.writeJson(path.join(nextDir, 'changes.json'), {
        version_from : latestVersion,
        version_to   : nextVersion,
        generated_at : new Date().toISOString(),
        source       : 'onboarding_form',
        changes,
    }, { spaces: 2 });
    console.log(`   ✅ Changes saved: ${nextDir}/changes.json`);

    // Regenerate agent spec from merged memo
    console.log(`   🤖 Regenerating agent spec...`);
    const { stdout } = await execAsync(
        `node -e "
            import('./scripts/v1/generateAgentDraftSpec.js').then(async m => {
                const memo = JSON.parse(require('fs').readFileSync('${path.join(nextDir, 'memo.json').replace(/\\/g, '/')}', 'utf-8'));
                const spec = await m.generateAgentDraftSpec('${accountId}', memo, '${nextVersion}');
                require('fs').writeFileSync('${path.join(nextDir, 'agentDraftSpec.json').replace(/\\/g, '/')}', JSON.stringify(spec, null, 2));
                console.log('done');
            });
        "`,
        { cwd: __dirname, timeout: 120000 }
    ).catch(() => {
        // Fallback: just copy existing spec
        return { stdout: 'fallback' };
    });

    // Update changelog
    const changelogDir = path.resolve(__dirname, 'changelog');
    await fs.ensureDir(changelogDir);
    const changelogPath = path.join(changelogDir, `${accountId}.json`);
    let changelog = [];
    if (await fs.pathExists(changelogPath)) {
        changelog = await fs.readJson(changelogPath);
    }
    changelog.push({
        version_from : latestVersion,
        version_to   : nextVersion,
        source       : 'onboarding_form',
        generated_at : new Date().toISOString(),
        total_changes: changes.length,
        total_conflicts: conflicts.length,
        changes,
    });
    await fs.writeJson(changelogPath, changelog, { spaces: 2 });
    console.log(`   ✅ Changelog updated`);

    return { nextVersion, merged, conflicts, changes };
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
        if (route === 'POST /run') {
            const { account_id, company, transcript, audio } = await parseInput(req);

            if (!account_id || !company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'account_id and company are required' }));
                return;
            }

            console.log(`▶ PIPELINE A: ${company} → ${account_id}`);

            await saveInputAndTranscribe(company, 'demo', transcript, audio);

            console.log(`   🔵 Running Pipeline A...`);
            const { stdout } = await execAsync(
                `node scripts/v1/runDemo.js "${company}/transcripts/demo/transcript.txt" "${account_id}"`,
                { cwd: __dirname, timeout: 300000 }
            );
            console.log(`   ✅ Pipeline A complete`);

            const outputs = await readOutputs(account_id);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pipeline: 'A', ...outputs, logs: stdout }));
            return;
        }

        // ── Pipeline B: Onboarding call → v2 ──
        if (route === 'POST /onboard') {
            const { account_id, company, transcript, audio } = await parseInput(req);

            if (!account_id || !company) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'account_id and company are required' }));
                return;
            }

            console.log(`▶ PIPELINE B: ${company} → ${account_id}`);

            await saveInputAndTranscribe(company, 'onboarding', transcript, audio);

            console.log(`   🟢 Running Pipeline B...`);
            const { stdout } = await execAsync(
                `node scripts/v2/runOnboarding.js "${company}/transcripts/onboarding/transcript.txt" "${account_id}"`,
                { cwd: __dirname, timeout: 300000 }
            );
            console.log(`   ✅ Pipeline B complete`);

            const outputs = await readOutputs(account_id);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pipeline: 'B', ...outputs, logs: stdout }));
            return;
        }

        // ── Pipeline C: Onboarding FORM → v(n+1) ──
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

            const result = await applyFormData(account_id, company, form_data);

            const outputs = await readOutputs(account_id, result.nextVersion);

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
            const account_id = url.searchParams.get('account_id');
            if (!account_id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'account_id query param required' }));
                return;
            }

            const outputs = await readOutputs(account_id);
            if (!outputs) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No outputs for ${account_id}` }));
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