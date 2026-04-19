import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PACriterion {
  id: string;
  description: string;
  required: boolean;
}

export interface PACriteria {
  brand_name: string;
  drug_class: string;
  criteria: PACriterion[];
  documentation_required: string[];
  typical_timeline: string;
  appeal_available: boolean;
}

type CriteriaDb = Record<string, Record<string, PACriteria>>;

const criteriaDb = JSON.parse(
  readFileSync(join(__dirname, "../data/insurance-criteria.json"), "utf-8")
) as CriteriaDb;

export const LookupPACriteriaInput = z.object({
  insurance_plan: z
    .string()
    .describe('Insurance plan name, e.g. "BlueCross Standard"'),
  drug_key: z
    .string()
    .describe(
      'Drug key matching insurance-criteria.json, e.g. "adalimumab", "insulin_pump"'
    ),
});

export interface LookupResult {
  found: boolean;
  insurance_plan: string;
  drug_key: string;
  criteria_data?: PACriteria;
  error?: string;
  available_plans?: string[];
  available_drugs_for_plan?: string[];
}

export function lookupPACriteria(
  input: z.infer<typeof LookupPACriteriaInput>
): LookupResult {
  const { insurance_plan, drug_key } = input;

  const planData = criteriaDb[insurance_plan];
  if (!planData) {
    return {
      found: false,
      insurance_plan,
      drug_key,
      error: `Insurance plan "${insurance_plan}" not found in database`,
      available_plans: Object.keys(criteriaDb),
    };
  }

  const drugData = planData[drug_key];
  if (!drugData) {
    return {
      found: false,
      insurance_plan,
      drug_key,
      error: `Drug "${drug_key}" not found for plan "${insurance_plan}"`,
      available_drugs_for_plan: Object.keys(planData),
    };
  }

  return {
    found: true,
    insurance_plan,
    drug_key,
    criteria_data: drugData,
  };
}
