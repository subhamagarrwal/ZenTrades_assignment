import 'dotenv/config';
import { extractMemo } from './extractMemo.js';
import { createFullAgent } from './mapAgentSpec.js';
import { getOutputPath } from './generateAgentDraftSpec.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const transcriptPath = path.resolve(__dirname, '../../transcription_output/demo_audio/transcript.txt');
const accountId = 'demo_001';
const version = 'v1';

async function runDemo() {
    try {
        // Step 1: Read transcript
        console.log('📄 Reading transcript...');
        const transcript = await fs.readFile(transcriptPath, 'utf-8');
        console.log('✅ Transcript loaded');

        // Step 2: Extract memo
        console.log('\n🧠 Extracting memo from transcript...');
        const memo = await extractMemo(transcript);
        console.log('✅ Memo extracted:', JSON.stringify(memo, null, 2));

        // Step 3: Create full agent
        console.log('\n🤖 Creating full agent...');
        const result = await createFullAgent(accountId, memo, version);
        console.log('✅ Agent created:', JSON.stringify(result, null, 2));

        // Step 4: Verify output files
        const basePath = getOutputPath(accountId, memo, version);
        const memoPath = path.join(basePath, 'memo.json');
        const specPath = path.join(basePath, 'agentDraftSpec.json');

        console.log('\n📁 Verifying output files...');
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

    } catch (error) {
        console.error('❌ Error running demo:', error.message);
        process.exit(1);
    }
}

// ✅ Actually call the function
runDemo();