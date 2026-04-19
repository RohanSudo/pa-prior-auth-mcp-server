import type { Request } from "express";
import type { FHIRContext } from "../lib/fhir-client.js";

export function extractFHIRContext(req: Request): FHIRContext | null {
  const serverUrl = (req.headers["x-fhir-server-url"] as string) || process.env.FHIR_SERVER_URL;
  const accessToken = req.headers["x-fhir-access-token"] as string | undefined;
  const patientId = req.headers["x-patient-id"] as string | undefined;

  if (!serverUrl || !patientId) {
    return null;
  }

  return {
    serverUrl,
    accessToken,
    patientId,
  };
}
