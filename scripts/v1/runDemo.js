import 'dotenv/config';
import { extractMemo } from './extractMemo.js';
import { createFullAgent } from './mapAgentSpec.js';
import { getOutputPath } from './generateAgentDraftSpec.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createAsanaReviewTask } from '../../clients/asana_client.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const execAsync  = promisify(exec);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma']);

// ──────────────────────────────────────────────
// Usage: node scripts/v1/runDemo.js <input-path> [account-id]
//
//   <input-path> is relative to inputs/ folder — can be:
//     bens-electric/transcripts/demo/transcript.txt    ← plain transcript
//     bens-electric/audio/demo/recording.mp3           ← any audio format
//
//   Transcription output is saved to:
//     inputs/<company>/transcripts/demo/transcript.txt
// ──────────────────────────────────────────────

const inputArg  = process.argv[2];
const accountId = process.argv[3] || 'demo_001';
const version   = 'v1';

if (!inputArg) {
    console.error('❌ Usage: node scripts/v1/runDemo.js <input-path> [account-id]');
    console.error('   <input-path> relative to inputs/ — .txt or any audio format');
    console.error('   Examples:');
    console.error('      node scripts/v1/runDemo.js bens-electric/transcripts/demo/transcript.txt bens-electric');
    console.error('      node scripts/v1/runDemo.js bens-electric/audio/demo/recording.mp3 bens-electric');
    process.exit(1);
}

const fullInputPath = await (async () => {
    const relToInputs = path.resolve(__dirname, '../../inputs', inputArg);
    const relToRoot   = path.resolve(__dirname, '../../', inputArg);
    if (await fs.pathExists(relToInputs)) return relToInputs;
    if (await fs.pathExists(relToRoot))   return relToRoot;
    return relToInputs; // default — will fail with clear error below
})();

async function runDemo() {
    try {
        // ── Step 1: Resolve transcript (transcribe if audio) ──
        console.log('📄 Resolving input...');
        console.log(`   ${fullInputPath}`);

        if (!await fs.pathExists(fullInputPath)) {
            console.error(`❌ File not found: ${fullInputPath}`);
            console.error(`   Expected: inputs/${inputArg}`);
            process.exit(1);
        }

        const ext = path.extname(fullInputPath).toLowerCase();
        let transcript;

        if (ext === '.txt') {
            // ── Plain transcript — read directly ──
            console.log('   📝 Text transcript detected');
            transcript = await fs.readFile(fullInputPath, 'utf-8');
            console.log('✅ Transcript loaded\n');

        } else if (AUDIO_EXTS.has(ext)) {
            // ── Audio file — transcribe first (skip if transcript already exists) ──
            const parts    = fullInputPath.split(path.sep);
            const audioIdx = parts.findLastIndex(p => p.toLowerCase() === 'audio');
            const afterAudio = parts.slice(audioIdx + 1);
            const session  = afterAudio.length === 1
                ? path.basename(afterAudio[0], path.extname(afterAudio[0]))
                : afterAudio[0];
            const companyDir    = parts.slice(0, audioIdx).join(path.sep);
            const transcriptPath = path.join(companyDir, 'transcripts', session, 'transcript.txt');

            if (await fs.pathExists(transcriptPath)) {
                console.log(`   ⏭️  Transcript already exists, skipping Whisper`);
                console.log(`      ${transcriptPath}`);
            } else {
                console.log(`   🎵 Audio file detected (${ext}) — running Whisper...`);
                await execAsync(
                    `node scripts/transcribeAudio.js "${fullInputPath}"`,
                    { cwd: path.resolve(__dirname, '../../'), timeout: 300000 }
                );
                if (!await fs.pathExists(transcriptPath)) {
                    console.error(`❌ Transcription finished but transcript not found at: ${transcriptPath}`);
                    process.exit(1);
                }
            }

            transcript = await fs.readFile(transcriptPath, 'utf-8');
            console.log(`✅ Transcript ready (${transcript.length} chars)\n`);

        } else {
            console.error(`❌ Unsupported file type: ${ext}`);
            console.error(`   Supported: .txt, ${[...AUDIO_EXTS].join(', ')}`);
            process.exit(1);
        }

        // Step 2: Extract memo
        console.log('🧠 Extracting memo from transcript...');
        const memo = await extractMemo(transcript);
        console.log('✅ Memo extracted\n');

        memo.account_id = accountId;

        // Step 3: Create full agent
        console.log('🤖 Creating full agent...');
        const result = await createFullAgent(accountId, memo, version);
        console.log('✅ Agent created\n');

        // Step 4: Verify output files
        const basePath = getOutputPath(accountId, memo, version);
        const memoPath = path.join(basePath, 'memo.json');
        const specPath = path.join(basePath, 'agentDraftSpec.json');

        console.log('📁 Verifying output files...');
        if (await fs.pathExists(memoPath)) {
            console.log('✅ memo.json saved at:', memoPath);
        } else {
            console.error('❌ memo.json not found at:', memoPath);
        }

        if (await fs.pathExists(specPath)) {
            console.log('✅ agentDraftSpec.json saved at:', specPath);
        } else {
            console.error('❌ agentDraftSpec.json not found at:', specPath);
        }

        // ── Step: Asana Task ──
        console.log('\nSTEP: CREATING ASANA TASK');
        console.log('──────────────────────────');
        const asanaTask = await createAsanaReviewTask({
            accountId,
            companyName    : memo.company_name || accountId,
            nextVersion    : 'v1',
            accountDirName : path.basename(basePath, '/v1'),
            changelogEntry : {
                version_from : null,
                version_to   : 'v1',
                generated_at : new Date().toISOString(),
                changes      : [{ field: 'initial_creation', old: null, new: 'v1 generated from demo call' }],
            },
        });

        if (asanaTask) {
            console.log(`✅ Asana task created: ${asanaTask.gid}`);
        }

        console.log('\n═══════════════════════════════════════');
        console.log('✅ PIPELINE A (v1) COMPLETE');
        console.log('═══════════════════════════════════════\n');

    } catch (error) {
        console.error('❌ Error running demo:', error.message);
        process.exit(1);
    }
}

runDemo();