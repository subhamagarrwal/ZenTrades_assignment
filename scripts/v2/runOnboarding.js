import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMemo } from './extractOnboardingUpdate.js';
import { generateAgentDraftSpec } from '../v1/generateAgentDraftSpec.js';
import { createChatCompletion } from '../../clients/groq_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MERGE_MODEL = 'openai/gpt-oss-120b';  // GPT-OSS-120B equiv — best for complex reasoning and JSON manipulation

// ──────────────────────────────────────────────
// Usage: node scripts/v2/runOnboarding.js <company-folder> <account-id>
//
//   node scripts/v2/runOnboarding.js fireflies demo_001
//
// Expects transcript at:
//   inputs/<company>/transcripts/onboarding/transcript.txt
//
// Expects v1 outputs at:
//   outputs/accounts/<account-id>_<slug>/v1/memo.json
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// 120B LLM merge: current memo + onboarding patch → next memo
// ──────────────────────────────────────────────
async function llmMergeMemos(currentMemo, patch) {
    console.log(`   🧠 [120B] Merging current memo + onboarding patch...`);

    const messages = [
        {
            role: 'system',
            content: `You are a memo-merge engine. You receive two JSON objects:
1. BASE MEMO — the current account memo
2. PATCH — new facts extracted from an onboarding call

Your job: produce a MERGED memo using these exact rules:

MERGE RULES:
- If patch field is null → keep base value (do NOT overwrite with null)
- If patch field is empty array [] → keep base value
- If patch field has a non-null scalar → OVERWRITE base value
- If patch field has a non-empty array → REPLACE base array entirely
- DO NOT invent new fields. Output must match the schema exactly.
- DO NOT fabricate values. Only use what is in base or patch.

Return ONLY valid JSON. No explanation. No markdown fences.

SCHEMA (tone-format):
{
  company_name             : <string | null>,
  industry_type            : <string | null>,
  services_mentioned       : [<string>, ...],
  timezone                 : <string | null>,
  business_hours           : <string | null>,
  emergency_definition     : <string | null>,
  routing_rules            : [<e164_phone_string>, ...],
  integration_constraints  : <string | null>,
  transfer_timeout_seconds : <number | null>,
  address                  : <string | null>,
  questions_or_unknowns    : [<string>, ...]
}`,
        },
        {
            role: 'user',
            content: `BASE MEMO:\n${JSON.stringify(currentMemo, null, 2)}\n\nPATCH (onboarding update):\n${JSON.stringify(patch, null, 2)}`,
        },
    ];

    const raw = await createChatCompletion(messages, MERGE_MODEL, 4096);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
}

