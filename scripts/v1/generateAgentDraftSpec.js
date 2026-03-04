import { createChatCompletion } from '../../clients/groq_client.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

export function getOutputPath(accountId, memo, version = 'v1') {
    const folderSlug = slugify(accountId);   // folder = slugified account_id (e.g. "bens-electric")
    return path.resolve(
        __dirname,
        '../../outputs/accounts',
        folderSlug,
        version
    );
}

export async function saveMemo(accountId, memo, version = 'v1') {
    const basePath = getOutputPath(accountId, memo, version);
    await fs.ensureDir(basePath);
    await fs.writeJson(path.join(basePath, 'memo.json'), memo, { spaces: 2 });
    console.log(`✅ Memo saved at: ${basePath}/memo.json`);
    return basePath;
}

export function buildSystemPrompt(memo) {
    const company = memo.company_name || 'the company';
    const tz = memo.business_hours?.timezone || 'local time';
    const days = memo.business_hours?.days?.join(', ') || 'Monday–Friday';
    const start = memo.business_hours?.start || '8:00 AM';
    const end = memo.business_hours?.end || '5:00 PM';
    const addr = memo.office_address || '[address on file]';
    const services = memo.services_supported?.length
        ? memo.services_supported.join(', ')
        : 'general services';
    const emergencyDef = memo.emergency_definition?.length
        ? memo.emergency_definition.map(e => `  - ${e}`).join('\n')
        : '  - Any situation involving immediate safety risk or active damage';
    const integrationNote = memo.integration_constraints || 'None specified.';

    // Emergency contacts
    let emergencyContacts = 'No emergency contacts specified.';
    if (memo.emergency_routing_rules?.contacts?.length) {
        emergencyContacts = memo.emergency_routing_rules.contacts
            .sort((a, b) => a.priority - b.priority)
            .map(c => `  ${c.priority}. ${c.name}: ${c.phone}`)
            .join('\n');
    }

    const emergencyFallback = memo.emergency_routing_rules?.fallback
        || 'Apologize, confirm callback number, assure rapid follow-up.';

    const transferTimeout = memo.call_transfer_rules?.timeout_seconds || 30;
    const transferRetries = memo.call_transfer_rules?.retries || 1;
    const transferOnFail = memo.call_transfer_rules?.on_fail
        || 'Apologize, confirm callback number, assure follow-up within business hours.';

    return `
You are Clara, the automated voice assistant for ${company}.
You follow strict call discipline.

==============================
COMPANY INFO
==============================
Company: ${company}
Address: ${addr}
Services: ${services}
Timezone: ${tz}
Business Hours: ${days}, ${start} – ${end}
Integration Constraints: ${integrationNote}

==============================
EMERGENCY DEFINITION
==============================
The following qualify as emergencies:
${emergencyDef}

==============================
EMERGENCY ROUTING (priority order)
==============================
${emergencyContacts}
Fallback: ${emergencyFallback}

==============================
CALL TRANSFER RULES
==============================
- Timeout: ${transferTimeout} seconds
- Retries: ${transferRetries}
- On failure: ${transferOnFail}

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
- Attempt transfer according to emergency routing rules (priority order).
- If transfer fails:
  - Apologize.
  - Confirm callback number.
  - Assure rapid follow-up.

If non-emergency:
- Collect name and callback number.
- Capture a short issue summary.
- Inform the caller the team will respond during business hours.

==============================
RULES
==============================
- Do not ask unnecessary questions.
- Do not mention internal systems, tools, or function calls to the caller.
- Remain concise, calm, and professional.
- Only collect what is needed for routing and dispatch.
`;
}

export function generateAgentDraftSpec(accountId, memo, version = 'v1') {
    const company = memo.company_name || 'Unknown Company';
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const spec = {
        agent_name: `Clara – ${company}`,
        voice_style: 'Professional, calm, concise',
        system_prompt: buildSystemPrompt(memo),
        key_variables: {
            timezone: memo.business_hours?.timezone || null,
            business_hours: memo.business_hours
                ? `${memo.business_hours.days?.join(', ') || ''}, ${memo.business_hours.start || ''} – ${memo.business_hours.end || ''}`
                : null,
            address: memo.office_address || null,
            emergency_routing: memo.emergency_routing_rules || null,
        },
        tool_invocation_placeholders: [
            { name: 'transfer_call', description: 'Transfer caller to a phone number', params: ['phone_number'] },
            { name: 'end_call', description: 'End the call after wrap-up', params: [] },
            { name: 'send_sms', description: 'Send SMS confirmation to caller', params: ['phone_number', 'message'] },
        ],
        call_transfer_protocol: {
            timeout_seconds: memo.call_transfer_rules?.timeout_seconds || 30,
            retries: memo.call_transfer_rules?.retries || 1,
            on_fail: memo.call_transfer_rules?.on_fail || 'Apologize, confirm callback number, assure follow-up.',
        },
        fallback_protocol: {
            emergency: memo.emergency_routing_rules?.fallback || 'Confirm callback number, assure rapid follow-up.',
            non_emergency: memo.non_emergency_routing_rules?.fallback || 'Take message, assure follow-up during business hours.',
        },
        version: version,
    };

    return spec;
}
