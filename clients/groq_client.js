import Groq from 'groq-sdk';

const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

export async function createChatCompletion(messages, model = 'llama-3.1-8b-instant') {
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

export async function streamChatCompletion(messages, model = 'llama-3.1-8b-instant') {
    let fullResponse = '';
    try {
        const stream = await client.chat.completions.create({
            model: model,
            messages: messages,
            max_tokens: 1024,
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
        console.error('Error streaming from Groq API:', error);
        throw error;
    }
}

export { client };
