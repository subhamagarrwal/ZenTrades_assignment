import Groq from 'groq-sdk';

const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

// ─── 429 detection + retry config ──────────────────────────
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

function is429(error) {
    return error?.status === 429 ||
        error?.statusCode === 429 ||
        error?.error?.code === 'rate_limit_exceeded' ||
        String(error?.message).includes('429');
}

/** Extract wait time from Groq 429 message, e.g. "Please try again in 4.195s" */
function parseRetryAfter(error) {
    const msg = error?.error?.message || error?.message || '';
    const match = msg.match(/try again in ([\d.]+)s/i);
    return match ? Math.ceil(parseFloat(match[1]) * 1000) + 500 : null; // +500ms buffer
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Lazy-load fallback only on first 429 (avoids import cost when Groq is fine)
let _fallback = null;
async function getFallback() {
    if (!_fallback) _fallback = await import('./local_fallback.js');
    return _fallback;
}

// ─── Chat completion with retry → local fallback ───────────
export async function createChatCompletion(messages, model = 'llama-3.3-70b-versatile', maxTokens = 4096) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.chat.completions.create({
                model,
                messages,
                max_tokens: maxTokens,
            });
            return response.choices[0].message.content;
        } catch (error) {
            if (is429(error) && attempt < MAX_RETRIES) {
                const wait = parseRetryAfter(error) || RETRY_DELAY_MS * (attempt + 1);
                console.warn(`⚠️  Groq 429 — retry ${attempt + 1}/${MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s...`);
                await sleep(wait);
                continue;
            }
            if (is429(error)) {
                console.warn('⚠️  Groq rate-limit persists — switching to local LLM fallback...');
                try {
                    const fb = await getFallback();
                    return await fb.localChatCompletion(messages, maxTokens);
                } catch (fbErr) {
                    console.error('❌ Local LLM fallback also failed:', fbErr.message);
                    throw error;   // rethrow original 429
                }
            }
            console.error('Error calling Groq API:', error);
            throw error;
        }
    }
}

// ─── Streaming completion with retry → local fallback ──────
export async function streamChatCompletion(messages, model = 'llama-3.3-70b-versatile') {
    let fullResponse = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const stream = await client.chat.completions.create({
                model,
                messages,
                max_tokens: 4096,
                stream: true,
            });

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    process.stdout.write(content);
                    fullResponse += content;
                }
            }
            return fullResponse;
        } catch (error) {
            if (is429(error) && attempt < MAX_RETRIES) {
                const wait = parseRetryAfter(error) || RETRY_DELAY_MS * (attempt + 1);
                console.warn(`⚠️  Groq 429 — retry ${attempt + 1}/${MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s...`);
                await sleep(wait);
                fullResponse = '';
                continue;
            }
            if (is429(error)) {
                console.warn('⚠️  Groq rate-limit persists — falling back to local LLM (non-streaming)...');
                try {
                    const fb = await getFallback();
                    const result = await fb.localChatCompletion(messages, 4096);
                    process.stdout.write(result);
                    return result;
                } catch (fbErr) {
                    console.error('❌ Local LLM fallback also failed:', fbErr.message);
                    throw error;
                }
            }
            console.error('Error streaming from Groq API:', error);
            throw error;
        }
    }
}

export { client };
