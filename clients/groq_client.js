import Groq from 'groq-sdk';

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

async function createChatCompletion(messages, model = model)
{
    try{
        const response = await groq.chat.completions.create({
            model: model,
            messages: messages,
            max_tokens: 2048
        });
        return response.choices[0].message.content;
    }
    catch(error) {
        console.error('Error creating chat');
        throw error;
    }
}

async function streamChatCompletion(messages, model = model) {
    try {
        const stream = await client.chat.completions.create({
            model: model,
            messages: messages,
            max_tokens: 2048,
            stream: true
        });

        for await (const chunk of stream){
            if (chunk.choices[0].delta.content) {
            process.stdout.write(chunk.choices[0].delta.content);
            }
        }
    }catch(err) {
        console.error("Error streaming chat completion");
        throw err;
    }
}

module.exports = {client, createChatCompletion, streamChatCompletion};
