/**
 * Pure per-document completeness gate for the Wave 2 filing vertical.
 *
 * A supported form name is not enough to make a document calculation-ready.
 * Every implemented monetary box and every explicitly out-of-scope material
 * box must be reviewed. Blank printed monetary boxes are represented as zero;
 * omission remains needs_information and a non-zero unsupported box fails the
 * vertical closed.
 */

import type { DocumentCoverageV2 } from "./filing-requirements.ts";

export type { DocumentCoverageV2 } from "./filing-requirements.ts";
export type Wave2DocumentType = DocumentCoverageV2["documentType"];

export type DocumentCoverageFactV2 = {
  key: string;
  value: unknown;
};

export type DocumentCoverageInputV2 = {
  documentId: string;
  documentType: Wave2DocumentType;
  documentStatus: string;
  facts: DocumentCoverageFactV2[];
  evidenceIds: string[];
};

type FormSpec = {
  required: ReadonlyArray<{ field: string; semanticBasis: string }>;
  unsupported: readonly string[];
  stateField?: string;
  stateAmountField?: string;
  stateRequired?: boolean;
};

export const WAVE2_DOCUMENT_FORM_SPECS: Readonly<Record<Wave2DocumentType, FormSpec>> = {
  w2_2025: {
    required: [
      { field: "box_1_wages", semanticBasis: "w2_box_1_wages" },
      { field: "box_2_federal_income_tax_withheld", semanticBasis: "w2_box_2_federal_withholding" },
      { field: "box_16_state_wages", semanticBasis: "w2_box_16_state_wages" },
      { field: "box_17_state_income_tax", semanticBasis: "w2_box_17_state_withholding" },
    ],
    unsupported: [],
    stateField: "box_15_state",
    stateAmountField: "box_17_state_income_tax",
    stateRequired: true,
  },
  "1099_int_2025": {
    required: [
      { field: "box_1_interest_income", semanticBasis: "interest_income_1099int_box1" },
      { field: "box_4_federal_tax_withheld", semanticBasis: "federal_withholding_1099int_box4" },
      { field: "box_17_state_tax_withheld", semanticBasis: "state_withholding_1099int_box17" },
    ],
    unsupported: [
      "box_2_early_withdrawal_penalty",
      "box_3_interest_us_savings_bonds_treasury_obligations",
      "box_5_investment_expenses",
      "box_6_foreign_tax_paid",
      "box_8_tax_exempt_interest",
      "box_9_specified_private_activity_bond_interest",
      "box_10_market_discount",
      "box_11_bond_premium",
      "box_12_bond_premium_us_treasury_obligations",
      "box_13_bond_premium_tax_exempt_bond",
    ],
    stateField: "box_15_state",
    stateAmountField: "box_17_state_tax_withheld",
  },
  "1099_div_2025": {
    required: [
      {
        field: "box_1a_total_ordinary_dividends",
        semanticBasis: "ordinary_dividends_1099div_box1a",
      },
      {
        field: "box_1b_qualified_dividends",
        semanticBasis: "qualified_dividends_1099div_box1b",
      },
      { field: "box_4_federal_tax_withheld", semanticBasis: "federal_withholding_1099div_box4" },
      { field: "box_16_state_tax_withheld", semanticBasis: "state_withholding_1099div_box16" },
    ],
    unsupported: [
      "box_2a_total_capital_gain_distributions",
      "box_2b_unrecaptured_section_1250_gain",
      "box_2c_section_1202_gain",
      "box_2d_collectibles_28_percent_gain",
      "box_2e_section_897_ordinary_dividends",
      "box_2f_section_897_capital_gain",
      "box_3_nondividend_distributions",
      "box_5_section_199a_dividends",
      "box_6_investment_expenses",
      "box_7_foreign_tax_paid",
      "box_9_cash_liquidation_distributions",
      "box_10_noncash_liquidation_distributions",
      "box_12_exempt_interest_dividends",
      "box_13_specified_private_activity_bond_interest",
    ],
    stateField: "box_14_state",
    stateAmountField: "box_16_state_tax_withheld",
  },
};

