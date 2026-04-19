import axios, { AxiosInstance } from "axios";

export interface FHIRContext {
  serverUrl: string;
  accessToken?: string;
  patientId: string;
}

export interface FHIRBundle {
  resourceType: "Bundle";
  entry?: Array<{ resource: Record<string, unknown> }>;
  total?: number;
}

export class FHIRClient {
  private client: AxiosInstance;
  private patientId: string;

  constructor(context: FHIRContext) {
    this.patientId = context.patientId;
    this.client = axios.create({
      baseURL: context.serverUrl,
      headers: {
        Accept: "application/fhir+json",
        "Content-Type": "application/fhir+json",
        ...(context.accessToken
          ? { Authorization: `Bearer ${context.accessToken}` }
          : {}),
      },
      timeout: 30000,
    });
  }

  async getPatient(): Promise<Record<string, unknown>> {
    const response = await this.client.get(`/Patient/${this.patientId}`);
    return response.data;
  }

  async searchByPatient(
    resourceType: string,
    searchParam: string = "subject"
  ): Promise<Record<string, unknown>[]> {
    const param = searchParam === "beneficiary" ? "beneficiary" : "subject";
    const response = await this.client.get<FHIRBundle>(
      `/${resourceType}?${param}=Patient/${this.patientId}&_count=100`
    );
    return response.data.entry?.map((e) => e.resource) ?? [];
  }

  async getConditions(): Promise<Record<string, unknown>[]> {
    return this.searchByPatient("Condition");
  }

  async getMedicationStatements(): Promise<Record<string, unknown>[]> {
    return this.searchByPatient("MedicationStatement");
  }

  async getObservations(): Promise<Record<string, unknown>[]> {
    return this.searchByPatient("Observation");
  }

  async getMedicationRequests(): Promise<Record<string, unknown>[]> {
    return this.searchByPatient("MedicationRequest");
  }

  async getCoverage(): Promise<Record<string, unknown>[]> {
    return this.searchByPatient("Coverage", "beneficiary");
  }

  async getAllergyIntolerances(): Promise<Record<string, unknown>[]> {
    return this.searchByPatient("AllergyIntolerance", "patient");
  }

  async getEverything(): Promise<{
    patient: Record<string, unknown>;
    conditions: Record<string, unknown>[];
    medicationStatements: Record<string, unknown>[];
    observations: Record<string, unknown>[];
    medicationRequests: Record<string, unknown>[];
    coverage: Record<string, unknown>[];
  }> {
    const [
      patient,
      conditions,
      medicationStatements,
      observations,
      medicationRequests,
      coverage,
    ] = await Promise.all([
      this.getPatient(),
      this.getConditions(),
      this.getMedicationStatements(),
      this.getObservations(),
      this.getMedicationRequests(),
      this.getCoverage(),
    ]);

    return {
      patient,
      conditions,
      medicationStatements,
      observations,
      medicationRequests,
      coverage,
    };
  }
}

export function calculateAge(birthDate: string): number {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}
