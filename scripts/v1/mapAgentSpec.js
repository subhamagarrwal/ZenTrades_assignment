import 'dotenv/config';
import Retell from 'retell-sdk';
import fs from 'fs-extra';
import path from 'path';
import { generateAgentDraftSpec, getOutputPath, buildSystemPrompt } from './generateAgentDraftSpec.js';

const retellClient = new Retell({ apiKey: process.env.RETELL_API_KEY });

// ──────────────────────────────────────────────
// Upsert LLM: update if exists, create if not
// ──────────────────────────────────────────────
async function upsertRetellLlm(basePath, systemPrompt) {
    const llmIdPath = path.join(basePath, 'llm_id.json');

    // Check if LLM already exists
    if (await fs.pathExists(llmIdPath)) {
        const { llm_id } = await fs.readJson(llmIdPath);

        try {
            const updated = await retellClient.llm.update(llm_id, {
                general_prompt: systemPrompt,
            });
            console.log(`🔄 LLM updated: ${llm_id}`);
            return llm_id;
        } catch (err) {
            console.warn(`⚠️  LLM update failed (${llm_id}), creating new one: ${err.message}`);
        }
    }

    // Also check previous versions
    const accountDir = path.dirname(basePath);
    const existingLlmId = await findExistingId(accountDir, 'llm_id.json');

    if (existingLlmId) {
        try {
            const updated = await retellClient.llm.update(existingLlmId, {
                general_prompt: systemPrompt,
            });
            console.log(`🔄 LLM updated (from previous version): ${existingLlmId}`);
            await fs.writeJson(llmIdPath, { llm_id: existingLlmId }, { spaces: 2 });
            return existingLlmId;
        } catch (err) {
            console.warn(`⚠️  LLM update failed (${existingLlmId}), creating new one: ${err.message}`);
        }
    }

    // Create new
    const llm = await retellClient.llm.create({
        model: 'gpt-4.1',
        general_prompt: systemPrompt,
    });

    const llmId = llm.llm_id;
    await fs.writeJson(llmIdPath, { llm_id: llmId }, { spaces: 2 });
    console.log(`✅ LLM created: ${llmId}`);
    return llmId;
}

// ──────────────────────────────────────────────
// Upsert Agent: update if exists, create if not
// ──────────────────────────────────────────────
async function upsertRetellAgent(basePath, llmId, agentName) {
    const agentIdPath = path.join(basePath, 'agent_id.json');

    // Check if agent already exists
    if (await fs.pathExists(agentIdPath)) {
        const { agent_id } = await fs.readJson(agentIdPath);

        try {
            const updated = await retellClient.agent.update(agent_id, {
                response_engine: { type: 'retell-llm', llm_id: llmId },
                agent_name: agentName,
            });
            console.log(`🔄 Agent updated: ${agent_id}`);
            return agent_id;
        } catch (err) {
            console.warn(`⚠️  Agent update failed (${agent_id}), creating new one: ${err.message}`);
        }
    }

    // Also check previous versions
    const accountDir = path.dirname(basePath);
    const existingAgentId = await findExistingId(accountDir, 'agent_id.json');

    if (existingAgentId) {
        try {
            const updated = await retellClient.agent.update(existingAgentId, {
                response_engine: { type: 'retell-llm', llm_id: llmId },
                agent_name: agentName,
            });
            console.log(`🔄 Agent updated (from previous version): ${existingAgentId}`);
            await fs.writeJson(agentIdPath, { agent_id: existingAgentId }, { spaces: 2 });
            return existingAgentId;
        } catch (err) {
            console.warn(`⚠️  Agent update failed (${existingAgentId}), creating new one: ${err.message}`);
        }
    }

    // Create new
    const agent = await retellClient.agent.create({
        response_engine: { type: 'retell-llm', llm_id: llmId },
        agent_name: agentName,
        voice_id: '11labs-Adrian',
    });

    const agentId = agent.agent_id;
    await fs.writeJson(agentIdPath, { agent_id: agentId }, { spaces: 2 });
    console.log(`✅ Agent created: ${agentId}`);
    return agentId;
}

// ──────────────────────────────────────────────
// Search previous versions for existing ID
// ──────────────────────────────────────────────
async function findExistingId(accountDir, filename) {
    if (!await fs.pathExists(accountDir)) return null;

    const entries = await fs.readdir(accountDir);
    const versions = entries
        .filter(e => /^v\d+$/.test(e))
        .map(e => parseInt(e.replace('v', ''), 10))
        .sort((a, b) => b - a); // latest first

    for (const ver of versions) {
        const filePath = path.join(accountDir, `v${ver}`, filename);
        if (await fs.pathExists(filePath)) {
            const data = await fs.readJson(filePath);
            const id = data.llm_id || data.agent_id;
            if (id) return id;
        }
    }

    return null;
}

// ──────────────────────────────────────────────
// Main: createFullAgent (with upsert)
// ──────────────────────────────────────────────
export async function createFullAgent(accountId, memo, version = 'v1') {
    memo.account_id = accountId;

    const basePath = getOutputPath(accountId, memo, version);
    await fs.ensureDir(basePath);

    // Save memo
    const memoPath = path.join(basePath, 'memo.json');
    await fs.writeJson(memoPath, memo, { spaces: 2 });
    console.log(`✅ Memo saved at: ${memoPath}`);
    console.log('✅ Memo saved');

    // Generate and save agent draft spec
    const spec = generateAgentDraftSpec(accountId, memo, version);
    const specPath = path.join(basePath, 'agentDraftSpec.json');
    await fs.writeJson(specPath, spec, { spaces: 2 });
    console.log(`✅ AgentDraftSpec saved at: ${specPath}`);
    console.log('✅ Agent draft spec generated');

    // Upsert LLM (reuse existing or create new)
    const systemPrompt = buildSystemPrompt(memo);
    const llmId = await upsertRetellLlm(basePath, systemPrompt);

    // Upsert Agent (reuse existing or create new)
    const agentName = spec.agent_name || `Clara – ${memo.company_name || accountId}`;
    const agentId = await upsertRetellAgent(basePath, llmId, agentName);

    // Update spec with IDs
    spec.agent_id = agentId;
    spec.llm_id = llmId;
    await fs.writeJson(specPath, spec, { spaces: 2 });
    console.log('✅ Agent draft spec updated with agent_id and llm_id');

    console.log('✅ Agent created');
    return { agentId, llmId, basePath };
}