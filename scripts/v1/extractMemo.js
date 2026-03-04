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
            content: `You are a fact-extraction engine. Extract ONLY operationally relevant facts from this call transcript chunk.

OUTPUT FORMAT:
- One bullet point per fact.
- Each bullet must be a single, self-contained statement.
- No duplicates, no filler, no greetings, no opinions.

EXTRACTION RULES:
- Only extract facts that are clearly and explicitly stated within this chunk.
- If a statement appears cut off or incomplete, IGNORE IT — do not guess or infer.
- Do NOT combine facts from different parts of the chunk into a new claim.
- Preserve exact numbers, phone numbers, names, and addresses as spoken.

FOCUS ON:
- Company name (the CLIENT being onboarded, NOT "Clara" / "Clara AI" which is the vendor)
- Industry, services offered, services explicitly NOT offered
- Business hours (days + times), timezone
- Physical address, location
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
            content: `You are a structured-memo composer. You receive a list of extracted facts from a sales/demo call.
Your job is to organize them into the exact JSON schema below.

Return ONLY valid JSON. No explanation. No markdown fences. No extra fields.

CRITICAL RULES:
- "Clara", "Clara AI", "Clara Answers" = the VENDOR product, NEVER the client company name.
- company_name = the CLIENT business being sold to. If not explicitly named, use null.
- Only include information that is supported by the facts provided.
- DO NOT fabricate, infer, or hallucinate any values.
- If a field has no supporting facts → null (scalar) or [] (array).
- routing_rules: E.164 phone numbers only, e.g. "+14035551234"
- questions_or_unknowns: real open questions only, not missing field names

SCHEMA (tone-format — fill every key):
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