import { createChatCompletion } from '../../clients/groq_client.js';

const MAX_WORDS = 2250;
const MODEL = 'llama-3.3-70b-versatile';

// ──────────────────────────────────────────────
// Chunk ONLY at timestamp boundaries (mm:ss)
// Never splits mid-sentence or mid-number
// ──────────────────────────────────────────────
function chunkTranscript(transcript) {
    const lines = transcript.split('\n').filter(l => l.trim());

    // ✅ Only treat lines starting with (digits:digits) as timestamp lines
    const TIMESTAMP_RE = /^\(\d+:\d{2}\)/;

    const chunks = [];
    let current = [];
    let currentWordCount = 0;

    for (const line of lines) {
        const isTimestampLine = TIMESTAMP_RE.test(line.trim());
        const wc = line.split(/\s+/).length;

        // ✅ Only allow a split at a timestamp boundary, never mid-line
        if (
            isTimestampLine &&
            currentWordCount + wc > MAX_WORDS &&
            current.length > 0
        ) {
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
// Stage 1 — Compress chunk to operational bullets
// ──────────────────────────────────────────────
async function compressChunk(chunkText, chunkIndex, total) {
    console.log(`   🗜️  [70B] Compressing chunk ${chunkIndex + 1}/${total}...`);

    const messages = [
        {
            role: 'system',
            content: `Extract ONLY operationally relevant facts from this call transcript chunk.
Output concise bullet points. Omit greetings, filler, and small talk.

Focus on:
- Company name, industry, services offered/not offered
- Business hours, timezone, location/address
- Emergency handling rules
- Phone numbers, routing preferences
- CRM or software integrations mentioned
- Open questions or unresolved topics`,
        },
        {
            role: 'user',
            content: chunkText,
        },
    ];

    return await createChatCompletion(messages, MODEL);
}

// ──────────────────────────────────────────────
// Stage 2 — Structured JSON from compressed summary
// ──────────────────────────────────────────────
async function extractStructuredMemo(compressedSummary) {
    console.log(`   🧠 [70B] Extracting structured JSON...`);

    const messages = [
        {
            role: 'system',
            content: `Convert the operational summary into this exact JSON schema.
Return ONLY valid JSON. No explanation. No markdown. No extra fields.

Rules:
- Use null for any missing field
- Arrays must never contain null values — use empty array [] if nothing found
- All scalar fields must be string or null
- routing_rules: phone numbers only (e.g. ["+14035551234"])
- questions_or_unknowns: actual open questions only, not field names

Schema:
{
  "company_name": string | null,
  "industry_type": string | null,
  "services_mentioned": string[],
  "timezone": string | null,
  "business_hours": string | null,
  "emergency_definition": string | null,
  "routing_rules": string[],
  "integration_constraints": string | null,
  "transfer_timeout_seconds": number | null,
  "address": string | null,
  "questions_or_unknowns": string[]
}`,
        },
        {
            role: 'user',
            content: compressedSummary,
        },
    ];

    const raw = await createChatCompletion(messages, MODEL);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
}

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────
export async function extractMemo(transcript) {
    const chunks = chunkTranscript(transcript);
    console.log(`📝 Transcript → ${chunks.length} chunk(s)`);

    if (chunks.length === 1) {
        const summary = await compressChunk(chunks[0], 0, 1);
        return await extractStructuredMemo(summary);
    }

    // Multi-chunk: compress each → merge summaries → extract once
    const summaries = [];
    for (let i = 0; i < chunks.length; i++) {
        const summary = await compressChunk(chunks[i], i, chunks.length);
        summaries.push(summary);
    }

    console.log(`🔀 [70B] Extracting from merged summaries...`);
    const mergedSummary = summaries.join('\n\n---\n\n');
    return await extractStructuredMemo(mergedSummary);
}