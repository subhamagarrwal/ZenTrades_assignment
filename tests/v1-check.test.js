const mockLlmCreate = jest.fn();
const mockAgentCreate = jest.fn();

// Mock BEFORE any requires
jest.mock('../clients/groq_client.js', () => ({
    createChatCompletion: jest.fn(),
    streamChatCompletion: jest.fn(),
    client: {}
}));

// ✅ Mock retell-sdk constructor with llm and agent
jest.mock('retell-sdk', () => {
    return jest.fn().mockImplementation(() => ({
        llm: { create: mockLlmCreate },
        agent: { create: mockAgentCreate }
    }));
});

jest.mock('fs-extra');

const { extractMemo } = require('../scripts/v1/extractMemo.js');
const { generateAgentDraftSpec } = require('../scripts/v1/generateAgentDraftSpec.js');
const { createFullAgent } = require('../scripts/v1/mapAgentSpec.js');
const { createChatCompletion } = require('../clients/groq_client.js');
const fs = require('fs-extra');

const mockTranscript = `
    Our company is AcmePlumbing. We are a plumbing company based in New York.
    We operate Monday to Friday, 9am to 5pm EST.
    Emergencies should be routed to John at +12125550001, then Mike at +12125550002.
    Transfer timeout is 30 seconds.
    Our address is 123 Main St, New York, NY 10001.
`;

const mockMemo = {
    company_name: "AcmePlumbing",
    industry_type: "Plumbing",
    services_mentioned: ["plumbing"],
    timezone: "EST",
    business_hours: "Monday to Friday, 9am to 5pm",
    emergency_definition: "Pipe burst, flooding",
    routing_rules: ["+12125550001", "+12125550002"],
    integration_constraints: null,
    transfer_timeout_seconds: 30,
    address: "123 Main St, New York, NY 10001",
    questions_or_unknowns: []
};

describe('Full Agent Creation Flow', () => {
    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Mock fs-extra
        fs.ensureDir.mockResolvedValue();
        fs.writeJson.mockResolvedValue();

        // Mock Groq
        createChatCompletion.mockResolvedValue(JSON.stringify(mockMemo));

        // ✅ Mock Retell responses
        mockLlmCreate.mockResolvedValue({ llm_id: 'llm_mock_123' });
        mockAgentCreate.mockResolvedValue({ agent_id: 'agent_mock_456' });
    });

    it('should run full flow: transcript → memo → agentDraftSpec → retell agent', async () => {
        // Step 1: extractMemo
        const memo = await extractMemo(mockTranscript);
        expect(memo.company_name).toBe('AcmePlumbing');
        expect(memo.timezone).toBe('EST');
        expect(memo.routing_rules).toEqual(['+12125550001', '+12125550002']);
        console.log('✅ Step 1: extractMemo passed');

        // Step 2: generateAgentDraftSpec
        const agentDraftSpec = await generateAgentDraftSpec('acme_001', memo);
        expect(agentDraftSpec.agent_name).toContain('AcmePlumbing');
        expect(agentDraftSpec.key_variables.timezone).toBe('EST');
        expect(agentDraftSpec.call_transfer_protocol.timeout_seconds).toBe(30);
        console.log('✅ Step 2: generateAgentDraftSpec passed');

        // Reset call count before createFullAgent
        // (generateAgentDraftSpec already called writeJson once above)
        fs.writeJson.mockClear();

        // Step 3: createFullAgent
        const result = await createFullAgent('acme_001', memo);
        expect(result.agent_id).toBe('agent_mock_456');
        expect(result.llm_id).toBe('llm_mock_123');
        expect(result.status).toBe('created');
        expect(result.created_at).toBeDefined();
        // createFullAgent calls generateAgentDraftSpec (1 write) + saves updated spec (1 write) = 2
        expect(fs.writeJson).toHaveBeenCalledTimes(2);
        console.log('✅ Step 3: createFullAgent passed');

        // Verify final saved spec - last writeJson call
        const savedSpec = fs.writeJson.mock.calls[1][1];
        expect(savedSpec).toMatchObject({
            agent_id: 'agent_mock_456',
            llm_id: 'llm_mock_123',
            status: 'created',
            agent_name: expect.stringContaining('AcmePlumbing'),
        });
        console.log('✅ Step 4: Final spec saved correctly');
    });

    it('should handle Retell API failure and save failed status', async () => {
        // ✅ Override to reject
        mockLlmCreate.mockRejectedValue(new Error('Retell API error'));

        const memo = await extractMemo(mockTranscript);
        await expect(createFullAgent('acme_001', memo)).rejects.toThrow('Retell API error');

        const savedSpec = fs.writeJson.mock.calls[1][1];
        expect(savedSpec.status).toBe('failed');
        expect(savedSpec.error).toBe('Retell API error');
        console.log('✅ Failure case: failed spec saved correctly');
    });

    it('should handle invalid transcript and throw error', async () => {
        createChatCompletion.mockResolvedValue('invalid json {{{}');
        await expect(extractMemo('bad transcript')).rejects.toThrow();
        console.log('✅ Invalid transcript: error thrown correctly');
    });
});