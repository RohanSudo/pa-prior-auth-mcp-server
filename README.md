# PA Prior Authorization MCP Server

A FHIR-native MCP server that automates the prior authorization workflow. Built for the Agents Assemble hackathon (Prompt Opinion).

## What it does

Turns a doctor's 2-hour prior authorization paperwork task into a 30-second AI pipeline. Given a Patient ID and proposed treatment, it:

1. Fetches the patient's clinical data from a FHIR server
2. Looks up the insurance company's PA criteria
3. Evaluates each criterion against the patient's clinical evidence
4. Generates a ready-to-submit PA request letter

Prior authorization wastes ~40 hours per physician per week in the US. This MCP server plugs into any Prompt Opinion agent (or any MCP-compatible AI) to eliminate that burden.

## Architecture

```
[Prompt Opinion agent]
        |
        | MCP call with FHIR context headers:
        |   X-FHIR-Server-URL
        |   X-FHIR-Access-Token
        |   X-Patient-ID
        v
[This MCP Server] (Express + @modelcontextprotocol/sdk)
        |
        +---> build_patient_profile (fetches FHIR data, summarizes with LLM)
        +---> lookup_pa_criteria    (insurance criteria lookup, no LLM)
        +---> assess_medical_necessity (per-criterion AI evaluation)
        +---> generate_pa_letter    (drafts the submission letter)
        |
[FHIR server]  [Groq / Gemini]
```

The server declares the `ai.promptopinion/fhir-context` capability extension during MCP `initialize` and exposes 4 tools.

## Tools

### `build_patient_profile`
Fetches patient data from FHIR (using request context headers) and returns a structured clinical profile with demographics, diagnoses, current medications, prior failed treatments, lab results, and prescriber info.

- **Input**: `proposed_treatment_code`, `insurance_plan`
- **Requires FHIR context**: Yes (`X-FHIR-Server-URL`, `X-Patient-ID`)
- **Uses LLM**: Yes (for synthesis)

### `lookup_pa_criteria`
Returns the PA criteria required by a specific insurance plan for a specific drug. Pure data lookup.

- **Input**: `insurance_plan`, `drug_key`
- **Requires FHIR context**: No
- **Uses LLM**: No

### `assess_medical_necessity`
Evaluates each criterion against the patient profile and returns per-criterion reasoning, overall recommendation (APPROVE/DENY/NEEDS_MORE_INFO), confidence score, documentation gaps, and strengthening suggestions.

- **Input**: `patient_profile`, `pa_criteria`
- **Requires FHIR context**: No
- **Uses LLM**: Yes

### `generate_pa_letter`
Generates a complete, professional PA request letter ready for submission. Uses anonymized patient identifiers.

- **Input**: `patient_profile`, `pa_criteria`, `assessment`
- **Requires FHIR context**: No
- **Uses LLM**: Yes

## Synthetic data

All data is fake. No real PHI used anywhere.

### Patients

| Patient ID | Name | Condition | Requested Drug | Insurance |
|-----------|------|-----------|----------------|-----------|
| pa-mcp-alice-001 | Alice Morrison, 45F | Rheumatoid Arthritis | adalimumab (Humira) | BlueCross Standard |
| pa-mcp-bob-002 | Bob Kowalski, 52M | Type 2 Diabetes | insulin_pump (Omnipod) | Aetna Premium |
| pa-mcp-carla-003 | Carla Reyes, 28F | Severe ADHD | amphetamine_xr (Adderall XR) | United Silver |
| pa-mcp-david-004 | David Patel, 61M | Severe Asthma | dupilumab (Dupixent) | BlueCross Standard |
| pa-mcp-emma-005 | Emma Thompson, 38F | Treatment-Resistant Depression | ketamine_infusion | Aetna Premium |

### Insurance plans (synthetic)

- BlueCross Standard
- Aetna Premium
- United Silver

### FHIR sandbox

Patients are uploaded to the public HAPI FHIR R4 sandbox at `https://hapi.fhir.org/baseR4`. To re-upload:

```bash
npm run upload-fhir
```

## Local setup

### Prerequisites
- Node.js 20+ (check: `node --version`)
- Groq API key (free, https://console.groq.com)
- Optional: Google Gemini API key as fallback (https://aistudio.google.com)

### Install and run

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env   # or create .env manually
# Edit .env and add your GROQ_API_KEY and optionally GEMINI_API_KEY

# Start the server
npm run start
```

The server runs on port 3000 by default.

### Environment variables

| Variable | Required | Default | Purpose |
|----------|---------|---------|---------|
| `GROQ_API_KEY` | Yes | - | Groq API key for primary LLM |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Groq model to use |
| `GEMINI_API_KEY` | No | - | Optional fallback provider |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Gemini model |
| `FHIR_SERVER_URL` | No | `https://hapi.fhir.org/baseR4` | Default FHIR server (overridden by request headers) |
| `PORT` | No | `3000` | HTTP port |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Server info |
| GET | `/health` | Health check (returns `{"status":"ok",...}`) |
| POST | `/mcp` | MCP JSON-RPC endpoint (for Prompt Opinion) |
| POST | `/api/tools/:toolName` | REST alias for each tool (easier for testing/n8n) |

## MCP protocol

The server implements the minimum required MCP methods:

- `initialize` - returns capabilities including the `ai.promptopinion/fhir-context` extension with required FHIR scopes
- `tools/list` - returns the 4 tool definitions
- `tools/call` - dispatches to the named tool

### Initialize response

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": {
    "tools": {},
    "extensions": {
      "ai.promptopinion/fhir-context": {
        "scopes": [
          { "name": "patient/Patient.rs", "required": true },
          { "name": "patient/Condition.rs", "required": true },
          { "name": "patient/MedicationStatement.rs", "required": true },
          { "name": "patient/Observation.rs", "required": true },
          { "name": "patient/MedicationRequest.rs", "required": false },
          { "name": "patient/Coverage.rs", "required": false }
        ]
      }
    }
  },
  "serverInfo": { "name": "pa-prior-auth-mcp-server", "version": "1.0.0" }
}
```

## Example

Calling Tool 1 via the REST alias with Alice's FHIR context:

```bash
curl -X POST http://localhost:3000/api/tools/build_patient_profile \
  -H "Content-Type: application/json" \
  -H "X-FHIR-Server-URL: https://hapi.fhir.org/baseR4" \
  -H "X-Patient-ID: pa-mcp-alice-001" \
  -d '{"proposed_treatment_code":"adalimumab","insurance_plan":"BlueCross Standard"}'
```

Returns a structured profile with 45F, RA diagnosis, 2 prior failed DMARDs, lab values, and prescriber info.

## Rate limits (free tiers)

- **Groq** (Llama 3.3 70B free tier): 12,000 tokens/minute, 100,000 tokens/day
- **Gemini** (2.0 Flash free tier): varies by project

One full PA pipeline run (all 4 tools) uses ~4,000-6,000 tokens. The free tier supports ~20 full runs per day per Groq key. For demo use this is plenty; for production, upgrade or rotate keys.

The LLM client automatically falls back from Groq to Gemini on rate-limit errors.

## Deployment

See deployment instructions for Railway. The `railway.toml` and `Procfile` are configured for Railway auto-deployment from GitHub.

## License

ISC
