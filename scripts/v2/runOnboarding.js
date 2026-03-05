import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMemo } from './extractOnboardingUpdate.js';
import { generateAgentDraftSpec } from '../v1/generateAgentDraftSpec.js';
import { createChatCompletion } from '../../clients/groq_client.js';
import { createAsanaReviewTask } from '../../clients/asana_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MERGE_MODEL = 'openai/gpt-oss-120b';

// ──────────────────────────────────────────────
// Slugify company name → folder-safe slug
// ──────────────────────────────────────────────
function slugifyCompany(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ──────────────────────────────────────────────
// Find account dir — by company slug, or account_id prefix
// ──────────────────────────────────────────────
async function findAccountDir(identifier, rootDir) {
    const accountsRoot = path.resolve(rootDir, 'outputs/accounts');
    if (!await fs.pathExists(accountsRoot)) return null;

    const entries = await fs.readdir(accountsRoot);
    const slug = slugifyCompany(identifier);

    // Exact match (raw or slugified)
    const exact = entries.find(e => e === identifier || e === slug);
    if (exact) return path.join(accountsRoot, exact);

    // Prefix match (legacy account_id_ prefix)
    const prefixed = entries.find(e => e.startsWith(identifier + '_') || e.startsWith(slug + '_'));
    if (prefixed) return path.join(accountsRoot, prefixed);

    return null;
}

// ──────────────────────────────────────────────
// 120B LLM merge — base memo + extracted patch
// ──────────────────────────────────────────────
async function llmMergeMemos(currentMemo, patch) {
    console.log(`   🧠 [120B] Merging current memo + onboarding patch...`);

    const messages = [
        {
            role: 'system',
            content: `You are a memo-merge engine. You receive two JSON objects:
1. BASE MEMO — the current account memo
2. PATCH — new facts extracted from an onboarding call

MERGE RULES:
- If patch field is null → keep base value
- If patch field is empty array [] or empty object {} → keep base value
- If patch field has a non-null scalar → OVERWRITE base value
- If patch field has a non-empty array → REPLACE base array entirely
- If patch field has a non-empty object → DEEP MERGE with base object
- DO NOT invent new fields. Output must match the schema exactly.
- DO NOT fabricate values.

Return ONLY valid JSON. No explanation. No markdown fences.

SCHEMA:
{
  "company_name"                : <string | null>,
  "industry_type"               : <string | null>,
  "services_supported"          : [<string>, ...],
  "business_hours"              : {
    "days"     : [<string>, ...],
    "start"    : <string | null>,
    "end"      : <string | null>,
    "timezone" : <string | null>
  },
  "office_address"              : <string | null>,
  "emergency_definition"        : [<string>, ...],
  "emergency_routing_rules"     : {
    "contacts"  : [{ "name": <string>, "phone": <e164>, "priority": <number> }, ...],
    "fallback"  : <string | null>
  },
  "non_emergency_routing_rules" : {
    "action"   : <string | null>,
    "fallback" : <string | null>
  },
  "call_transfer_rules"         : {
    "timeout_seconds" : <number | null>,
    "retries"         : <number | null>,
    "on_fail"         : <string | null>
  },
  "integration_constraints"     : <string | null>,
  "after_hours_flow_summary"    : <string | null>,
  "office_hours_flow_summary"   : <string | null>,
  "questions_or_unknowns"       : [<string>, ...],
  "notes"                       : <string | null>
}`,
        },
        {
            role: 'user',
            content: `BASE MEMO:\n${JSON.stringify(currentMemo, null, 2)}\n\nPATCH:\n${JSON.stringify(patch, null, 2)}`,
        },
    ];

    const raw = await createChatCompletion(messages, MERGE_MODEL, 4096);
    const cleaned = raw.replace(/```json\n?|```/g, '').trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        console.error(`   ❌ Failed to parse LLM merge output. Raw:\n${cleaned}`);
        throw new Error(`LLM merge returned invalid JSON: ${e.message}`);
    }
    return parsed;
}

