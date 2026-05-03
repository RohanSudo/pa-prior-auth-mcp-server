import "dotenv/config";
import axios from "axios";

const PATIENTS = {
  alice: {
    id: "pa-mcp-alice-001",
    drug: "adalimumab",
    plan: "BlueCross Standard",
    description: "45F, Rheumatoid Arthritis, requesting Humira",
  },
  bob: {
    id: "pa-mcp-bob-002",
    drug: "insulin_pump",
    plan: "Aetna Premium",
    description: "52M, Type 2 Diabetes, requesting Omnipod insulin pump",
  },
  carla: {
    id: "pa-mcp-carla-003",
    drug: "amphetamine_xr",
    plan: "United Silver",
    description: "28F, Severe ADHD, requesting Adderall XR",
  },
  david: {
    id: "pa-mcp-david-004",
    drug: "dupilumab",
    plan: "BlueCross Standard",
    description: "61M, Severe Asthma, requesting Dupixent",
  },
  emma: {
    id: "pa-mcp-emma-005",
    drug: "ketamine_infusion",
    plan: "Aetna Premium",
    description: "38F, Treatment-Resistant Depression, requesting IV ketamine",
  },
} as const;

type PatientKey = keyof typeof PATIENTS;

const SERVER_URL = process.env.DEMO_SERVER_URL || "https://pa-prior-auth-mcp-server.onrender.com";
const FHIR_SERVER_URL = "https://hapi.fhir.org/baseR4";

const patientArg = (process.argv[2]?.toLowerCase() || "alice") as string;

if (patientArg === "--help" || patientArg === "-h") {
  console.log("Usage: npm run demo [patient]");
  console.log("");
  console.log("Available patients:");
  for (const [key, p] of Object.entries(PATIENTS)) {
    console.log(`  ${key.padEnd(8)} ${p.description}`);
  }
  console.log("");
  console.log("Examples:");
  console.log("  npm run demo            # uses alice (default)");
  console.log("  npm run demo bob        # runs the diabetes case");
  console.log("  npm run demo emma       # runs the depression case");
  process.exit(0);
}

if (!(patientArg in PATIENTS)) {
  console.error(`Unknown patient: ${patientArg}`);
  console.error(`Available: ${Object.keys(PATIENTS).join(", ")}`);
  console.error(`Run "npm run demo --help" for details`);
  process.exit(1);
}

const PATIENT = PATIENTS[patientArg as PatientKey];

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
};

