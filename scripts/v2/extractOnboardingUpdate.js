import { createChatCompletion } from '../../clients/groq_client.js';

const MAX_WORDS = 2250;

const MODELS = {
    extract : 'llama-3.3-70b-versatile',
    compose : 'openai/gpt-oss-120b',
};

// ──────────────────────────────────────────────
// Chunk at timestamp boundaries only
// ──────────────────────────────────────────────
function chunkTranscript(transcript) {
    const lines = transcript.split('\n').filter(l => l.trim());
    const TIMESTAMP_RE = /^\(\d+:\d{2}\)/;
    const chunks = [];
    let current = [];
    let currentWordCount = 0;

    for (const line of lines) {
        const isTimestampLine = TIMESTAMP_RE.test(line.trim());
        const wc = line.split(/\s+/).length;

        if (isTimestampLine && currentWordCount + wc > MAX_WORDS && current.length > 0) {
            chunks.push(current.join('\n'));
            current = [];
            currentWordCount = 0;
        }

        current.push(line);
        currentWordCount += wc;
    }

    if (current.length > 0) chunks.push(current.join('\n'));
    return chunks;
}

// ──────────────────────────────────────────────
// Stage 1 — 70B: Extract facts from one chunk
// ──────────────────────────────────────────────
async function extractChunkFacts(chunkText, chunkIndex, total) {
    console.log(`   📋 [70B] Extracting onboarding facts from chunk ${chunkIndex + 1}/${total}...`);

    const messages = [
        {
            role: 'system',
            content: `You are a fact-extraction engine for an ONBOARDING CALL transcript.
A vendor called "Clara" / "Clara AI" / "Clara Answers" is onboarding a CLIENT business onto their AI voice-assistant platform.
Your job is to extract facts about the CLIENT business that affect how the AI agent should be configured.

OUTPUT FORMAT:
- One bullet point per fact.
- Each bullet must be a single, self-contained statement.

COMPANY NAME — CRITICAL:
- "Clara", "Clara AI", "Clara Answers" = the VENDOR. NEVER use as company_name.
- The CLIENT COMPANY is the business being onboarded — the one whose calls Clara will answer.
  Look for it in facts like "The client company is ___" or any business name that is NOT Clara.
- You MUST extract the client company name if it appears. Format: "The client company is ___"

EXTRACTION RULES:
- Only extract facts clearly and explicitly stated in this chunk.
- If a statement is cut off or incomplete, IGNORE IT entirely.
- Preserve exact numbers, phone numbers, names, addresses as spoken.

FOCUS STRICTLY ON:
- Client company name (NOT Clara)
- Owner / contact names at the client company
- Business hours (days + times)
- Timezone
- Emergency definitions (what qualifies as an emergency)
- Emergency routing (who to call, order, phone numbers)
- Non-emergency after-hours handling
- Call transfer rules (timeout, escalation order)
- CRM/software constraints (what to do / NOT do)
- Services confirmed or explicitly excluded
- Phone numbers for routing (preserve exact digits)
- Physical address if mentioned

IGNORE: greetings, sales pitch, small talk, pricing, demos, Clara product features.`,
        },
        {
            role: 'user',
            content: chunkText,
        },
    ];

    return await createChatCompletion(messages, MODELS.extract, 2048);
}

// ──────────────────────────────────────────────
// Stage 2 — 120B: Compose structured update JSON
// ──────────────────────────────────────────────
async function composeUpdateFromFacts(allFacts) {
    console.log(`   🧠 [120B] Composing structured onboarding update from facts...`);

    const messages = [
        {
            role: 'system',
            content: `You are a structured-memo composer for an ONBOARDING CALL.
You receive extracted facts from a call where Clara AI (the VENDOR) is onboarding a CLIENT business.
Your job is to organize the facts about the CLIENT business into the JSON schema below.

Return ONLY valid JSON. No explanation. No markdown fences. No extra fields.

CRITICAL RULES:
- "Clara", "Clara AI", "Clara Answers" = the VENDOR. NEVER use as company_name.
- company_name = the CLIENT business being onboarded — the one whose calls Clara will answer.
  Look for it in facts like "The client company is ___" or any business name that is NOT Clara.
- Only populate fields supported by the provided facts.
- DO NOT fabricate, infer, or hallucinate any values.
- If a field has no supporting facts → null (scalar), [] (array), or {} (object).
- This is a PATCH — only include fields with actual new information.
  Fields with null, [] or {} will be IGNORED during merge.

SCHEMA:
{
  "company_name"                : <string | null>,
  "industry_type"               : <string | null>,
  "services_supported"          : [<string>, ...],
  "business_hours"              : {
    "days"     : [<string>, ...],
    "start"    : <string | null>,
    "end"      : <string | null>,
    "timezone" : <string | null>
  },
  "office_address"              : <string | null>,
  "emergency_definition"        : [<string>, ...],
  "emergency_routing_rules"     : {
    "contacts"  : [{ "name": <string>, "phone": <e164>, "priority": <number> }, ...],
    "fallback"  : <string | null>
  },
  "non_emergency_routing_rules" : {
    "action"   : <string | null>,
    "fallback" : <string | null>
  },
  "call_transfer_rules"         : {
    "timeout_seconds" : <number | null>,
    "retries"         : <number | null>,
    "on_fail"         : <string | null>
  },
  "integration_constraints"     : <string | null>,
  "after_hours_flow_summary"    : <string | null>,
  "office_hours_flow_summary"   : <string | null>,
  "questions_or_unknowns"       : [<string>, ...],
  "notes"                       : <string | null>
}`,
        },
        {
            role: 'user',
            content: `Here are ALL the extracted onboarding facts:\n\n${allFacts}`,
        },
    ];

    const raw = await createChatCompletion(messages, MODELS.compose, 4096);
    const cleaned = raw.replace(/```json\n?|```/g, '').trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        console.error(`   ❌ Failed to parse compose output. Raw:\n${cleaned}`);
        throw new Error(`LLM compose returned invalid JSON: ${e.message}`);
    }
    return parsed;
}

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────
export async function extractMemo(transcript) {
    if (!transcript || !transcript.trim()) {
        throw new Error('extractMemo: transcript is empty');
    }

    const chunks = chunkTranscript(transcript);

    if (chunks.length === 0) {
        throw new Error('extractMemo: transcript produced 0 chunks after splitting');
    }

    console.log(`📝 Transcript → ${chunks.length} chunk(s)`);

    // Stage 1: 70B extracts facts per chunk
    const allFactBlocks = [];
    for (let i = 0; i < chunks.length; i++) {
        let facts;
        try {
            facts = await extractChunkFacts(chunks[i], i, chunks.length);
        } catch (err) {
            console.error(`   ❌ Chunk ${i + 1} extraction failed: ${err.message}`);
            throw err;
        }
        allFactBlocks.push(facts);
    }

    const combinedFacts = allFactBlocks.join('\n\n---\n\n');
    console.log(`✅ Extracted facts from ${chunks.length} chunk(s)\n`);

    // Stage 2: 120B composes structured patch
    return await composeUpdateFromFacts(combinedFacts);
}