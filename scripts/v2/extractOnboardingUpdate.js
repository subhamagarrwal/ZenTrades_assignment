import { createChatCompletion } from '../../clients/groq_client.js';

const MAX_WORDS = 2250;

const MODELS = {
    extract : 'llama-3.3-70b-versatile',
    compose : 'openai/gpt-oss-120b',
};

// ──────────────────────────────────────────────
// Chunk ONLY at timestamp boundaries
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
// Stage 1 — 70B: Extract onboarding-relevant facts
// ──────────────────────────────────────────────
async function extractChunkFacts(chunkText, chunkIndex, total) {
    console.log(`   📋 [70B] Extracting onboarding facts from chunk ${chunkIndex + 1}/${total}...`);

    const messages = [
        {
            role: 'system',
            content: `You are a fact-extraction engine for an ONBOARDING call transcript.
Extract ONLY facts that would change how a voice AI agent is configured.

OUTPUT FORMAT:
- One bullet point per fact.
- Each bullet must be a single, self-contained statement.

EXTRACTION RULES:
- Only extract facts clearly and explicitly stated in this chunk.
- If a statement is cut off or incomplete, IGNORE IT entirely.
- Preserve exact numbers, phone numbers, names, addresses as spoken.

FOCUS STRICTLY ON:
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

IGNORE: greetings, sales pitch, small talk, pricing, demos, company history.`,
        },
        {
            role: 'user',
            content: chunkText,
        },
    ];

    return await createChatCompletion(messages, MODELS.extract, 2048);
}

// ──────────────────────────────────────────────
// Stage 2 — 120B: Compose structured update from facts
// ──────────────────────────────────────────────
async function composeUpdateFromFacts(allFacts) {
    console.log(`   🧠 [120B] Composing structured onboarding update from facts...`);

    const messages = [
        {
            role: 'system',
            content: `You are a structured-memo composer. You receive facts extracted from an onboarding call.
Your job is to organize them into the exact JSON schema below.

Return ONLY valid JSON. No explanation. No markdown fences. No extra fields.

CRITICAL RULES:
- "Clara", "Clara AI", "Clara Answers" = the VENDOR — NEVER the client company name.
- company_name = the CLIENT business. If not explicitly named in the facts, use null.
- Only populate fields supported by the provided facts.
- DO NOT fabricate, infer, or hallucinate any values.
- If a field has no supporting facts → null (scalar) or [] (array).
- routing_rules: E.164 phone numbers only
- This is a PATCH — only include fields with actual new information.
  Fields with null or [] will be IGNORED during merge.

SCHEMA (tone-format):
{
  company_name             : <string | null>,
  industry_type            : <string | null>,
  services_mentioned       : [<string>, ...],
  timezone                 : <string | null>,
  business_hours           : <string | null>,
  emergency_definition     : <string | null>,
  routing_rules            : [<e164_phone_string>, ...],
  integration_constraints  : <string | null>,
  transfer_timeout_seconds : <number | null>,
  address                  : <string | null>,
  questions_or_unknowns    : [<string>, ...]
}`,
        },
        {
            role: 'user',
            content: `Here are ALL the extracted onboarding facts:\n\n${allFacts}`,
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

    // Stage 1: 70B extracts facts
    const allFactBlocks = [];
    for (let i = 0; i < chunks.length; i++) {
        const facts = await extractChunkFacts(chunks[i], i, chunks.length);
        allFactBlocks.push(facts);
    }

    const combinedFacts = allFactBlocks.join('\n\n---\n\n');
    console.log(`✅ Extracted facts from ${chunks.length} chunk(s)\n`);

    // Stage 2: 120B composes structured update
    return await composeUpdateFromFacts(combinedFacts);
}