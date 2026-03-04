import 'dotenv/config';
import { extractMemo } from './extractMemo.js';
import { createFullAgent } from './mapAgentSpec.js';
import { getOutputPath } from './generateAgentDraftSpec.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// Usage: node scripts/v1/runDemo.js <transcript-path> [account-id]
//
//   node scripts/v1/runDemo.js bens-electric/transcripts/demo/transcript.txt
//   node scripts/v1/runDemo.js bens-electric/transcripts/demo/transcript.txt demo_001
//   node scripts/v1/runDemo.js "Ben's Electric Solutions/transcripts/demo/transcript.txt" demo_001
//
// Path is relative to inputs/ folder
// ──────────────────────────────────────────────

const transcriptPath = process.argv[2];
const accountId      = process.argv[3] || 'demo_001';
const version        = 'v1';

if (!transcriptPath) {
    console.error('❌ Usage: node scripts/v1/runDemo.js <transcript-relative-path> [account-id]');
    console.error('   Examples:');
    console.error('      node scripts/v1/runDemo.js bens-electric/transcripts/demo/transcript.txt');
    console.error('      node scripts/v1/runDemo.js bens-electric/transcripts/demo/transcript.txt demo_001');
    console.error('      node scripts/v1/runDemo.js "Ben\'s Electric Solutions/transcripts/demo/transcript.txt" demo_001');
    process.exit(1);
}

const fullTranscriptPath = path.resolve(__dirname, '../../inputs', transcriptPath);

async function runDemo() {
    try {
        // Step 1: Read transcript
        console.log('📄 Reading transcript...');
        console.log(`   ${fullTranscriptPath}`);

        if (!await fs.pathExists(fullTranscriptPath)) {
            console.error(`❌ Transcript not found: ${fullTranscriptPath}`);
            console.error(`\nExpected path:`);
            console.error(`   inputs/${transcriptPath}`);
            process.exit(1);
        }

        const transcript = await fs.readFile(fullTranscriptPath, 'utf-8');
        console.log('✅ Transcript loaded\n');

        // Step 2: Extract memo
        console.log('🧠 Extracting memo from transcript...');
        const memo = await extractMemo(transcript);
        console.log('✅ Memo extracted\n');

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

        console.log('\n═══════════════════════════════════════');
        console.log('✅ PIPELINE A (v1) COMPLETE');
        console.log('═══════════════════════════════════════\n');

    } catch (error) {
        console.error('❌ Error running demo:', error.message);
        process.exit(1);
    }
}

runDemo();