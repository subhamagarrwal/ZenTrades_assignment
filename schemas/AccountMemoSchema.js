//implementing zod for validation of the account memo schema. This will be used to validate the output of the extractMemo function before it is stored in the database.
//also helps in preventing hallucinations by the model, as we can check if the output matches the expected schema and if not, we can discard it or ask the model to try again.
import zod from "zod";

export const AccountMemoSchema = zod.object(
    {
        company_name: z.string().nullable(),
        industry_type: z.string().nullable(),
        services_mentioned: z.array(z.string()).nullable(),
        timezone: z.string().nullable(),
        business_hours: z.string().nullable(),
        emergency_definition: z.string().nullable(),
        routing_rules: z.array(z.string()).nullable(),
        integration_constraints: z.array(z.string()).nullable(),
        transfer_timeout_seconds: z.number().nullable(),
        address: z.string().nullable(),
        questions_or_unknowns: z.array(z.string()).nullable()
    }
)