function monetaryValue(value: unknown): number | null {
  const raw =
    value && typeof value === "object" && !Array.isArray(value) && "v" in value
      ? (value as { v?: unknown }).v
      : value;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function valuesForField(facts: DocumentCoverageFactV2[], key: string): unknown[] {
  return facts.filter((fact) => fact.key === key).map((fact) => fact.value);
}

function distinctMoney(facts: DocumentCoverageFactV2[], key: string): number[] {
  return [
    ...new Set(
      valuesForField(facts, key)
        .map(monetaryValue)
        .filter((value): value is number => value !== null),
    ),
  ].sort((left, right) => left - right);
}

function processingState(status: string): DocumentCoverageV2["processingState"] {
  if (status === "classified" || status === "complete") return "complete";
  if (status === "needs_review") return "needs_review";
  if (status === "failed") return "failed";
  return "pending";
}

function normalizedStates(facts: DocumentCoverageFactV2[], key: string): string[] {
  return [
    ...new Set(
      valuesForField(facts, key)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort();
}

export function evaluateDocumentCoverageV2(input: DocumentCoverageInputV2): DocumentCoverageV2 {
  const spec = WAVE2_DOCUMENT_FORM_SPECS[input.documentType];
  const processing = processingState(input.documentStatus);
  const requiredSemanticBases = spec.required.map((item) => item.semanticBasis);
  const presentSemanticBases = spec.required
    .filter((item) => distinctMoney(input.facts, item.field).length === 1)
    .map((item) => item.semanticBasis);
  const materialFields = [...spec.required.map((item) => item.field), ...spec.unsupported];
  const reviewedMaterialFields = materialFields.filter(
    (field) => distinctMoney(input.facts, field).length === 1,
  );
  const unsupportedMaterialFields = spec.unsupported.filter((field) =>
    distinctMoney(input.facts, field).some((amount) => amount !== 0),
  );

  const rawStateValues = spec.stateField
    ? valuesForField(input.facts, spec.stateField).filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const stateValues = spec.stateField ? normalizedStates(input.facts, spec.stateField) : [];
  const unsupportedState =
    rawStateValues.length > 1 || stateValues.some((stateCode) => stateCode !== "GA");
  if (unsupportedState && spec.stateField) unsupportedMaterialFields.push(spec.stateField);

  const conflictingRequiredValue = spec.required.some(
    (item) => distinctMoney(input.facts, item.field).length > 1,
  );
  const ordinary = distinctMoney(input.facts, "box_1a_total_ordinary_dividends");
  const qualified = distinctMoney(input.facts, "box_1b_qualified_dividends");
  const invalidDividendSubset =
    input.documentType === "1099_div_2025" &&
    ordinary.length === 1 &&
    qualified.length === 1 &&
    qualified[0] > ordinary[0];
  const stateWithholdingAmounts = spec.stateAmountField
    ? distinctMoney(input.facts, spec.stateAmountField)
    : [];
  const stateMissing =
    stateValues.length === 0 &&
    (spec.stateRequired === true || stateWithholdingAmounts.some((amount) => amount > 0));
  const incomplete =
    processing !== "complete" ||
    input.evidenceIds.length === 0 ||
    presentSemanticBases.length !== requiredSemanticBases.length ||
    reviewedMaterialFields.length !== materialFields.length ||
    stateMissing;
  const missingMaterialFields = materialFields.filter(
    (field) => distinctMoney(input.facts, field).length === 0,
  );
  const conflictingMaterialFields = spec.required
    .filter((item) => distinctMoney(input.facts, item.field).length > 1)
    .map((item) => item.field);

  const state: DocumentCoverageV2["state"] =
    unsupportedMaterialFields.length > 0
      ? "unsupported"
      : conflictingRequiredValue || invalidDividendSubset
        ? "conflicting"
        : incomplete
          ? "needs_information"
          : "complete";
  const reasonCodes = [
    ...(processing !== "complete" ? [`processing_state:${processing}`] : []),
    ...(input.evidenceIds.length === 0 ? ["missing_evidence_lineage"] : []),
    ...missingMaterialFields.map((field) => `missing_material_field:${field}`),
    ...conflictingMaterialFields.map((field) => `conflicting_material_field:${field}`),
    ...unsupportedMaterialFields.map((field) =>
      field === spec.stateField
        ? `unsupported_state_row:${field}`
        : `unsupported_material_field:${field}`,
    ),
    ...(stateMissing && spec.stateField ? [`missing_state_row:${spec.stateField}`] : []),
    ...(invalidDividendSubset ? ["qualified_dividends_exceed_ordinary"] : []),
  ];

  return {
    documentId: input.documentId,
    documentType: input.documentType,
    processingState: processing,
    requiredSemanticBases: [...requiredSemanticBases],
    presentSemanticBases: [...new Set(presentSemanticBases)].sort(),
    reviewedMaterialFields: [...new Set(reviewedMaterialFields)].sort(),
    unsupportedMaterialFields: [...new Set(unsupportedMaterialFields)].sort(),
    evidenceIds: [...new Set(input.evidenceIds)].sort(),
    state,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}
