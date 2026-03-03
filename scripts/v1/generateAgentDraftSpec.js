import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export async function generateAgentDraftSpec(accountId, memo){
    const basePath = path.resolve(__dirname, '../../outputs', accountId, 'v1');
    await fs.ensureDir(basePath);

    const agentDraftSpec = {
        agent_name : `Clara - ${memo.company_name? memo.company_name : "Company"}'s Automated Voice Assistant`,
        voice_style: "Professional, calm,concise",
        system_prompt: buildSystemPrompt(memo),
        key_variables: {
            timezone: memo.timezone ?? null,
            business_hours: memo.business_hours ?? null,
            emergency_routing: memo.routing_rules ?? null,
            address: memo.address ?? null
        },

        tool_invocation_placeholders: [
            "transfer_call",
            "end_call"
        ],
        call_transfer_protocol: {
            timeout_seconds: memo.transfer_timeout_seconds?? 60,
            retries: 1,
            escalation_order : memo.routing_rules?? null
        },

        fallback_protocol: {
            on_transfer_fail: 
                "Apologies, confirm callback number, assure fallback number"
        },

        version: "v1",

    };
     // Save draft spec to file
    await fs.writeJson(path.join(basePath, 'agentDraftSpec.json'), agentDraftSpec, { spaces: 2 });

    return agentDraftSpec;
}
