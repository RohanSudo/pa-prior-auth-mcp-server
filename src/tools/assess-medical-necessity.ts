import { z } from "zod";
import { callLLMForJSON } from "../lib/groq-client.js";
import type { PatientProfile } from "./build-patient-profile.js";
import type { PACriteria } from "./lookup-pa-criteria.js";

export const AssessMedicalNecessityInput = z.object({
  patient_profile: z
    .record(z.string(), z.unknown())
    .describe("Output from build_patient_profile tool"),
  pa_criteria: z
    .record(z.string(), z.unknown())
    .describe(
      "The criteria_data field from lookup_pa_criteria tool output"
    ),
});

export interface CriterionResult {
  criterion_id: string;
  criterion_description: string;
  required: boolean;
  met: boolean;
  reasoning: string;
  supporting_evidence: string;
  missing_information?: string;
}

export interface AssessmentResult {
  overall_recommendation: "APPROVE" | "DENY" | "NEEDS_MORE_INFO";
  confidence: number;
  criteria_results: CriterionResult[];
  gaps: string[];
  strengthening_suggestions: string[];
  summary: string;
}

const SYSTEM_PROMPT = `You are a clinical necessity reviewer at a health insurance company evaluating a prior authorization request. Your job is to objectively evaluate whether the patient meets each PA criterion based on the clinical evidence provided.

Be thorough, evidence-based, and fair. Quote specific values, medications, durations, and dates from the patient profile when citing evidence. If required criteria are clearly met, recommend APPROVE. If required criteria are clearly not met, recommend DENY. If documentation is unclear or missing, recommend NEEDS_MORE_INFO.

Return ONLY a JSON object with this exact structure:
{
  "overall_recommendation": "APPROVE" or "DENY" or "NEEDS_MORE_INFO",
  "confidence": <number 0.0-1.0>,
  "criteria_results": [
    {
      "criterion_id": "<id>",
      "criterion_description": "<copy the criterion text>",
      "required": <true|false>,
      "met": <true|false>,
      "reasoning": "<2-3 sentence explanation>",
      "supporting_evidence": "<specific quote/values from patient profile>",
      "missing_information": "<if not met, what would confirm this criterion>"
    }
  ],
  "gaps": ["<specific documentation gaps that could lead to denial>"],
  "strengthening_suggestions": ["<suggestions to strengthen the PA request>"],
  "summary": "<2-3 sentence overall summary>"
}

Rules:
- Only recommend APPROVE if ALL required criteria are met
- Consider preferred (non-required) criteria only for strengthening suggestions
- Be specific: cite drug names, doses, durations, lab values, dates
- Don't assume information not explicitly stated in the patient profile`;

export async function assessMedicalNecessity(
  input: z.infer<typeof AssessMedicalNecessityInput>
): Promise<AssessmentResult> {
  const profile = input.patient_profile as unknown as PatientProfile;
  const criteria = input.pa_criteria as unknown as PACriteria;

  const userMessage = `Evaluate this PA request:

PATIENT PROFILE:
${JSON.stringify(profile, null, 2)}

PA CRITERIA TO EVALUATE:
Drug: ${criteria.brand_name} (${criteria.drug_class})
Criteria:
${criteria.criteria
  .map(
    (c) =>
      `- [${c.id}] ${c.required ? "(REQUIRED)" : "(PREFERRED)"}: ${c.description}`
  )
  .join("\n")}

Documentation typically required: ${criteria.documentation_required.join("; ")}

Evaluate each criterion against the patient profile and return the assessment JSON.`;

  const result = await callLLMForJSON<AssessmentResult>(
    SYSTEM_PROMPT,
    userMessage,
    { maxTokens: 3000 }
  );

  return result;
}
