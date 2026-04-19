import { z } from "zod";
import { callLLM } from "../lib/groq-client.js";
import type { PatientProfile } from "./build-patient-profile.js";
import type { PACriteria } from "./lookup-pa-criteria.js";
import type { AssessmentResult } from "./assess-medical-necessity.js";

export const GeneratePALetterInput = z.object({
  patient_profile: z
    .record(z.string(), z.unknown())
    .describe("Output from build_patient_profile"),
  pa_criteria: z
    .record(z.string(), z.unknown())
    .describe("The criteria_data from lookup_pa_criteria"),
  assessment: z
    .record(z.string(), z.unknown())
    .describe("Output from assess_medical_necessity"),
});

export interface PALetterResult {
  letter: string;
  key_points: string[];
  word_count: number;
  recommendation: string;
}

const SYSTEM_PROMPT = `You are a medical writer specializing in prior authorization letters. Write a professional, persuasive PA request letter for submission to an insurance company.

The letter must include:
1. Proper business letter header (date, addressed to Medical Review Department of the insurance plan)
2. Patient identification (anonymized - use first name + last initial only)
3. Clear statement of the requested treatment (name, dose, frequency, duration)
4. Clinical rationale with each criterion explicitly addressed
5. Prior treatment history with dates and durations
6. Laboratory and clinical evidence supporting medical necessity
7. Prescriber sign-off (use ONLY the prescriber info actually provided)
8. Request for timely review

Format as a properly formatted business letter in plain text (no markdown). Aim for 400-600 words. Professional tone, factual content, persuasive structure.

CRITICAL RULES:
- Do NOT include any placeholder brackets like [Patient Name], [License Number], [Contact Information], [Not Provided], [Phone], [Email], [Address]
- If you don't have a specific piece of information, simply OMIT that line entirely - do NOT write a placeholder
- For the signature block, only include fields for which you have actual data (e.g. name and specialty from the prescriber string)
- Do NOT invent license numbers, phone numbers, addresses, or NPIs
- The letter should read as a complete, submission-ready document with no blanks`;

export async function generatePALetter(
  input: z.infer<typeof GeneratePALetterInput>
): Promise<PALetterResult> {
  const profile = input.patient_profile as unknown as PatientProfile;
  const criteria = input.pa_criteria as unknown as PACriteria;
  const assessment = input.assessment as unknown as AssessmentResult;

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const nameParts = profile.patient.name.split(" ");
  const anonymizedName = `${nameParts[0]} ${nameParts[nameParts.length - 1]?.[0] ?? ""}.`;

  const userMessage = `Write a prior authorization letter with these details:

Date: ${today}
Insurance Plan: ${profile.insurance_plan}
Addressed to: Medical Review Department, ${profile.insurance_plan}

PATIENT (anonymized):
- Name: ${anonymizedName}
- Age: ${profile.patient.age}
- Gender: ${profile.patient.gender}
- Diagnoses: ${profile.patient.diagnoses
    .map((d) => `${d.description} (ICD-10: ${d.code})${d.severity ? ` - ${d.severity}` : ""}`)
    .join("; ")}

REQUESTED TREATMENT: ${criteria.brand_name} (${criteria.drug_class})
${profile.patient.proposed_treatment_from_ehr ? `Details from EHR: ${profile.patient.proposed_treatment_from_ehr}` : ""}

PRIOR FAILED TREATMENTS (prerequisite for biologics/specialty drugs):
${profile.patient.prior_failed_treatments
  .map(
    (t) =>
      `- ${t.name} ${t.dose} for ${t.duration}. Reason discontinued: ${t.reason_stopped}`
  )
  .join("\n")}

CURRENT MEDICATIONS:
${profile.patient.current_medications.map((m) => `- ${m.name} ${m.dose} (${m.status})`).join("\n")}

RELEVANT LABS AND CLINICAL MEASURES:
${profile.patient.lab_results
  .map((l) => `- ${l.test}: ${l.value} on ${l.date}${l.interpretation ? ` (${l.interpretation})` : ""}`)
  .join("\n")}

RELEVANT CLINICAL HISTORY:
${profile.patient.relevant_history}

PRESCRIBER: ${profile.patient.prescriber ?? "Attending physician"}

PA CRITERIA ASSESSMENT:
Overall recommendation: ${assessment.overall_recommendation}
Confidence: ${Math.round(assessment.confidence * 100)}%
${assessment.criteria_results
  .filter((r) => r.met)
  .map(
    (r) =>
      `- Criterion ${r.criterion_id} MET: ${r.reasoning} Evidence: ${r.supporting_evidence}`
  )
  .join("\n")}

Write the complete prior authorization request letter now. Be persuasive but factual.`;

  const letter = await callLLM(SYSTEM_PROMPT, userMessage, {
    maxTokens: 2000,
  });

  const keyPoints = assessment.criteria_results
    .filter((r) => r.met && r.required)
    .map((r) => r.reasoning.split(".")[0]?.trim() ?? "")
    .filter((s) => s.length > 0)
    .slice(0, 5);

  return {
    letter,
    key_points: keyPoints,
    word_count: letter.split(/\s+/).filter(Boolean).length,
    recommendation: assessment.overall_recommendation,
  };
}
