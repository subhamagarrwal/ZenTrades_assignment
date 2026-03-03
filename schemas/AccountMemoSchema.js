import { z } from 'zod';

export const AccountMemoSchema = z.object({
    company_name: z.string().nullable(),
    industry_type: z.string().nullable(),
    services_mentioned: z.array(z.string()).nullable(),
    timezone: z.string().nullable(),
    business_hours: z.string().nullable(),
    emergency_definition: z.string().nullable(),
    routing_rules: z.array(z.string()).nullable(),
    integration_constraints: z.string().nullable(),
    transfer_timeout_seconds: z.number().nullable(),
    address: z.string().nullable(),
    questions_or_unknowns: z.array(z.string()).nullable(),
});