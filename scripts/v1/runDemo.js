import 'dotenv/config';  // ✅ add this as first line
import { extractMemo } from './extractMemo.js';
import { createFullAgent } from './mapAgentSpec.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const transcriptPath = path.join(__dirname, '../../inputs/transcripts/demo/demo_video_transcript.txt');
const accountId = 'demo_001';

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

        // Step 3: Create full agent (generates agentDraftSpec + calls Retell)
        console.log('\n🤖 Creating full agent...');
        const result = await createFullAgent(accountId, memo);
        console.log('✅ Agent created:', JSON.stringify(result, null, 2));

        // Step 4: Verify output files exist
        const outputPath = path.join(__dirname, `../../outputs/${accountId}/v1/agentDraftSpec.json`);
        const fileExists = await fs.pathExists(outputPath);
        if (fileExists) {
            const savedSpec = await fs.readJson(outputPath);
            console.log('\n📁 agentDraftSpec.json saved at:', outputPath);
            console.log('📋 Saved spec:', JSON.stringify(savedSpec, null, 2));
        } else {
            console.error('❌ agentDraftSpec.json not found at:', outputPath);
        }

    } catch (error) {
        console.error('❌ Error running demo:', error);
        throw error;
    }
}

runDemo();