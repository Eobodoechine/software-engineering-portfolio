// Shared extraction contract for the discovery pipeline.
// The tool schema below is what Claude is forced to return for every document.
// Keep the doc_type list and fact vocabulary in sync with the intelligence layer.

import { WAVE2_DOCUMENT_FORM_SPECS } from "./document-form-coverage.ts";

export const DOC_TYPES = [
  "w2_2025",
  "1099_int_2025",
  "1099_div_2025",
  "1099_nec_2025",
  "1099_misc_2025",
  "1099_k_2025",
  "1098_2025",
  "unknown_tax_document",
] as const;

export const UNKNOWN_TAX_DOCUMENT = "unknown_tax_document";

export const SUNDAY_MVP_SUPPORTED_DOC_TYPES = [
  "w2_2025",
  "1099_int_2025",
  "1099_div_2025",
  "1099_nec_2025",
  "1099_misc_2025",
  "1099_k_2025",
  "1098_2025",
] as const;

// Controlled vocabulary for facts. category groups; key is the specific fact.
export const FACT_CATEGORIES = [
  "income",
  "withholding",
  "deduction",
  "credit",
  "contribution",
  "investment",
  "property",
  "business",
  "identity",
] as const;

// The single tool Claude must call. tool_choice forces it.
export const EXTRACTION_TOOL = {
  name: "record_tax_document",
  description:
    "Record the classification and extracted tax facts for a single document. " +
    "Call this exactly once with your best assessment. Only W-2, 1099-INT, " +
    "1099-DIV, 1099-NEC, 1099-MISC, 1099-K, and 1098 tax year 2025 are deterministically supported. If the " +
    "document is unsupported, ambiguous, low-confidence, or not tax-relevant, " +
    "set doc_type='unknown_tax_document'.",
  input_schema: {
    type: "object",
    properties: {
      is_tax_relevant: {
        type: "boolean",
        description: "True if this document affects a US federal tax return.",
      },
      doc_type: {
        type: "string",
        enum: DOC_TYPES,
        description: "One finite Sunday MVP document class.",
      },
      tax_year: {
        type: ["integer", "null"],
        description: "The tax year this document reports on (e.g. 2024). Null if unknown.",
      },
      issuer: {
        type: ["string", "null"],
        description: "Institution/employer that issued the document (e.g. 'Fidelity', 'ACME LLC').",
      },
      recipient_name: {
        type: ["string", "null"],
        description: "The taxpayer/recipient named on the document, for ownership matching.",
      },
      classification_confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "0.0-1.0 confidence in doc_type and tax_year.",
      },
      facts: {
        type: "array",
        description: "Structured tax facts extracted from the document.",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: FACT_CATEGORIES },
            key: {
              type: "string",
              description:
                "Snake_case fact name. For w2_2025 use employer_name, employer_ein, " +
                "employee_name, tax_year, box_1_wages, box_2_federal_income_tax_withheld, " +
                "box_15_state (two-letter state code, if present), box_16_state_wages " +
                "(if present), box_17_state_income_tax (if present). " +
                "Read employer_ein exactly from the form; omit it when unreadable instead of guessing. For " +
                "1099_int_2025 use payer_name, payer_tin, recipient_name, tax_year, " +
                "box_1_interest_income, box_4_federal_tax_withheld, box_15_state, " +
                "box_16_state_identification_number, box_17_state_tax_withheld, and review " +
                `every simple-form gate field (${WAVE2_DOCUMENT_FORM_SPECS["1099_int_2025"].unsupported.join(", ")}). ` +
                "For every listed monetary box, emit the exact positive amount or an explicit numeric 0 " +
                "when the printed box is blank; omit it only when unreadable so readiness fails closed. " +
                "For 1099_div_2025 use payer_name, payer_tin, " +
                "recipient_name, tax_year, box_1a_total_ordinary_dividends, " +
                "box_1b_qualified_dividends, box_4_federal_tax_withheld, box_14_state, " +
                "box_15_state_identification_number, box_16_state_tax_withheld, and review " +
                `every simple-form gate field (${WAVE2_DOCUMENT_FORM_SPECS["1099_div_2025"].unsupported.join(", ")}). ` +
                "For every listed monetary box, emit the exact positive amount or an explicit numeric 0 " +
                "when the printed box is blank; omit it only when unreadable so readiness fails closed. " +
                "Read payer_tin exactly from the form; " +
                "omit it when unreadable instead of guessing. For 1098_2025 use lender_name, " +
                "lender_tin, borrower_name, tax_year, box_1_mortgage_interest_received, " +
                "box_2_outstanding_mortgage_principal (if present), box_10_property_taxes " +
                "(if present); read lender_tin exactly or omit it. For 1099_nec_2025 use " +
                "payer_name, payer_tin, payer_address, recipient_name, recipient_tin, " +
                "tax_year, box_1_nonemployee_compensation, box_4_federal_tax_withheld " +
                "(if present), box_5_state_tax_withheld (if present). For 1099_misc_2025 use " +
                "payer_name, payer_tin, payer_address, recipient_name, recipient_tin, " +
                "tax_year, box_1_rent (if present), box_2_royalties (if present), " +
                "box_3_other_income (if present), box_4_federal_tax_withheld (if present), " +
                "box_6_medical_payments (if present), box_7_direct_sales (if present), " +
                "box_8_substitute_payments (if present), box_10_gross_proceeds_attorney (if present), " +
                "box_14_excess_golden_parachute (if present), box_15_nonqualified_deferred_comp (if present). " +
                "For 1099_k_2025 use payer_name, payer_tin, payer_address, recipient_name, recipient_tin, " +
                "tax_year, box_1a_gross_amount, box_4_federal_tax_withheld (if present), " +
                "and monthly breakdown boxes box_5a through box_5l (if present).",
            },
            value: {
              description: "The value (number for amounts, string for names/ids).",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "0.0-1.0 confidence in this fact.",
            },
          },
          required: ["category", "key", "value", "confidence"],
        },
      },
      notes: {
        type: ["string", "null"],
        description: "Anything ambiguous, unreadable, or that needs member review.",
      },
    },
    required: [
      "is_tax_relevant",
      "doc_type",
      "tax_year",
      "issuer",
      "recipient_name",
      "classification_confidence",
      "facts",
      "notes",
    ],
  },
} as const;