// ──────────────────────────────────────────────
// Generate changelog diff
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
// Upsert changelog for account
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
// Find account dir by account_id prefix
// Handles: outputs/accounts/demo_001_some-company/
// ──────────────────────────────────────────────
async function findAccountDir(accountId) {
    const accountsRoot = path.resolve(__dirname, '../../outputs/accounts');

    if (!await fs.pathExists(accountsRoot)) return null;

    const entries = await fs.readdir(accountsRoot);

    // Exact match first
    const exact = entries.find(e => e === accountId);
    if (exact) return path.join(accountsRoot, exact);

    // Prefix match: demo_001 matches demo_001_bens-electric
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
// MAIN
// ──────────────────────────────────────────────
async function main() {
    const companyFolder = process.argv[2];
    const accountId     = process.argv[3];

    if (!companyFolder || !accountId) {
        console.error('❌ Usage: node scripts/v2/runOnboarding.js <company-folder> <account-id>');
        console.error('   Example: node scripts/v2/runOnboarding.js fireflies demo_001');
        process.exit(1);
    }

    const transcriptPath = path.resolve(
        __dirname, '../../inputs', companyFolder, 'transcripts/onboarding/transcript.txt'
    );

    if (!await fs.pathExists(transcriptPath)) {
        console.error(`❌ Transcript not found: ${transcriptPath}`);
        console.error(`   Run transcription first:`);
        console.error(`   node scripts/transcribeAudio.js inputs/${companyFolder}/audio/onboarding.mp3`);
        process.exit(1);
    }

    const accountDir = await findAccountDir(accountId);
    if (!accountDir) {
        console.error(`❌ Account not found for: ${accountId}`);
        console.error(`   Run Pipeline A (v1) first:`);
        console.error(`   node scripts/v1/runDemo.js ${companyFolder} ${accountId}`);
        process.exit(1);
    }

    const changelogDir = path.resolve(__dirname, '../../changelog');

    console.log('═══════════════════════════════════════════');
    console.log('🔄 PIPELINE B — ONBOARDING UPDATE');
    console.log('═══════════════════════════════════════════');
    console.log(`📂 Company:    ${companyFolder}`);
    console.log(`📂 Account:    ${accountId} → ${path.basename(accountDir)}`);
    console.log(`📄 Transcript: ${transcriptPath}`);
    console.log('═══════════════════════════════════════════\n');

    // ── Detect versions ──
    const currentVersion = await detectCurrentVersion(accountDir);
    const nextVersionNum = parseInt(currentVersion.replace('v', ''), 10) + 1;
    const nextVersion    = `v${nextVersionNum}`;
    console.log(`📌 Current: ${currentVersion} → Next: ${nextVersion}\n`);

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

    // ── Step 2: 70B → extract facts → Scout → patch ──
    console.log('STEP 2: EXTRACTING ONBOARDING PATCH');
    console.log('─────────────────────────────────────');
    const transcript = await fs.readFile(transcriptPath, 'utf-8');
    const patch = await extractMemo(transcript);

    const nextVersionDir = path.join(accountDir, nextVersion);
    await fs.ensureDir(nextVersionDir);

    const patchPath = path.join(nextVersionDir, 'onboarding_update.json');
    await fs.writeJson(patchPath, patch, { spaces: 2 });
    console.log(`✅ Patch saved → ${patchPath}\n`);

    // ── Step 3: Scout → LLM merge ──
    console.log('STEP 3: LLM MERGE (current + patch → next)');
    console.log('────────────────────────────────────────────');
    const nextMemo = await llmMergeMemos(currentMemo, patch);

    const nextMemoPath = path.join(nextVersionDir, 'memo.json');
    await fs.writeJson(nextMemoPath, nextMemo, { spaces: 2 });
    console.log(`✅ Merged memo saved → ${nextMemoPath}\n`);

    // ── Step 4: Regenerate agent spec ──
    console.log('STEP 4: REGENERATING AGENT SPEC');
    console.log('────────────────────────────────');
    const nextSpec = await generateAgentDraftSpec(accountId, nextMemo, nextVersion);

    const nextSpecPath = path.join(nextVersionDir, 'agentDraftSpec.json');
    await fs.writeJson(nextSpecPath, nextSpec, { spaces: 2 });
    console.log(`✅ Agent spec regenerated → ${nextSpecPath}\n`);

    // ── Step 5: Changelog ──
    console.log('STEP 5: GENERATING CHANGELOG');
    console.log('─────────────────────────────');
    const changelogEntry = generateChangelog(currentMemo, nextMemo, currentVersion, nextVersion);

    const changesPath = path.join(nextVersionDir, 'changes.json');
    await fs.writeJson(changesPath, changelogEntry, { spaces: 2 });
    console.log(`✅ changes.json → ${changesPath}`);

    const globalChangelogPath = await upsertAccountChangelog(changelogDir, accountId, changelogEntry);
    console.log(`✅ Global changelog → ${globalChangelogPath}\n`);

    // ── Step 6: Copy IDs ──
    console.log('STEP 6: PROPAGATING IDs');
    console.log('────────────────────────');
    for (const idFile of ['agent_id.json', 'llm_id.json']) {
        const src  = path.join(accountDir, currentVersion, idFile);
        const dest = path.join(nextVersionDir, idFile);
        if (await fs.pathExists(src)) {
            await fs.copy(src, dest);
            console.log(`✅ Copied ${idFile}`);
        }
    }

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════');
    console.log('✅ PIPELINE B COMPLETE');
    console.log('═══════════════════════════════════════════');
    console.log(`📁 ${path.basename(accountDir)}/`);
    console.log(`   ${currentVersion}/  (unchanged)`);
    console.log(`   ${nextVersion}/`);
    console.log(`      ├ memo.json`);
    console.log(`      ├ agentDraftSpec.json`);
    console.log(`      ├ onboarding_update.json`);
    console.log(`      ├ changes.json`);
    console.log(`      ├ agent_id.json`);
    console.log(`      └ llm_id.json`);
    console.log(`📋 changelog/${accountId}.json`);
    console.log('═══════════════════════════════════════════');

    console.log(`\n🏗  MODEL PIPELINE:`);
    console.log(`   70B   → chunk fact extraction`);
    console.log(`   Scout → patch composition`);
    console.log(`   Scout → memo merge`);

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