// ──────────────────────────────────────────────
// Changelog diff — deep compare old vs new memo
// ──────────────────────────────────────────────
function generateChangelog(oldMemo, newMemo, versionFrom, versionTo) {
    const changes = [];
    const ALL_KEYS = [...new Set([...Object.keys(oldMemo), ...Object.keys(newMemo)])];

    for (const key of ALL_KEYS) {
        const oldVal = oldMemo[key];
        const newVal = newMemo[key];

        // Skip internal bookkeeping fields
        if (key === 'account_id') continue;

        const oldStr = JSON.stringify(oldVal ?? null);
        const newStr = JSON.stringify(newVal ?? null);

        if (oldStr === newStr) continue;

        changes.push({
            field  : key,
            before : oldVal ?? null,
            after  : newVal ?? null,
            note   : oldVal == null
                ? 'Field populated for the first time'
                : newVal == null
                    ? 'Field cleared'
                    : 'Field updated',
        });
    }

    return {
        version_from : versionFrom,
        version_to   : versionTo,
        generated_at : new Date().toISOString(),
        total_changes: changes.length,
        changes,
    };
}

// ──────────────────────────────────────────────
// Upsert per-account changelog in /changelog/
// ──────────────────────────────────────────────
async function upsertAccountChangelog(changelogDir, accountId, changelogEntry) {
    await fs.ensureDir(changelogDir);
    const changelogPath = path.join(changelogDir, `${accountId}.json`);

    let existing = { account_id: accountId, history: [] };
    if (await fs.pathExists(changelogPath)) {
        try {
            const raw = await fs.readJson(changelogPath);
            // Handle both formats: { account_id, history: [] } OR legacy plain array
            if (Array.isArray(raw)) {
                existing = { account_id: accountId, history: raw };
            } else if (raw && Array.isArray(raw.history)) {
                existing = raw;
            }
        } catch {
            console.warn(`   ⚠️  Could not parse existing changelog, starting fresh`);
        }
    }

    // Overwrite entry for this version_to if it already exists (idempotent)
    const idx = existing.history.findIndex(e => e.version_to === changelogEntry.version_to);
    if (idx >= 0) {
        existing.history[idx] = changelogEntry;
        console.log(`   🔄 Changelog entry for ${changelogEntry.version_to} replaced (idempotent)`);
    } else {
        existing.history.push(changelogEntry);
    }

    await fs.writeJson(changelogPath, existing, { spaces: 2 });
    return changelogPath;
}

