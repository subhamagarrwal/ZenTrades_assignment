import { createChatCompletion } from "../../clients/groq_client.js";

export async function extractMemo(transcript) { 
    const prompt = `
    You are an expert operational data extractor. 
    Return ONLY a valid JSON object. Do not wrap in markdown blocks. Do not explain.
    CRITICAL: Do not invent missing information. If a field is not explicitly mentioned in the transcript, its value MUST be null.

    Expected JSON Schema:
    {
        "company_name": "string or null",
        "industry_type": "string or null",
        "services_mentioned": ["array of strings"] or null,
        "timezone": "string or null",
        "business_hours": "string or null",
        "emergency_definition": "string or null",
        "routing_rules": ["array of strings"] or null,
        "integration_constraints": ["array of strings"] or null,
        "transfer_timeout_seconds": "number or null",
        "address": "string or null",
        "questions_or_unknowns": ["array of missing critical details"] or []
    }

    Transcript: 
    ${transcript}
    `;
    const response = await createChatCompletion([{ role: 'user', content: prompt }], 'llama-3.3-70b-versatile');
    
    const cleanedResponse = response.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanedResponse);
}