import 'dotenv/config';
import Retell from 'retell-sdk';
import fs from 'fs-extra';
import path from 'path';
import { generateAgentDraftSpec, saveMemo, getOutputPath } from './generateAgentDraftSpec.js';

const client = new Retell({ apiKey: process.env.RETELL_API_KEY });

// ✅ Helper to safely convert any value to string for Retell
function toRetellString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.filter(v => v !== null).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

// ──────────────────────────────────────────────
// LLM: Create once, update on re-runs
// ──────────────────────────────────────────────
async function getOrCreateLLM(basePath, llmPayload) {
    const idFile = path.join(basePath, 'llm_id.json');

    if (await fs.pathExists(idFile)) {
        const { llm_id } = await fs.readJson(idFile);
        console.log(`♻️  Reusing existing LLM: ${llm_id}`);
        const updated = await client.llm.update(llm_id, llmPayload);
        console.log(`✅ LLM updated: ${updated.llm_id}`);
        return updated;
    }

    const created = await client.llm.create(llmPayload);
    await fs.writeJson(idFile, { llm_id: created.llm_id }, { spaces: 2 });
    console.log(`✅ LLM created: ${created.llm_id}`);
    return created;
}

// ──────────────────────────────────────────────
// Agent: Create once, update on re-runs
// ──────────────────────────────────────────────
async function getOrCreateAgent(basePath, agentPayload) {
    const idFile = path.join(basePath, 'agent_id.json');

    if (await fs.pathExists(idFile)) {
        const { agent_id } = await fs.readJson(idFile);
        console.log(`♻️  Reusing existing Agent: ${agent_id}`);
        const updated = await client.agent.update(agent_id, agentPayload);
        console.log(`✅ Agent updated: ${updated.agent_id}`);
        return updated;
    }

    const created = await client.agent.create(agentPayload);
    await fs.writeJson(idFile, { agent_id: created.agent_id }, { spaces: 2 });
    console.log(`✅ Agent created: ${created.agent_id}`);
    return created;
}

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────
export async function createFullAgent(accountId, memo, version = 'v1') {
    // Step 1: Save memo
    await saveMemo(accountId, memo, version);
    console.log('✅ Memo saved');

    // Step 2: Generate agentDraftSpec
    const { agentDraftSpec, basePath } = await generateAgentDraftSpec(accountId, memo, version);
    console.log('✅ Agent draft spec generated');

    try {
        // Step 3: Build LLM payload
        const llmPayload = {
            model: 'gpt-4.1',
            general_prompt: agentDraftSpec.system_prompt,
            begin_message: 'Hello, how can I help you today?',
            default_dynamic_variables: {
                timezone: toRetellString(agentDraftSpec.key_variables?.timezone),
                business_hours: toRetellString(agentDraftSpec.key_variables?.business_hours),
                emergency_routing: toRetellString(agentDraftSpec.key_variables?.emergency_routing),
                address: toRetellString(agentDraftSpec.key_variables?.address),
            },
            general_tools: [
                {
                    type: 'end_call',
                    name: 'end_call',
                    description: 'End the call.',
                },
                {
                    type: 'transfer_call',
                    name: 'transfer_to_support',
                    description: 'Transfer to support team.',
                    transfer_destination: {
                        type: 'predefined',
                        number: agentDraftSpec.call_transfer_protocol?.escalation_order?.[0] ?? '+16175551212',
                    },
                    transfer_option: { type: 'cold_transfer' },
                },
            ],
        };

        // Step 4: Get or create LLM
        const llm = await getOrCreateLLM(basePath, llmPayload);

        // Step 5: Build agent payload
        const agentPayload = {
            agent_name: agentDraftSpec.agent_name,
            voice_id: 'retell-Cimo',
            language: 'en-US',
            response_engine: {
                type: 'retell-llm',
                llm_id: llm.llm_id,
            },
            fallback_voice_ids: ['cartesia-Cimo', 'minimax-Cimo'],
        };

        // Step 6: Get or create Agent
        const agent = await getOrCreateAgent(basePath, agentPayload);

        // Step 7: Update and save final spec
        const updatedSpec = {
            ...agentDraftSpec,
            agent_id: agent.agent_id,
            llm_id: llm.llm_id,
            status: 'created',
            updated_at: new Date().toISOString(),
        };

        await fs.writeJson(
            path.join(basePath, 'agentDraftSpec.json'),
            updatedSpec,
            { spaces: 2 }
        );
        console.log('✅ Agent draft spec updated with agent_id and llm_id');

        return updatedSpec;

    } catch (error) {
        const failedSpec = {
            ...agentDraftSpec,
            status: 'failed',
            error: error.message,
            failed_at: new Date().toISOString(),
        };
        await fs.writeJson(
            path.join(basePath, 'agentDraftSpec.json'),
            failedSpec,
            { spaces: 2 }
        );
        console.error('❌ Error creating agent:', error);
        throw error;
    }
}