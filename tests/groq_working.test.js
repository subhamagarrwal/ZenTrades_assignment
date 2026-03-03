const Groq = require('groq-sdk');
const { createChatCompletion, streamChatCompletion } = require('../clients/groq_client');

jest.mock('groq-sdk');

describe('Groq Client', () => {
    let mockCreate;

    beforeEach(() => {
        mockCreate = jest.fn();
        Groq.prototype.chat = {
            completions: {
                create: mockCreate
            }
        };
        jest.clearAllMocks();
    });

    describe('createChatCompletion', () => {
        it('should return chat completion content', async () => {
            const mockMessages = [{ role: 'user', content: 'Hello, how are you?' }];
            const mockResponse = {
                choices: [{ message: { content: 'I am doing really nice, thank you for asking!' } }]
            };
            mockCreate.mockResolvedValue(mockResponse);

            const result = await createChatCompletion(mockMessages, 'llama-3.1-8b-instant');
            expect(result).toEqual('I am doing really nice, thank you for asking!');
            expect(mockCreate).toHaveBeenCalledWith({
                model: 'llama-3.1-8b-instant',
                messages: mockMessages,
                max_tokens: 1024
            });
        });

        it('should throw an error if chat completion fails', async () => {
            const mockMessages = [{ role: 'user', content: 'Hello' }];
            mockCreate.mockRejectedValue(new Error('API error'));

            await expect(createChatCompletion(mockMessages, 'llama-3.1-8b-instant')).rejects.toThrow('API error');
        });
    });

    describe('streamChatCompletion', () => {
        it('should stream content successfully', async () => {
            const mockMessages = [{ role: 'user', content: 'Hello' }];
            const mockStream = [
                { choices: [{ delta: { content: 'Hello' } }] },
                { choices: [{ delta: { content: ' how are you?' } }] }
            ];

            mockCreate.mockResolvedValue({
                [Symbol.asyncIterator]: () => ({
                    async next() {
                        const value = mockStream.shift();
                        return { value, done: !value };
                    }
                })
            });

            const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation();
            await streamChatCompletion(mockMessages, 'llama-3.1-8b-instant');

            expect(writeSpy).toHaveBeenCalledWith('Hello');
            expect(writeSpy).toHaveBeenCalledWith(' how are you?');
            writeSpy.mockRestore();
        });

        it('should handle stream errors', async () => {
            const mockMessages = [{ role: 'user', content: 'Hello' }];
            mockCreate.mockRejectedValue(new Error('Stream error'));

            await expect(streamChatCompletion(mockMessages, 'llama-3.1-8b-instant')).rejects.toThrow();
        });
    });
});
