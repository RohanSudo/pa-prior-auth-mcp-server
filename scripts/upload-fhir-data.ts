import "dotenv/config";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FHIR_SERVER_URL = process.env.FHIR_SERVER_URL || "https://hapi.fhir.org/baseR4";
const RESOURCES_DIR = join(__dirname, "../src/data/fhir-resources");

async function uploadBundle(bundleFile: string): Promise<void> {
  const bundlePath = join(RESOURCES_DIR, bundleFile);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf-8"));

  console.log(`\nUploading ${bundleFile} to ${FHIR_SERVER_URL}...`);
  console.log(`  Bundle has ${bundle.entry?.length || 0} resources`);

  try {
    const response = await axios.post(FHIR_SERVER_URL, bundle, {
      headers: {
        "Content-Type": "application/fhir+json",
        Accept: "application/fhir+json",
      },
      timeout: 60000,
    });

    const successCount =
      response.data.entry?.filter((e: { response?: { status?: string } }) =>
        e.response?.status?.startsWith("200") || e.response?.status?.startsWith("201")
      ).length || 0;
    const totalCount = response.data.entry?.length || 0;

    console.log(`  ✓ Success: ${successCount}/${totalCount} resources created/updated`);

    if (successCount < totalCount) {
      console.log("  Warnings:");
      response.data.entry?.forEach((e: { response?: { status?: string; outcome?: unknown } }, i: number) => {
        if (!e.response?.status?.startsWith("2")) {
          console.log(`    Entry ${i}: ${e.response?.status}`, JSON.stringify(e.response?.outcome).slice(0, 200));
        }
      });
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`  ✗ Failed: ${err.response?.status} ${err.response?.statusText}`);
      console.error(`  Details:`, JSON.stringify(err.response?.data).slice(0, 500));
    } else {
      console.error(`  ✗ Failed:`, err);
    }
    throw err;
  }
}

async function verifyPatient(patientId: string): Promise<void> {
  console.log(`\nVerifying Patient/${patientId} exists...`);
  try {
    const response = await axios.get(`${FHIR_SERVER_URL}/Patient/${patientId}`, {
      headers: { Accept: "application/fhir+json" },
      timeout: 30000,
    });
    const name = response.data.name?.[0];
    console.log(`  ✓ Found: ${name?.given?.join(" ")} ${name?.family} (${response.data.gender}, born ${response.data.birthDate})`);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`  ✗ Patient not found: ${err.response?.status}`);
    }
    throw err;
  }
}

async function verifyPatientResources(patientId: string): Promise<void> {
  console.log(`\nFetching all resources for Patient/${patientId}...`);

  const resourceTypes = ["Condition", "MedicationStatement", "Observation", "Coverage", "MedicationRequest"];

  for (const type of resourceTypes) {
    try {
      const url = type === "Coverage"
        ? `${FHIR_SERVER_URL}/${type}?beneficiary=Patient/${patientId}`
        : `${FHIR_SERVER_URL}/${type}?subject=Patient/${patientId}`;

      const response = await axios.get(url, {
        headers: { Accept: "application/fhir+json" },
        timeout: 30000,
      });
      const count = response.data.total ?? response.data.entry?.length ?? 0;
      console.log(`  ${type}: ${count} resource(s)`);
    } catch (err) {
      console.log(`  ${type}: error fetching`);
    }
  }
}

async function main(): Promise<void> {
  const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.error("No FHIR bundle files found in", RESOURCES_DIR);
    process.exit(1);
  }

  console.log(`Found ${files.length} FHIR bundle(s) to upload:`);
  files.forEach((f) => console.log(`  - ${f}`));

  for (const file of files) {
    await uploadBundle(file);
  }

  console.log("\n========================================");
  console.log("VERIFICATION");
  console.log("========================================");

  await verifyPatient("pa-mcp-alice-001");
  await verifyPatientResources("pa-mcp-alice-001");

  console.log("\n✓ All done. Alice is live on the FHIR sandbox.");
  console.log(`  Patient URL: ${FHIR_SERVER_URL}/Patient/pa-mcp-alice-001`);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