export const SYSTEM_PROMPT =
  "You are the TaxAhead discovery engine. You classify a single document and extract " +
  "structured US federal tax facts from it for the manual-upload Sunday MVP checkpoint. " +
  "Rules: never invent values you cannot read; if a field is unreadable, omit the fact " +
  "rather than guessing. For a visibly blank monetary box explicitly requested by the tool, " +
  "record numeric zero so blank and unreadable remain distinct. Report low confidence honestly. " +
  "Only these classes are supported: " +
  "w2_2025, 1099_int_2025, 1099_div_2025, 1099_nec_2025, 1099_misc_2025, 1099_k_2025, 1098_2025. " +
  "Unsupported, ambiguous, non-2025, or low-confidence " +
  "documents must be unknown_tax_document. You must call the record_tax_document tool exactly once.";

export type ExtractionResult = {
  is_tax_relevant: boolean;
  doc_type: string;
  tax_year: number | null;
  issuer: string | null;
  recipient_name: string | null;
  classification_confidence: number;
  facts: Array<{ category: string; key: string; value: unknown; confidence: number }>;
  notes: string | null;
};

// Confidence below this routes the document to needs_review instead of classified.
export const REVIEW_THRESHOLD = 0.6;

// The model's schema constrains confidence to 0-1, but that's a hint, not a
// guarantee -- clamp defensively before anything is persisted as a percentage.
export const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export type SundayMvpExtractionState = {
  docType: (typeof DOC_TYPES)[number];
  classification: (typeof DOC_TYPES)[number];
  taxYear: number | null;
  issuer: string | null;
  classificationConfidence: number;
  checkpointStatus: "extracted" | "needs_preparer_review";
  documentStatus: "classified" | "needs_review";
  persistFacts: boolean;
};

const SUNDAY_MVP_SUPPORTED_DOC_TYPE_SET = new Set<string>(SUNDAY_MVP_SUPPORTED_DOC_TYPES);

export function normalizeSundayMvpExtraction(result: ExtractionResult): SundayMvpExtractionState {
  const classificationConfidence = clamp01(result.classification_confidence);
  const isSupportedHighConfidenceTaxDocument =
    result.is_tax_relevant &&
    classificationConfidence >= REVIEW_THRESHOLD &&
    SUNDAY_MVP_SUPPORTED_DOC_TYPE_SET.has(result.doc_type);

  if (!isSupportedHighConfidenceTaxDocument) {
    return {
      docType: UNKNOWN_TAX_DOCUMENT,
      classification: UNKNOWN_TAX_DOCUMENT,
      taxYear: null,
      issuer: null,
      classificationConfidence,
      checkpointStatus: "needs_preparer_review",
      documentStatus: "needs_review",
      persistFacts: false,
    };
  }

  return {
    docType: result.doc_type as (typeof SUNDAY_MVP_SUPPORTED_DOC_TYPES)[number],
    classification: result.doc_type as (typeof SUNDAY_MVP_SUPPORTED_DOC_TYPES)[number],
    taxYear: result.tax_year,
    issuer: result.issuer,
    classificationConfidence,
    checkpointStatus: "extracted",
    documentStatus: "classified",
    persistFacts: true,
  };
}