// ──────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────
async function main() {
    const transcriptArg = process.argv[2];   // relative to inputs/ OR absolute
    const accountId     = process.argv[3] || 'demo_001';
    const companyArg    = process.argv[4] || null;   // company slug passed by server.js

    // ── Guard: transcript arg required ──
    if (!transcriptArg) {
        console.error('❌ Usage: node runOnboarding.js <transcript_path> <account_id> [company_slug]');
        console.error('   transcript_path: relative to inputs/ OR absolute path');
        process.exit(1);
    }

    // ── Resolve transcript path ──
    const rootDir = path.resolve(__dirname, '../../');
    let fullTranscriptPath;

    if (path.isAbsolute(transcriptArg)) {
        fullTranscriptPath = transcriptArg;
    } else {
        // Could be relative to inputs/ or relative to CWD
        const relToInputs = path.resolve(rootDir, 'inputs', transcriptArg);
        const relToCwd    = path.resolve(rootDir, transcriptArg);
        if (await fs.pathExists(relToInputs)) {
            fullTranscriptPath = relToInputs;
        } else if (await fs.pathExists(relToCwd)) {
            fullTranscriptPath = relToCwd;
        } else {
            console.error(`❌ Transcript not found at:`);
            console.error(`   - ${relToInputs}`);
            console.error(`   - ${relToCwd}`);
            process.exit(1);
        }
    }

    // ── Guard: only .txt allowed here (audio transcription is done by server.js) ──
    const ext = path.extname(fullTranscriptPath).toLowerCase();
    if (ext !== '.txt') {
        console.error(`❌ runOnboarding.js expects a .txt transcript. Got: "${ext}"`);
        console.error(`   Audio transcription should be done before calling this script.`);
        process.exit(1);
    }

    // ── Resolve account directory ──
    const changelogDir = path.resolve(rootDir, 'changelog');
    const accountsRoot = path.resolve(rootDir, 'outputs/accounts');

    // Prefer company slug (provided by server.js), fallback to account_id search
    let accountDir;
    if (companyArg) {
        const direct = path.join(accountsRoot, companyArg);
        accountDir = await fs.pathExists(direct) ? direct : await findAccountDir(companyArg, rootDir);
    } else {
        accountDir = await findAccountDir(accountId, rootDir);
    }

    if (!accountDir || !await fs.pathExists(accountDir)) {
        console.error(`❌ No existing account output found for "${companyArg || accountId}"`);
        console.error(`   Run Pipeline A (demo) first to create the v1 baseline.`);
        console.error(`   Expected under: ${accountsRoot}`);
        process.exit(1);
    }

    // ── Guard: v1 memo must exist ──
    const v1MemoPath = path.join(accountDir, 'v1', 'memo.json');
    if (!await fs.pathExists(v1MemoPath)) {
        console.error(`❌ v1 memo.json not found at: ${v1MemoPath}`);
        console.error(`   Run Pipeline A first.`);
        process.exit(1);
    }

    console.log('═══════════════════════════════════════════');
    console.log('🔄 PIPELINE B — ONBOARDING UPDATE');
    console.log('═══════════════════════════════════════════');
    console.log(`📂 Account:    ${accountId} → ${path.basename(accountDir)}`);
    console.log(`📄 Transcript: ${fullTranscriptPath}`);
    console.log('═══════════════════════════════════════════\n');

    // Fixed versioning: always v1 → v2
    const currentVersion = 'v1';
    const nextVersion    = 'v2';
    const nextDir        = path.join(accountDir, nextVersion);
    console.log(`📌 Base: ${currentVersion} → Target: ${nextVersion} (overwrite if exists)\n`);

    // ──────────────────────────────────────────
    // STEP 1: Load v1 memo
    // ──────────────────────────────────────────
    console.log('STEP 1: LOADING CURRENT MEMO');
    console.log('─────────────────────────────');
    const currentMemo = await fs.readJson(v1MemoPath);
    console.log(`   ✅ Loaded v1 memo for "${currentMemo.company_name || accountId}"\n`);

    // ──────────────────────────────────────────
    // STEP 2: Extract patch from onboarding transcript
    // ──────────────────────────────────────────
    console.log('STEP 2: EXTRACTING ONBOARDING FACTS');
    console.log('─────────────────────────────────────');
    const transcript = await fs.readFile(fullTranscriptPath, 'utf-8');

    if (!transcript.trim()) {
        console.error(`❌ Transcript file is empty: ${fullTranscriptPath}`);
        process.exit(1);
    }

    let patch;
    try {
        patch = await extractMemo(transcript);
    } catch (err) {
        console.error(`❌ Extraction failed: ${err.message}`);
        process.exit(1);
    }
    console.log(`   ✅ Patch extracted\n`);

    // Save raw patch for debugging/audit
    await fs.ensureDir(nextDir);
    await fs.writeJson(path.join(nextDir, 'onboarding_update.json'), patch, { spaces: 2 });
    console.log(`   💾 Raw patch saved → ${nextVersion}/onboarding_update.json\n`);

    // ──────────────────────────────────────────
    // STEP 3: LLM merge — base + patch → new memo
    // ──────────────────────────────────────────
    console.log('STEP 3: MERGING MEMOS (LLM)');
    console.log('─────────────────────────────');
    let newMemo;
    try {
        newMemo = await llmMergeMemos(currentMemo, patch);
    } catch (err) {
        console.error(`❌ LLM merge failed: ${err.message}`);
        process.exit(1);
    }

    // Preserve account_id
    newMemo.account_id = accountId;

    await fs.writeJson(path.join(nextDir, 'memo.json'), newMemo, { spaces: 2 });
    console.log(`   ✅ Merged memo saved → ${nextVersion}/memo.json\n`);

    // ──────────────────────────────────────────
    // STEP 4: Generate changelog diff
    // ──────────────────────────────────────────
    console.log('STEP 4: GENERATING CHANGELOG');
    console.log('─────────────────────────────');
    const changelogEntry = generateChangelog(currentMemo, newMemo, currentVersion, nextVersion);
    changelogEntry.source = 'onboarding_call';

    // Per-version changes.json
    await fs.writeJson(path.join(nextDir, 'changes.json'), changelogEntry, { spaces: 2 });
    console.log(`   ✅ changes.json saved (${changelogEntry.total_changes} change(s))\n`);

    // Global per-account changelog
    const globalChangelogPath = await upsertAccountChangelog(changelogDir, accountId, changelogEntry);
    console.log(`   ✅ Global changelog updated → ${globalChangelogPath}\n`);

    // ──────────────────────────────────────────
    // STEP 5: Regenerate agent draft spec
    // ──────────────────────────────────────────
    console.log('STEP 5: REGENERATING AGENT DRAFT SPEC');
    console.log('──────────────────────────────────────');
    let spec;
    try {
        spec = generateAgentDraftSpec(accountId, newMemo, nextVersion);
    } catch (err) {
        console.error(`❌ Agent spec generation failed: ${err.message}`);
        process.exit(1);
    }

    // Carry forward agent_id and llm_id from v1 if present
    const v1Dir = path.join(accountDir, currentVersion);
    const v1SpecPath = path.join(v1Dir, 'agentDraftSpec.json');
    if (await fs.pathExists(v1SpecPath)) {
        try {
            const v1Spec = await fs.readJson(v1SpecPath);
            if (v1Spec.agent_id) spec.agent_id = v1Spec.agent_id;
            if (v1Spec.llm_id)   spec.llm_id   = v1Spec.llm_id;
            console.log(`   🔗 Carried forward agent_id + llm_id from v1`);
        } catch {
            console.warn(`   ⚠️  Could not read v1 agentDraftSpec.json for ID carryover`);
        }
    }

    spec.version = nextVersion;
    await fs.writeJson(path.join(nextDir, 'agentDraftSpec.json'), spec, { spaces: 2 });
    console.log(`   ✅ agentDraftSpec.json saved → ${nextVersion}/agentDraftSpec.json\n`);

    // ──────────────────────────────────────────
    // STEP 6: Create Asana review task
    // ──────────────────────────────────────────
    console.log('STEP 6: CREATING ASANA TASK');
    console.log('────────────────────────────');
    const asanaTask = await createAsanaReviewTask({
        accountId,
        companyName    : newMemo.company_name || accountId,
        nextVersion,
        accountDirName : path.basename(accountDir),
        changelogEntry,
    });
    if (asanaTask) {
        console.log(`   ✅ Asana task created: ${asanaTask.gid}`);
    } else {
        console.log(`   ⚠️  Asana skipped (token not configured)`);
    }
    console.log();

    // ──────────────────────────────────────────
    // DONE
    // ──────────────────────────────────────────
    console.log('═══════════════════════════════════════════');
    console.log('✅ PIPELINE B COMPLETE');
    console.log('═══════════════════════════════════════════');
    console.log(`📁 Output dir : ${nextDir}`);
    console.log(`📝 memo.json`);
    console.log(`📝 agentDraftSpec.json`);
    console.log(`📝 onboarding_update.json  (raw patch)`);
    console.log(`📝 changes.json            (diff v1→v2)`);
    console.log(`📝 ${globalChangelogPath.replace(rootDir, '')}`);
    console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('\n❌ FATAL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});