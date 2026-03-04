import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMemo } from './extractOnboardingUpdate.js';
import { generateAgentDraftSpec, getOutputPath } from '../v1/generateAgentDraftSpec.js';
import { createFullAgent } from '../v1/mapAgentSpec.js';
import { createChatCompletion } from '../../clients/groq_client.js';
import { createAsanaReviewTask } from '../../clients/asana_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MERGE_MODEL = 'openai/gpt-oss-120b';

// ──────────────────────────────────────────────
// Find account dir by account_id prefix
// ──────────────────────────────────────────────
async function findAccountDir(accountId, rootDir) {
    const accountsRoot = path.resolve(rootDir, 'outputs/accounts');
    if (!await fs.pathExists(accountsRoot)) return null;

    const entries = await fs.readdir(accountsRoot);
    const exact = entries.find(e => e === accountId);
    if (exact) return path.join(accountsRoot, exact);

    const prefixed = entries.find(e => e.startsWith(accountId + '_'));
    if (prefixed) return path.join(accountsRoot, prefixed);

    return null;
}

// ──────────────────────────────────────────────
// Detect latest version
// ──────────────────────────────────────────────
async function detectCurrentVersion(accountDir) {
    const entries = await fs.readdir(accountDir);
    const versions = entries
        .filter(e => /^v\d+$/.test(e))
        .map(e => parseInt(e.replace('v', ''), 10))
        .sort((a, b) => b - a);
    return versions.length > 0 ? `v${versions[0]}` : 'v1';
}

// ──────────────────────────────────────────────
// 120B merge
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
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
}

// ──────────────────────────────────────────────
// Changelog diff
// ──────────────────────────────────────────────
function generateChangelog(oldMemo, newMemo, versionFrom, versionTo) {
    const changes = [];
    const ALL_KEYS = Object.keys({ ...oldMemo, ...newMemo });

    for (const key of ALL_KEYS) {
        const oldVal = oldMemo[key] ?? null;
        const newVal = newMemo[key] ?? null;
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
            changes.push({ field: key, old: oldVal, new: newVal });
        }
    }

    return {
        version_from: versionFrom,
        version_to: versionTo,
        generated_at: new Date().toISOString(),
        changes,
    };
}

// ──────────────────────────────────────────────
// Upsert changelog
// ──────────────────────────────────────────────
async function upsertAccountChangelog(changelogDir, accountId, changelogEntry) {
    await fs.ensureDir(changelogDir);
    const changelogPath = path.join(changelogDir, `${accountId}.json`);

    let existing = { account_id: accountId, history: [] };
    if (await fs.pathExists(changelogPath)) {
        existing = await fs.readJson(changelogPath);
    }

    const idx = existing.history.findIndex(e => e.version_to === changelogEntry.version_to);
    if (idx >= 0) {
        existing.history[idx] = changelogEntry;
        console.log(`   🔄 Updated existing changelog entry for ${changelogEntry.version_to}`);
    } else {
        existing.history.push(changelogEntry);
        console.log(`   ➕ Appended new changelog entry for ${changelogEntry.version_to}`);
    }

    await fs.writeJson(changelogPath, existing, { spaces: 2 });
    return changelogPath;
}

