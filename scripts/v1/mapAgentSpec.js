import Retell from 'retell-sdk';
import fs from 'fs-extra';
import path from 'path';
import { generateAgentDraftSpec } from './generateAgentDraftSpec.js';

const client = new Retell({ apiKey: process.env.RETELL_API_KEY });

export async function createFullAgent(accountId, memo) {
    // Step 1: Generate agentDraftSpec from memo
    const agentDraftSpec = await generateAgentDraftSpec(accountId, memo);
    console.log('✅ Agent draft spec generated');

    const basePath = `../../outputs/${accountId}/v1/`;

    try {
        // Step 2: Create LLM on Retell
        const llm = await client.llm.create({
            model: "gpt-4.1",
            general_prompt: agentDraftSpec.system_prompt,
            begin_message: "Hello, how can I help you today?",
            default_dynamic_variables: agentDraftSpec.key_variables,
            general_tools: [
                { 
                    type: "end_call", 
                    name: "end_call", 
                    description: "End the call." 
                },
                {
                    type: "transfer_call",
                    name: "transfer_to_support",
                    description: "Transfer to support team.",
                    transfer_destination: {
                        type: "predefined",
                        number: "+16175551212",
                    },
                    transfer_option: { type: "cold_transfer" },
                },
            ],
        });
        console.log('✅ LLM created:', llm.llm_id);

        // Step 3: Create Agent on Retell
        const agent = await client.agent.create({
            agent_name: agentDraftSpec.agent_name,
            voice_id: "retell-Cimo",
            language: "en-US",
            response_engine: {
                type: "retell-llm",
                llm_id: llm.llm_id,
            },
            fallback_voice_ids: ["cartesia-Cimo", "minimax-Cimo"],
        });
        console.log('✅ Agent created:', agent.agent_id);

        // Step 4: Update agentDraftSpec with Retell response fields
        const updatedSpec = {
            ...agentDraftSpec,
            agent_id: agent.agent_id,
            llm_id: llm.llm_id,
            status: "created",
            created_at: new Date().toISOString(),
        };

        // Step 5: Save updated spec back to file
        await fs.writeJson(
            path.join(basePath, 'agentDraftSpec.json'), 
            updatedSpec, 
            { spaces: 2 }
        );
        console.log('✅ Agent draft spec updated with agent_id and llm_id');

        return updatedSpec;

    } catch (error) {
        // Save failed status to spec
        const failedSpec = {
            ...agentDraftSpec,
            status: "failed",
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