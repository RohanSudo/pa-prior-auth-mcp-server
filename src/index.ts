import "dotenv/config";
import express, { type Request, type Response } from "express";

import {
  BuildPatientProfileInput,
  buildPatientProfile,
} from "./tools/build-patient-profile.js";
import {
  LookupPACriteriaInput,
  lookupPACriteria,
} from "./tools/lookup-pa-criteria.js";
import {
  AssessMedicalNecessityInput,
  assessMedicalNecessity,
} from "./tools/assess-medical-necessity.js";
import {
  GeneratePALetterInput,
  generatePALetter,
} from "./tools/generate-pa-letter.js";
import { extractFHIRContext } from "./middleware/fhir-context.js";

const SERVER_INFO = {
  name: "pa-prior-auth-mcp-server",
  version: "1.0.0",
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

const FHIR_EXTENSION_KEY = "ai.promptopinion/fhir-context";
const FHIR_SCOPES = [
  { name: "patient/Patient.rs", required: true },
  { name: "patient/Condition.rs", required: true },
  { name: "patient/MedicationStatement.rs", required: true },
  { name: "patient/Observation.rs", required: true },
  { name: "patient/MedicationRequest.rs", required: false },
  { name: "patient/Coverage.rs", required: false },
];

const TOOL_DEFINITIONS = [
  {
    name: "build_patient_profile",
    description:
      "Fetches a patient's clinical data from the FHIR server (using request context headers) and builds a structured clinical profile optimized for prior authorization review. Returns patient demographics, diagnoses, current medications, prior failed treatments, lab results, and prescriber info. Required FHIR context: X-FHIR-Server-URL, X-Patient-ID.",
    inputSchema: {
      type: "object",
      properties: {
        proposed_treatment_code: {
          type: "string",
          description:
            'Drug identifier for the requested treatment. Available keys: "adalimumab", "dupilumab", "insulin_pump", "amphetamine_xr", "ketamine_infusion"',
        },
        insurance_plan: {
          type: "string",
          description:
            'Insurance plan name. Available plans: "BlueCross Standard", "Aetna Premium", "United Silver"',
        },
      },
      required: ["proposed_treatment_code", "insurance_plan"],
    },
  },
  {
    name: "lookup_pa_criteria",
    description:
      "Returns the prior authorization criteria required by a specific insurance plan for a specific drug or treatment. Pure data lookup, no AI required. Does NOT require FHIR context.",
    inputSchema: {
      type: "object",
      properties: {
        insurance_plan: {
          type: "string",
          description:
            'Insurance plan. Available: "BlueCross Standard", "Aetna Premium", "United Silver"',
        },
        drug_key: {
          type: "string",
          description:
            'Drug identifier. Available: "adalimumab", "dupilumab", "insulin_pump", "amphetamine_xr", "ketamine_infusion"',
        },
      },
      required: ["insurance_plan", "drug_key"],
    },
  },
  {
    name: "assess_medical_necessity",
    description:
      "Evaluates whether a patient's clinical data meets each prior authorization criterion. Provides per-criterion reasoning with evidence quotes, overall recommendation (APPROVE/DENY/NEEDS_MORE_INFO), confidence score, documentation gaps, and strengthening suggestions. Does NOT require FHIR context - consumes output of build_patient_profile and lookup_pa_criteria.",
    inputSchema: {
      type: "object",
      properties: {
        patient_profile: {
          type: "object",
          description: "Full output from build_patient_profile tool",
        },
        pa_criteria: {
          type: "object",
          description:
            "The criteria_data field from lookup_pa_criteria output",
        },
      },
      required: ["patient_profile", "pa_criteria"],
    },
  },
  {
    name: "generate_pa_letter",
    description:
      "Generates a complete, professional prior authorization request letter ready for submission to the insurance company. Incorporates patient data, clinical rationale, and assessment results. Uses anonymized patient identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        patient_profile: {
          type: "object",
          description: "Output from build_patient_profile",
        },
        pa_criteria: {
          type: "object",
          description: "The criteria_data from lookup_pa_criteria",
        },
        assessment: {
          type: "object",
          description: "Output from assess_medical_necessity",
        },
      },
      required: ["patient_profile", "pa_criteria", "assessment"],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function success(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  req: Request
): Promise<unknown> {
  switch (toolName) {
    case "build_patient_profile": {
      const input = BuildPatientProfileInput.parse(args);
      const fhirContext = extractFHIRContext(req);
      if (!fhirContext) {
        throw new Error(
          "build_patient_profile requires FHIR context. Missing required header X-Patient-ID or X-FHIR-Server-URL."
        );
      }
      return await buildPatientProfile(input, fhirContext);
    }
    case "lookup_pa_criteria": {
      const input = LookupPACriteriaInput.parse(args);
      return lookupPACriteria(input);
    }
    case "assess_medical_necessity": {
      const input = AssessMedicalNecessityInput.parse(args);
      return await assessMedicalNecessity(input);
    }
    case "generate_pa_letter": {
      const input = GeneratePALetterInput.parse(args);
      return await generatePALetter(input);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleRpcRequest(
  request: JsonRpcRequest,
  req: Request
): Promise<JsonRpcResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize": {
        const clientProtocolVersion =
          (params?.protocolVersion as string) || SUPPORTED_PROTOCOL_VERSIONS[0];
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(clientProtocolVersion)
          ? clientProtocolVersion
          : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

        return success(id, {
          protocolVersion,
          capabilities: {
            tools: {},
            extensions: {
              [FHIR_EXTENSION_KEY]: {
                scopes: FHIR_SCOPES,
              },
            },
          },
          serverInfo: SERVER_INFO,
        });
      }

      case "tools/list": {
        return success(id, { tools: TOOL_DEFINITIONS });
      }

      case "tools/call": {
        const toolName = params?.name as string;
        const args = (params?.arguments as Record<string, unknown>) || {};
        if (!toolName) {
          return error(id, -32602, "Missing required parameter: name");
        }
        try {
          const result = await handleToolCall(toolName, args, req);
          return success(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return success(id, {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
          });
        }
      }

      case "ping": {
        return success(id, {});
      }

      case "notifications/initialized": {
        return success(id, {});
      }

      default:
        return error(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(id, -32603, `Internal error: ${message}`);
  }
}

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: SERVER_INFO.name, version: SERVER_INFO.version });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description:
      "Prior Authorization MCP Server - FHIR-native tools for automating prior auth workflow",
    mcpEndpoint: "/mcp",
    healthEndpoint: "/health",
    restApiEndpoint: "/api/tools/{tool_name}",
    fhirExtension: FHIR_EXTENSION_KEY,
    tools: TOOL_DEFINITIONS.map((t) => t.name),
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const body = req.body as JsonRpcRequest | JsonRpcRequest[];

  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((r) => handleRpcRequest(r, req)));
    res.json(responses);
    return;
  }

  const response = await handleRpcRequest(body, req);
  res.json(response);
});

app.post("/api/tools/:toolName", async (req: Request, res: Response) => {
  const toolName = req.params.toolName as string;
  try {
    const result = await handleToolCall(toolName, req.body as Record<string, unknown>, req);
    res.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

app.listen(PORT, () => {
  console.log(`PA Prior Auth MCP Server v${SERVER_INFO.version}`);
  console.log(`Listening on port ${PORT}`);
  console.log(`  Health:       http://localhost:${PORT}/health`);
  console.log(`  Info:         http://localhost:${PORT}/`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp (POST JSON-RPC)`);
  console.log(`  REST API:     http://localhost:${PORT}/api/tools/{name} (POST)`);
  console.log(`  FHIR ext:     ${FHIR_EXTENSION_KEY}`);
  console.log(`  Tools:        ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`);
});
