import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createChatCompletion } from '../../clients/groq_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ✅ Helper to slugify company name
export function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// ✅ Export this function
export function getOutputPath(accountId, memo, version = 'v1') {
    const companySlug = slugify(memo.company_name ?? 'unknown-company');
    return path.resolve(
        __dirname,
        '../../outputs/accounts',
        `${accountId}_${companySlug}`,
        version
    );
}

// ✅ Export this function
export async function saveMemo(accountId, memo, version = 'v1') {
    const basePath = getOutputPath(accountId, memo, version);
    await fs.ensureDir(basePath);
    await fs.writeJson(path.join(basePath, 'memo.json'), memo, { spaces: 2 });
    console.log(`✅ Memo saved at: ${basePath}/memo.json`);
    return basePath;
}

export function buildSystemPrompt(memo) {
    const company = memo.company_name ?? "the company";

    return `
You are Clara, the automated voice assistant for ${company}.

You follow strict call discipline.

==============================
BUSINESS HOURS FLOW
==============================

1. Greet professionally and identify yourself as Clara, the automated voice assistant for ${company}.
2. Ask the purpose of the call.
3. Collect the caller's name and callback number.
4. Route or transfer based on the request.
5. If transfer fails:
   - Apologize briefly.
   - Confirm callback number.
   - Assure follow-up within business hours.
6. Ask if anything else is needed.
7. Close politely.

==============================
AFTER HOURS FLOW
==============================

1. Greet professionally.
2. Ask the purpose of the call.
3. Confirm whether this is an emergency.

If emergency:
- Immediately collect:
  • Name
  • Callback number
  • Service address
- Attempt transfer according to emergency routing rules.
- If transfer fails:
  - Apologize.
  - Confirm callback number.
  - Assure rapid follow-up.

If non-emergency:
- Collect name and callback number.
- Capture a short issue summary.
- Inform the caller the team will respond during business hours.

Rules:
- Do not ask unnecessary questions.
- Do not mention internal systems or tools.
- Remain concise, calm, and professional.
`;
}

// ✅ Export this function
export async function generateAgentDraftSpec(accountId, memo, version = 'v1') {
    const basePath = getOutputPath(accountId, memo, version);
    await fs.ensureDir(basePath);

    const agentDraftSpec = {
        agent_name: `Clara - ${memo.company_name ?? "Company"}'s Automated Voice Assistant`,
        voice_style: "Professional, calm, concise",
        system_prompt: buildSystemPrompt(memo),
        key_variables: {
            timezone: memo.timezone ?? null,
            business_hours: memo.business_hours ?? null,
            emergency_routing: memo.routing_rules ?? null,
            address: memo.address ?? null
        },
        tool_invocation_placeholders: ["transfer_call", "end_call"],
        call_transfer_protocol: {
            timeout_seconds: memo.transfer_timeout_seconds ?? 60,
            retries: 1,
            escalation_order: memo.routing_rules ?? null
        },
        fallback_protocol: {
            on_transfer_fail: "Apologies, confirm callback number, assure fallback number"
        },
        version,
    };

    await fs.writeJson(
        path.join(basePath, 'agentDraftSpec.json'),
        agentDraftSpec,
        { spaces: 2 }
    );
    console.log(`✅ AgentDraftSpec saved at: ${basePath}/agentDraftSpec.json`);

    return { agentDraftSpec, basePath };
}