// ──────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────
async function main() {
    const transcriptPath = process.argv[2];
    const accountId      = process.argv[3] || 'demo_001';

    if (!transcriptPath) {
        console.error('❌ Usage: node scripts/v2/runOnboarding.js <transcript-relative-path> [account-id]');
        console.error('   Example: node scripts/v2/runOnboarding.js bens-electric/transcripts/onboarding/transcript.txt demo_001');
        process.exit(1);
    }

    const fullTranscriptPath = path.resolve(__dirname, '../../inputs', transcriptPath);

    if (!await fs.pathExists(fullTranscriptPath)) {
        console.error(`❌ Transcript not found: ${fullTranscriptPath}`);
        process.exit(1);
    }

    const rootDir      = path.resolve(__dirname, '../../');
    const changelogDir = path.resolve(rootDir, 'changelog');
    const accountDir   = await findAccountDir(accountId, rootDir);

    if (!accountDir) {
        console.error(`❌ Account not found for: ${accountId}`);
        console.error(`   Run Pipeline A first:`);
        console.error(`   node scripts/v1/runDemo.js bens-electric/transcripts/demo/transcript.txt ${accountId}`);
        process.exit(1);
    }

    console.log('═══════════════════════════════════════════');
    console.log('🔄 PIPELINE B — ONBOARDING UPDATE');
    console.log('═══════════════════════════════════════════');
    console.log(`📂 Account:    ${accountId} → ${path.basename(accountDir)}`);
    console.log(`📄 Transcript: ${fullTranscriptPath}`);
    console.log('═══════════════════════════════════════════\n');

    // ── Fixed versions: always read v1, write v2 ──
    const currentVersion = 'v1';
    const nextVersion    = 'v2';
    console.log(`📌 Base: ${currentVersion} → Target: ${nextVersion} (overwrite if exists)\n`);

    // ── Step 1: Load current memo ──
    console.log('STEP 1: LOADING CURRENT MEMO');
    console.log('─────────────────────────────');
    const currentMemoPath = path.join(accountDir, currentVersion, 'memo.json');

    if (!await fs.pathExists(currentMemoPath)) {
        console.error(`❌ memo.json not found at: ${currentMemoPath}`);
        process.exit(1);
    }

    const currentMemo = await fs.readJson(currentMemoPath);
    console.log(`✅ Loaded ${currentVersion} memo\n`);

    // ── Step 2: Extract onboarding patch ──
    console.log('STEP 2: EXTRACTING ONBOARDING PATCH');
    console.log('─────────────────────────────────────');
    const transcript = await fs.readFile(fullTranscriptPath, 'utf-8');
    const patch = await extractMemo(transcript);

    const nextVersionDir = path.join(accountDir, nextVersion);
    await fs.ensureDir(nextVersionDir);

    const patchPath = path.join(nextVersionDir, 'onboarding_update.json');
    await fs.writeJson(patchPath, patch, { spaces: 2 });
    console.log(`✅ Patch saved → ${patchPath}\n`);

    // ── Step 3: LLM merge ──
    console.log('STEP 3: LLM MERGE (current + patch → next)');
    console.log('────────────────────────────────────────────');
    const nextMemo = await llmMergeMemos(currentMemo, patch);
    nextMemo.account_id = accountId;

    const nextMemoPath = path.join(nextVersionDir, 'memo.json');
    await fs.writeJson(nextMemoPath, nextMemo, { spaces: 2 });
    console.log(`✅ Merged memo saved → ${nextMemoPath}\n`);

    // ── Step 4: Copy IDs from previous version FIRST ──
    console.log('STEP 4: PROPAGATING IDs FROM PREVIOUS VERSION');
    console.log('───────────────────────────────────────────────');
    for (const idFile of ['agent_id.json', 'llm_id.json']) {
        const src  = path.join(accountDir, currentVersion, idFile);
        const dest = path.join(nextVersionDir, idFile);
        if (await fs.pathExists(src)) {
            await fs.copy(src, dest);
            console.log(`   ✅ Copied ${idFile} → ${nextVersion}/`);
        }
    }
    console.log('');

    // ── Step 5: Upsert Retell agent with new spec ──
    console.log('STEP 5: UPSERTING RETELL AGENT WITH v2 SPEC');
    console.log('─────────────────────────────────────────────');
    // createFullAgent checks for existing agent_id.json/llm_id.json
    // and UPDATES instead of creating new ones
    const result = await createFullAgent(accountId, nextMemo, nextVersion);
    console.log('✅ Retell agent updated with new configuration\n');

    // ── Step 6: Changelog ──
    console.log('STEP 6: GENERATING CHANGELOG');
    console.log('─────────────────────────────');
    const changelogEntry = generateChangelog(currentMemo, nextMemo, currentVersion, nextVersion);

    const changesPath = path.join(nextVersionDir, 'changes.json');
    await fs.writeJson(changesPath, changelogEntry, { spaces: 2 });
    console.log(`✅ changes.json → ${changesPath}`);

    const globalChangelogPath = await upsertAccountChangelog(changelogDir, accountId, changelogEntry);
    console.log(`✅ Global changelog → ${globalChangelogPath}\n`);

    // ── Step 7: Asana Task ──
    console.log('STEP 7: CREATING ASANA REVIEW TASK');
    console.log('────────────────────────────────────');
    const asanaTask = await createAsanaReviewTask({
        accountId,
        companyName    : nextMemo.company_name || accountId,
        nextVersion,
        accountDirName : path.basename(accountDir),
        changelogEntry,
    });

    if (asanaTask) {
        console.log(`✅ Asana task created: ${asanaTask.gid}`);
        console.log(`   🔗 https://app.asana.com/0/${process.env.ASANA_PROJECT_GID}/${asanaTask.gid}`);
    }

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════');
    console.log('✅ PIPELINE B COMPLETE');
    console.log('═══════════════════════════════════════════');
    console.log(`📁 ${path.basename(accountDir)}/`);
    console.log(`   v1/  (unchanged)`);
    console.log(`   v2/`);
    console.log(`      ├ memo.json`);
    console.log(`      ├ agentDraftSpec.json`);
    console.log(`      ├ onboarding_update.json`);
    console.log(`      ├ changes.json`);
    console.log(`      ├ agent_id.json  (reused from v1)`);
    console.log(`      └ llm_id.json    (reused from v1)`);
    console.log(`📋 changelog/${accountId}.json`);
    if (asanaTask) {
        console.log(`📋 Asana: https://app.asana.com/0/${process.env.ASANA_PROJECT_GID}/${asanaTask.gid}`);
    }
    console.log('═══════════════════════════════════════════');

    if (changelogEntry.changes.length > 0) {
        console.log(`\n📝 ${changelogEntry.changes.length} field(s) changed:`);
        for (const c of changelogEntry.changes) {
            console.log(`   • ${c.field}: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`);
        }
    } else {
        console.log('\nℹ️  No fields changed.');
    }
    console.log('');
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});