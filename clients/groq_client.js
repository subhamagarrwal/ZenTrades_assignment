const Groq = require('groq-sdk');

const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

async function createChatCompletion(messages, model = 'llama-3.1-8b-instant') {
    try {
        const response = await client.chat.completions.create({
            model: model,
            messages: messages,
            max_tokens: 1024,
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error calling Groq API:', error);
        throw error;
    }
}

async function streamChatCompletion(messages, model = 'llama-3.1-8b-instant') {
    try {
        const stream = await client.chat.completions.create({
            model: model,
            messages: messages,
            max_tokens: 1024,
            stream: true,
        });

        for await (const chunk of stream) {
            if (chunk.choices[0].delta.content) {
                process.stdout.write(chunk.choices[0].delta.content);
            }
        }
    } catch (error) {
        console.error('Error streaming from Groq API:', error);
        throw error;
    }
}

module.exports = { client, createChatCompletion, streamChatCompletion };
