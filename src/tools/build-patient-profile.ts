import { z } from "zod";
import { callLLMForJSON } from "../lib/groq-client.js";
import { FHIRClient, FHIRContext, calculateAge } from "../lib/fhir-client.js";

export const BuildPatientProfileInput = z.object({
  proposed_treatment_code: z
    .string()
    .describe(
      'Drug key matching insurance-criteria.json, e.g. "adalimumab", "insulin_pump"'
    ),
  insurance_plan: z
    .string()
    .describe(
      'Insurance plan name, e.g. "BlueCross Standard", "Aetna Premium", "United Silver"'
    ),
});

export interface PatientProfile {
  patient: {
    patient_id: string;
    name: string;
    age: number;
    gender: string;
    diagnoses: Array<{
      code: string;
      description: string;
      severity?: string;
      onset_date?: string;
    }>;
    current_medications: Array<{
      name: string;
      dose: string;
      status: string;
    }>;
    prior_failed_treatments: Array<{
      name: string;
      dose: string;
      duration: string;
      reason_stopped: string;
    }>;
    lab_results: Array<{
      test: string;
      value: string;
      date: string;
      interpretation?: string;
    }>;
    relevant_history: string;
    proposed_treatment_from_ehr?: string;
    prescriber?: string;
  };
  proposed_treatment: {
    name: string;
    drug_key: string;
  };
  insurance_plan: string;
}

const SYSTEM_PROMPT = `You are a medical data synthesis specialist. You receive raw FHIR resource data for a patient and produce a concise clinical profile optimized for prior authorization review.

Extract and synthesize the data into the JSON structure specified. Be precise and evidence-based. Quote specific values from the FHIR data.

Return ONLY a JSON object with this exact structure:
{
  "patient": {
    "patient_id": "<FHIR patient id>",
    "name": "<full name>",
    "age": <integer>,
    "gender": "<male|female|other>",
    "diagnoses": [
      {
        "code": "<ICD-10 code>",
        "description": "<diagnosis>",
        "severity": "<optional severity>",
        "onset_date": "<YYYY-MM-DD>"
      }
    ],
    "current_medications": [
      { "name": "<drug>", "dose": "<dose + freq>", "status": "active" }
    ],
    "prior_failed_treatments": [
      {
        "name": "<drug>",
        "dose": "<dose>",
        "duration": "<duration>",
        "reason_stopped": "<why discontinued>"
      }
    ],
    "lab_results": [
      {
        "test": "<test name>",
        "value": "<value with units>",
        "date": "<YYYY-MM-DD>",
        "interpretation": "<optional - high/low/normal>"
      }
    ],
    "relevant_history": "<2-3 sentence summary of clinically relevant history>",
    "proposed_treatment_from_ehr": "<if there's a MedicationRequest with status=draft, include its description>",
    "prescriber": "<prescriber name and specialty from MedicationRequest.requester if available>"
  }
}

Only include entries in prior_failed_treatments if the MedicationStatement has status="stopped" with a reason indicating failure/inadequate response.`;

export async function buildPatientProfile(
  input: z.infer<typeof BuildPatientProfileInput>,
  fhirContext: FHIRContext
): Promise<PatientProfile> {
  const fhir = new FHIRClient(fhirContext);
  const data = await fhir.getEverything();

  const userMessage = `Process the following FHIR resources for patient ${fhirContext.patientId}. The proposed treatment is "${input.proposed_treatment_code}" for insurance plan "${input.insurance_plan}".

FHIR DATA:
=== Patient ===
${JSON.stringify(data.patient, null, 2)}

=== Conditions (${data.conditions.length}) ===
${JSON.stringify(data.conditions, null, 2)}

=== MedicationStatements (${data.medicationStatements.length}) ===
${JSON.stringify(data.medicationStatements, null, 2)}

=== Observations (${data.observations.length}) ===
${JSON.stringify(data.observations, null, 2)}

=== MedicationRequests (${data.medicationRequests.length}) ===
${JSON.stringify(data.medicationRequests, null, 2)}

=== Coverage (${data.coverage.length}) ===
${JSON.stringify(data.coverage, null, 2)}

Extract the clinical profile as specified. Be concise but complete.`;

  const llmResponse = await callLLMForJSON<{ patient: PatientProfile["patient"] }>(
    SYSTEM_PROMPT,
    userMessage,
    { maxTokens: 3000 }
  );

  const patientResource = data.patient as {
    id?: string;
    birthDate?: string;
    gender?: string;
  };

  const calculatedAge = patientResource.birthDate
    ? calculateAge(patientResource.birthDate)
    : llmResponse.patient.age;

  return {
    patient: {
      ...llmResponse.patient,
      patient_id: fhirContext.patientId,
      age: calculatedAge,
    },
    proposed_treatment: {
      name: input.proposed_treatment_code,
      drug_key: input.proposed_treatment_code,
    },
    insurance_plan: input.insurance_plan,
  };
}