function header(text: string): void {
  const line = "=".repeat(72);
  console.log("");
  console.log(`${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  console.log(`${C.cyan}${line}${C.reset}`);
}

function step(num: number, total: number, text: string): void {
  console.log(`\n${C.bold}${C.yellow}[${num}/${total}]${C.reset} ${C.bold}${text}${C.reset}`);
}

function info(label: string, value: string): void {
  console.log(`  ${C.dim}${label}:${C.reset} ${value}`);
}

function callTool(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<unknown> {
  return axios
    .post(
      `${SERVER_URL}/mcp`,
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name, arguments: args },
      },
      {
        headers: { "Content-Type": "application/json", ...headers },
        timeout: 120000,
      }
    )
    .then((r) => {
      const text = r.data.result?.content?.[0]?.text;
      if (!text) throw new Error("Empty response");
      if (r.data.result?.isError) throw new Error(text);
      return JSON.parse(text);
    });
}

async function main(): Promise<void> {
  header("PA Prior Authorization Assistant - Live Demo");
  console.log("");
  info("Server", SERVER_URL);
  info("Patient", `${PATIENT.id} - ${PATIENT.description}`);
  info("FHIR source", `${FHIR_SERVER_URL} (public HAPI sandbox, synthetic data only)`);
  info("Requested treatment", PATIENT.drug);
  info("Insurance plan", PATIENT.plan);
  console.log("");
  console.log(`${C.dim}  (Tip: run 'npm run demo bob' or carla/david/emma to try other cases)${C.reset}`);

  const startTime = Date.now();

  step(1, 4, "build_patient_profile - fetching FHIR data + LLM synthesis");
  const profile = (await callTool(
    "build_patient_profile",
    { proposed_treatment_code: PATIENT.drug, insurance_plan: PATIENT.plan },
    {
      "X-FHIR-Server-URL": FHIR_SERVER_URL,
      "X-Patient-ID": PATIENT.id,
    }
  )) as {
    patient: {
      name: string;
      age: number;
      gender: string;
      diagnoses: Array<{ code: string; description: string }>;
      prior_failed_treatments: Array<{ name: string; duration: string }>;
      lab_results: Array<{ test: string; value: string }>;
      prescriber?: string;
    };
  };
  console.log(`  ${C.green}✓${C.reset} ${profile.patient.name}, ${profile.patient.age}${profile.patient.gender[0]?.toUpperCase()}`);
  console.log(`  ${C.green}✓${C.reset} Diagnoses: ${profile.patient.diagnoses.map((d) => d.description).join(", ")}`);
  if (profile.patient.prior_failed_treatments.length > 0) {
    console.log(`  ${C.green}✓${C.reset} Prior failed: ${profile.patient.prior_failed_treatments.map((t) => `${t.name} (${t.duration})`).join(", ")}`);
  }
  console.log(`  ${C.green}✓${C.reset} Labs: ${profile.patient.lab_results.length} results`);
  console.log(`  ${C.green}✓${C.reset} Prescriber: ${profile.patient.prescriber ?? "n/a"}`);

  step(2, 4, "lookup_pa_criteria - fetching insurance plan requirements");
  const criteriaResult = (await callTool("lookup_pa_criteria", {
    insurance_plan: PATIENT.plan,
    drug_key: PATIENT.drug,
  })) as {
    found: boolean;
    criteria_data: { brand_name: string; criteria: Array<{ id: string; required: boolean; description: string }> };
  };
  console.log(`  ${C.green}✓${C.reset} ${criteriaResult.criteria_data.brand_name}: ${criteriaResult.criteria_data.criteria.length} criteria`);
  criteriaResult.criteria_data.criteria.forEach((c) => {
    const tag = c.required ? `${C.red}[REQ]${C.reset}` : `${C.dim}[opt]${C.reset}`;
    console.log(`    ${tag} ${c.id}: ${c.description.slice(0, 90)}${c.description.length > 90 ? "..." : ""}`);
  });

  step(3, 4, "assess_medical_necessity - AI evaluating each criterion against patient data");
  const assessment = (await callTool("assess_medical_necessity", {
    patient_profile: profile,
    pa_criteria: criteriaResult.criteria_data,
  })) as {
    overall_recommendation: string;
    confidence: number;
    criteria_results: Array<{ criterion_id: string; met: boolean; reasoning: string }>;
  };
  const recColor = assessment.overall_recommendation === "APPROVE" ? C.green : assessment.overall_recommendation === "DENY" ? C.red : C.yellow;
  console.log(`  ${C.green}✓${C.reset} Recommendation: ${recColor}${C.bold}${assessment.overall_recommendation}${C.reset} (${Math.round(assessment.confidence * 100)}% confidence)`);
  assessment.criteria_results.forEach((r) => {
    const mark = r.met ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`    ${mark} ${r.criterion_id}: ${r.reasoning.slice(0, 100)}${r.reasoning.length > 100 ? "..." : ""}`);
  });

  step(4, 4, "generate_pa_letter - drafting submission letter");
  const letter = (await callTool("generate_pa_letter", {
    patient_profile: profile,
    pa_criteria: criteriaResult.criteria_data,
    assessment,
  })) as { letter: string; word_count: number };
  console.log(`  ${C.green}✓${C.reset} Generated letter: ${letter.word_count} words`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  header("GENERATED PRIOR AUTHORIZATION LETTER");
  console.log("");
  console.log(`${C.dim}${letter.letter}${C.reset}`);

  header(`COMPLETE - End-to-end PA workflow in ${elapsed}s`);
  console.log("");
  console.log(`${C.green}${C.bold}  Recommendation: ${assessment.overall_recommendation}${C.reset}`);
  console.log(`${C.green}  Letter ready for submission to ${PATIENT.plan}${C.reset}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n${C.red}FATAL:${C.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
