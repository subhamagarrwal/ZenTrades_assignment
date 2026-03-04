import { createChatCompletion } from '../../clients/groq_client.js';

const MAX_WORDS = 2250;

const MODELS = {
    extract : 'llama-3.3-70b-versatile',
    compose : 'openai/gpt-oss-120b',
};

// ──────────────────────────────────────────────
// Chunk ONLY at timestamp boundaries (mm:ss)
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
// Stage 1 — 70B: Extract facts from each chunk
// ──────────────────────────────────────────────
async function extractChunkFacts(chunkText, chunkIndex, total) {
    console.log(`   📋 [70B] Extracting facts from chunk ${chunkIndex + 1}/${total}...`);

    const messages = [
        {
            role: 'system',
            content: `You are a fact-extraction engine for a DEMO SALES CALL transcript.
A vendor called "Clara" / "Clara AI" / "Clara Answers" is pitching their AI voice-assistant product to a CLIENT business.
Your job is to extract operationally relevant facts about the CLIENT business.

OUTPUT FORMAT:
- One bullet point per fact.
- Each bullet must be a single, self-contained statement.
- No duplicates, no filler, no greetings, no opinions.

COMPANY NAME — THIS IS THE MOST IMPORTANT RULE:
- "Clara", "Clara AI", "Clara Answers" = the VENDOR selling an AI phone system. NEVER extract these as the client company.
- The CLIENT COMPANY is the business that Clara will answer phones for.
- The client company name often appears in phrases like:
  "kickoff call for ___", "setting up ___ ", "onboarding ___",
  "welcome ___", "___ is a ___", or simply the business name spoken by the participants.
- You MUST extract the client company name if it appears. Format: "The client company is ___"

EXTRACTION RULES:
- Only extract facts clearly and explicitly stated in this chunk.
- If a statement is cut off or incomplete, IGNORE IT.
- Do NOT combine facts from different parts into a new claim.
- Preserve exact numbers, phone numbers, names, and addresses as spoken.

FOCUS ON:
- Client company name (NOT Clara — Clara is the vendor)
- Owner / contact names at the client company
- Industry, services offered, services explicitly NOT offered
- Business hours (days + times), timezone
- Physical address, location, service area
- Emergency definitions (what counts as emergency)
- Phone numbers, routing / transfer preferences
- CRM or software integrations, constraints
- After-hours handling, voicemail rules
- Open questions or unresolved topics`,
        },
        {
            role: 'user',
            content: chunkText,
        },
    ];

    return await createChatCompletion(messages, MODELS.extract, 2048);
}

// ──────────────────────────────────────────────
// Stage 2 — 120B: Compose structured memo from facts
// ──────────────────────────────────────────────
async function composeMemoFromFacts(allFacts) {
    console.log(`   🧠 [120B] Composing structured memo from facts...`);

    const messages = [
        {
            role: 'system',
            content: `You are a structured-memo composer for a DEMO SALES CALL.
You receive extracted facts from a call where Clara AI (the VENDOR) is pitching to a CLIENT business.
Your job is to organize the facts about the CLIENT business into the JSON schema below.

Return ONLY valid JSON. No explanation. No markdown fences. No extra fields.

CRITICAL RULES:
- "Clara", "Clara AI", "Clara Answers" = the VENDOR product that answers phones. NEVER use as company_name.
- company_name = the CLIENT business that Clara will answer phones for.
  Look for it in facts like "The client company is ___" or any business name that is NOT Clara.
- Only include information supported by the provided facts.
- DO NOT fabricate, infer, or hallucinate any values.
- If a field has no supporting facts → null (scalar), [] (array), or {} (object).
- Phone numbers must be E.164 format, e.g. "+14035551234"
- questions_or_unknowns: real open questions only, not missing field names.

SCHEMA (fill every key):
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
            content: `Here are ALL the extracted facts:\n\n${allFacts}`,
        },
    ];

    const raw = await createChatCompletion(messages, MODELS.compose, 4096);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
}

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────
export async function extractMemo(transcript) {
    const chunks = chunkTranscript(transcript);
    console.log(`📝 Transcript → ${chunks.length} chunk(s)`);

    // Stage 1: 70B extracts facts from every chunk
    const allFactBlocks = [];
    for (let i = 0; i < chunks.length; i++) {
        const facts = await extractChunkFacts(chunks[i], i, chunks.length);
        allFactBlocks.push(facts);
    }

    const combinedFacts = allFactBlocks.join('\n\n---\n\n');
    console.log(`✅ Extracted facts from ${chunks.length} chunk(s)\n`);

    // Stage 2: 120B composes final structured memo
    return await composeMemoFromFacts(combinedFacts);
}