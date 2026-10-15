/**
 * Filing Requirement Catalog and readiness contract for the first closed-beta
 * vertical. This is the one product-facing projection over canonical profile,
 * Tax Graph, document, conflict, calculation, and package state.
 *
 * It deliberately does not write state. Callers persist canonical inputs first,
 * evaluate this pure contract, and may then persist the resulting projection.
 */

export const CLOSED_BETA_VERTICAL_V1 = {
  id: "single-w2-ga-2025-v1",
  taxYear: 2025,
  filingStatus: "single",
  residency: "ga_full_year",
  dependentCount: 0,
  deductionChoice: "standard",
  supportedDocumentTypes: ["w2_2025"],
} as const;

export const REQUIREMENT_DISCOVERY_ORDER_V1 = [
  "canonical_state",
  "authorized_sources",
  "processing",
  "additional_connection",
  "specific_document",
  "inference_confirmation",
  "direct_question",
] as const;

export type RequirementDiscoveryStepV1 = (typeof REQUIREMENT_DISCOVERY_ORDER_V1)[number];

export type FilingRequirementCategoryV1 =
  | "scope"
  | "identity"
  | "household"
  | "income"
  | "withholding"
  | "conflicts"
  | "calculation"
  | "package";

export type FilingRequirementResolutionV1 =
  | "profile_confirmation"
  | "canonical_fact"
  | "document_upload"
  | "source_connection"
  | "conflict_resolution"
  | "calculation_run"
  | "package_generation";

export type FilingRequirementStatusV1 =
  "satisfied" | "missing" | "pending" | "conflicting" | "unsupported";

export type FilingReadinessStateV1 = "not_started" | "in_progress" | "ready" | "unsupported";

export type FilingRequirementIdV1 =
  | "scope.tax_year_2025"
  | "scope.single_filer"
  | "scope.ga_full_year"
  | "scope.no_dependents"
  | "scope.standard_deduction"
  | "scope.supported_documents_only"
  | "identity.taxpayer_date_of_birth"
  | "identity.taxpayer_blind_status"
  | "identity.taxpayer_identifier_confirmed"
  | "identity.mailing_address"
  | "household.claimable_as_dependent_status"
  | "income.w2_document"
  | "income.w2_wages"
  | "withholding.w2_federal"
  | "income.w2_ga_wages"
  | "withholding.w2_ga"
  | "conflicts.none_unresolved"
  | "calculation.federal_and_ga_computed"
  | "package.evidence_index_complete";

export type FilingRequirementDefinitionV1 = {
  id: FilingRequirementIdV1;
  category: FilingRequirementCategoryV1;
  label: string;
  why: string;
  hardBlocker: true;
  priority: number;
  resolutionMethods: FilingRequirementResolutionV1[];
  discoveryOrder: RequirementDiscoveryStepV1[];
};

const profileDiscovery: RequirementDiscoveryStepV1[] = [
  "canonical_state",
  "inference_confirmation",
  "direct_question",
];
const documentDiscovery: RequirementDiscoveryStepV1[] = [
  "canonical_state",
  "authorized_sources",
  "processing",
  "additional_connection",
  "specific_document",
  "direct_question",
];

export const FILING_REQUIREMENT_CATALOG_V1: readonly FilingRequirementDefinitionV1[] = [
  {
    id: "scope.tax_year_2025",
    category: "scope",
    label: "Tax year is 2025",
    why: "The first closed-beta rule set is validated only for tax year 2025.",
    hardBlocker: true,
    priority: 1,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "scope.single_filer",
    category: "scope",
    label: "Filing status is Single",
    why: "The first vertical is limited to a single taxpayer.",
    hardBlocker: true,
    priority: 2,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "scope.ga_full_year",
    category: "scope",
    label: "Full-year Georgia residency",
    why: "The validated state calculation covers full-year Georgia residents.",
    hardBlocker: true,
    priority: 3,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "scope.no_dependents",
    category: "scope",
    label: "No dependents",
    why: "Dependent rules are outside the first vertical.",
    hardBlocker: true,
    priority: 4,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "scope.standard_deduction",
    category: "scope",
    label: "Standard deduction selected",
    why: "Itemized deductions are outside the first vertical.",
    hardBlocker: true,
    priority: 5,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "scope.supported_documents_only",
    category: "scope",
    label: "Only supported tax documents are present",
    why: "A return cannot be called ready if an observed document would be silently omitted.",
    hardBlocker: true,
    priority: 6,
    resolutionMethods: ["document_upload", "source_connection"],
    discoveryOrder: documentDiscovery,
  },
  {
    id: "identity.taxpayer_date_of_birth",
    category: "identity",
    label: "Taxpayer date of birth confirmed",
    why: "Age changes federal and Georgia deductions and exclusions.",
    hardBlocker: true,
    priority: 10,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "identity.taxpayer_blind_status",
    category: "identity",
    label: "Blind status confirmed",
    why: "Blind status changes the standard deduction.",
    hardBlocker: true,
    priority: 11,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "identity.taxpayer_identifier_confirmed",
    category: "identity",
    label: "Valid taxpayer identifier confirmed",
    why: "The beta confirms eligibility without collecting identifier digits in the browser.",
    hardBlocker: true,
    priority: 12,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "identity.mailing_address",
    category: "identity",
    label: "Mailing address complete",
    why: "A filing-ready handoff requires a complete taxpayer address.",
    hardBlocker: true,
    priority: 13,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "household.claimable_as_dependent_status",
    category: "household",
    label: "Claimable-as-dependent status confirmed",
    why: "A taxpayer who can be claimed by another person is outside the first vertical.",
    hardBlocker: true,
    priority: 14,
    resolutionMethods: ["profile_confirmation"],
    discoveryOrder: profileDiscovery,
  },
  {
    id: "income.w2_document",
    category: "income",
    label: "2025 Form W-2 present and classified",
    why: "The first vertical requires official wage evidence.",
    hardBlocker: true,
    priority: 20,
    resolutionMethods: ["document_upload", "source_connection"],
    discoveryOrder: documentDiscovery,
  },
  {
    id: "income.w2_wages",
    category: "income",
    label: "W-2 wages have canonical evidence",
    why: "Federal wage income must come from official document evidence.",
    hardBlocker: true,
    priority: 21,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: documentDiscovery,
  },
  {
    id: "withholding.w2_federal",
    category: "withholding",
    label: "Federal withholding has canonical evidence",
    why: "An explicit zero or positive Box 2 value is required; absence cannot be assumed to mean zero.",
    hardBlocker: true,
    priority: 22,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: documentDiscovery,
  },
  {
    id: "income.w2_ga_wages",
    category: "income",
    label: "Georgia W-2 wages have canonical evidence",
    why: "Georgia wage income must be bound to a W-2 whose state code is GA.",
    hardBlocker: true,
    priority: 23,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: documentDiscovery,
  },
  {
    id: "withholding.w2_ga",
    category: "withholding",
    label: "Georgia withholding has canonical evidence",
    why: "An explicit zero or positive Georgia Box 17 value is required.",
    hardBlocker: true,
    priority: 24,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: documentDiscovery,
  },
  {
    id: "conflicts.none_unresolved",
    category: "conflicts",
    label: "No unresolved filing conflicts",
    why: "Conflicting material evidence must be resolved before readiness can be complete.",
    hardBlocker: true,
    priority: 30,
    resolutionMethods: ["conflict_resolution"],
    discoveryOrder: ["canonical_state", "specific_document", "direct_question"],
  },
  {
    id: "calculation.federal_and_ga_computed",
    category: "calculation",
    label: "Federal and Georgia calculations computed",
    why: "Both jurisdictions must produce a fail-closed computed result.",
    hardBlocker: true,
    priority: 40,
    resolutionMethods: ["calculation_run"],
    discoveryOrder: ["canonical_state", "processing"],
  },
  {
    id: "package.evidence_index_complete",
    category: "package",
    label: "Every source document is indexed in the package",
    why: "A professional handoff must not omit evidence the taxpayer supplied.",
    hardBlocker: true,
    priority: 50,
    resolutionMethods: ["package_generation"],
    discoveryOrder: ["canonical_state", "processing"],
  },
] as const;

export type FilingReadinessProfileV1 = {
  taxYear: number | null;
  filingStatus: string | null;
  residency: string | null;
  taxpayerDateOfBirth: string | null;
  taxpayerBlind: boolean | null;
  taxpayerValidSsnConfirmed: boolean | null;
  claimableAsDependent: boolean | null;
  dependentCount: number | null;
  deductionChoice: string | null;
  primaryAddressComplete: boolean;
};

export type FilingReadinessFactV1 = {
  id: string;
  semanticBasis: string;
  evidenceIds: string[];
  documentIds?: string[];
  source: "official_document" | "user_confirmed" | "provider_corroboration";
};

export type FilingReadinessDocumentV1 = {
  id: string;
  docType: string | null;
  status: string;
};

export type FilingReadinessDocumentExpectationV1 = {
  statementId: string;
  statementKind: "no_w2_expected" | "w2_expected_will_provide" | "alternative_evidence_available";
};

export type FilingReadinessInputV1 = {
  filingUnitId: string;
  profile: FilingReadinessProfileV1;
  documents: FilingReadinessDocumentV1[];
  documentExpectation?: FilingReadinessDocumentExpectationV1 | null;
  facts: FilingReadinessFactV1[];
  unresolvedConflictIds: string[];
  calculation: {
    runId: string;
    state: "computed" | "needs_information" | "unsupported";
    reasonCodes: string[];
  } | null;
  evidenceIndex: {
    sourceDocumentIds: string[];
    indexedDocumentIds: string[];
  } | null;
};

export type FilingRequirementEvaluationV1 = FilingRequirementDefinitionV1 & {
  status: FilingRequirementStatusV1;
  reasonCode: string | null;
  evidenceIds: string[];
};

export type FilingReadinessResultV1 = {
  schemaVersion: "taxahead.filing-readiness.v1";
  verticalId: typeof CLOSED_BETA_VERTICAL_V1.id;
  filingUnitId: string;
  state: FilingReadinessStateV1;
  score: number;
  requirements: FilingRequirementEvaluationV1[];
  hardBlockerIds: FilingRequirementIdV1[];
  nextActionIds: FilingRequirementIdV1[];
};

const definition = (id: FilingRequirementIdV1): FilingRequirementDefinitionV1 => {
  const found = FILING_REQUIREMENT_CATALOG_V1.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown_requirement:${id}`);
  return found;
};

function result(
  id: FilingRequirementIdV1,
  status: FilingRequirementStatusV1,
  reasonCode: string | null = null,
  evidenceIds: string[] = [],
): FilingRequirementEvaluationV1 {
  return {
    ...definition(id),
    status,
    reasonCode,
    evidenceIds: [...new Set(evidenceIds)].sort(),
  };
}

function exactScope(
  id: FilingRequirementIdV1,
  value: unknown,
  expected: unknown,
  missingReason: string,
  unsupportedReason: string,
): FilingRequirementEvaluationV1 {
  if (value === null || value === undefined) {
    return result(id, "missing", missingReason);
  }
  return value === expected
    ? result(id, "satisfied")
    : result(id, "unsupported", unsupportedReason);
}

function canonicalFact(
  input: FilingReadinessInputV1,
  id: FilingRequirementIdV1,
  semanticBasis: string,
): FilingRequirementEvaluationV1 {
  const candidates = input.facts.filter((fact) => fact.semanticBasis === semanticBasis);
  const official = candidates.find(
    (fact) => fact.source === "official_document" && fact.evidenceIds.length > 0,
  );
  if (official) return result(id, "satisfied", null, official.evidenceIds);
  if (candidates.some((fact) => fact.evidenceIds.length === 0)) {
    return result(id, "missing", `missing_evidence_lineage:${semanticBasis}`);
  }
  if (candidates.some((fact) => fact.source !== "official_document")) {
    return result(id, "missing", `official_document_required:${semanticBasis}`);
  }
  return result(id, "missing", `missing_material_fact:${semanticBasis}`);
}

export function evaluateFilingReadinessV1(input: FilingReadinessInputV1): FilingReadinessResultV1 {
  const profile = input.profile;
  const supportedDocumentTypes = new Set<string>(CLOSED_BETA_VERTICAL_V1.supportedDocumentTypes);
  const observedUnsupported = input.documents
    .map((document) => document.docType)
    .filter(
      (docType): docType is string => Boolean(docType) && !supportedDocumentTypes.has(docType!),
    );
  const w2Documents = input.documents.filter(
    (document) => document.docType === "w2_2025" && document.status === "classified",
  );
  const documentExpectation = input.documentExpectation ?? null;
  const w2DocumentRequirement =
    w2Documents.length > 0
      ? result(
          "income.w2_document",
          "satisfied",
          null,
          w2Documents.map((document) => document.id),
        )
      : documentExpectation?.statementKind === "no_w2_expected"
        ? result("income.w2_document", "unsupported", "no_w2_expected_outside_vertical", [
            documentExpectation.statementId,
          ])
        : documentExpectation?.statementKind === "w2_expected_will_provide"
          ? result("income.w2_document", "pending", "w2_expected_will_provide", [
              documentExpectation.statementId,
            ])
          : documentExpectation?.statementKind === "alternative_evidence_available"
            ? result("income.w2_document", "pending", "alternative_w2_evidence_requires_review", [
                documentExpectation.statementId,
              ])
            : result("income.w2_document", "missing", "missing_w2_document");

  const requirements: FilingRequirementEvaluationV1[] = [
    exactScope(
      "scope.tax_year_2025",
      profile.taxYear,
      CLOSED_BETA_VERTICAL_V1.taxYear,
      "missing_tax_year",
      "unsupported_tax_year",
    ),
    exactScope(
      "scope.single_filer",
      profile.filingStatus,
      CLOSED_BETA_VERTICAL_V1.filingStatus,
      "missing_filing_status",
      "unsupported_filing_status",
    ),
    exactScope(
      "scope.ga_full_year",
      profile.residency,
      CLOSED_BETA_VERTICAL_V1.residency,
      "missing_residency",
      "unsupported_residency",
    ),
    exactScope(
      "scope.no_dependents",
      profile.dependentCount,
      CLOSED_BETA_VERTICAL_V1.dependentCount,
      "missing_dependent_count",
      "unsupported_dependents",
    ),
    exactScope(
      "scope.standard_deduction",
      profile.deductionChoice,
      CLOSED_BETA_VERTICAL_V1.deductionChoice,
      "missing_deduction_choice",
      "unsupported_deduction_choice",
    ),
    observedUnsupported.length === 0
      ? result("scope.supported_documents_only", "satisfied")
      : result(
          "scope.supported_documents_only",
          "unsupported",
          `unsupported_document_type:${observedUnsupported.sort().join(",")}`,
        ),
    profile.taxpayerDateOfBirth
      ? result("identity.taxpayer_date_of_birth", "satisfied")
      : result("identity.taxpayer_date_of_birth", "missing", "missing_taxpayer_date_of_birth"),
    profile.taxpayerBlind === null || profile.taxpayerBlind === undefined
      ? result("identity.taxpayer_blind_status", "missing", "missing_blind_status")
      : result("identity.taxpayer_blind_status", "satisfied"),
    profile.taxpayerValidSsnConfirmed === true
      ? result("identity.taxpayer_identifier_confirmed", "satisfied")
      : result(
          "identity.taxpayer_identifier_confirmed",
          "missing",
          "taxpayer_identifier_not_confirmed",
        ),
    profile.primaryAddressComplete
      ? result("identity.mailing_address", "satisfied")
      : result("identity.mailing_address", "missing", "missing_mailing_address"),
    profile.claimableAsDependent === null || profile.claimableAsDependent === undefined
      ? result(
          "household.claimable_as_dependent_status",
          "missing",
          "missing_claimable_as_dependent",
        )
      : profile.claimableAsDependent
        ? result(
            "household.claimable_as_dependent_status",
            "unsupported",
            "unsupported_claimable_as_dependent",
          )
        : result("household.claimable_as_dependent_status", "satisfied"),
    w2DocumentRequirement,
    canonicalFact(input, "income.w2_wages", "w2_box_1_wages"),
    canonicalFact(input, "withholding.w2_federal", "w2_box_2_federal_withholding"),
    canonicalFact(input, "income.w2_ga_wages", "w2_box_16_state_wages"),
    canonicalFact(input, "withholding.w2_ga", "w2_box_17_state_withholding"),
    input.unresolvedConflictIds.length === 0
      ? result("conflicts.none_unresolved", "satisfied")
      : result(
          "conflicts.none_unresolved",
          "conflicting",
          "unresolved_material_conflict",
          input.unresolvedConflictIds,
        ),
    input.calculation === null
      ? result("calculation.federal_and_ga_computed", "pending", "calculation_not_run")
      : input.calculation.state === "computed"
        ? result("calculation.federal_and_ga_computed", "satisfied", null, [
            input.calculation.runId,
          ])
        : result(
            "calculation.federal_and_ga_computed",
            input.calculation.state === "unsupported" ? "unsupported" : "missing",
            input.calculation.reasonCodes[0] ?? `calculation_${input.calculation.state}`,
            [input.calculation.runId],
          ),
    input.evidenceIndex === null
      ? result("package.evidence_index_complete", "pending", "package_not_generated")
      : input.evidenceIndex.sourceDocumentIds.length > 0 &&
          input.evidenceIndex.sourceDocumentIds.every((id) =>
            input.evidenceIndex!.indexedDocumentIds.includes(id),
          )
        ? result(
            "package.evidence_index_complete",
            "satisfied",
            null,
            input.evidenceIndex.indexedDocumentIds,
          )
        : result("package.evidence_index_complete", "missing", "package_evidence_index_incomplete"),
  ];

  const hardBlockers = requirements.filter((requirement) => requirement.status !== "satisfied");
  const satisfiedCount = requirements.length - hardBlockers.length;
  const score = Math.round((satisfiedCount / requirements.length) * 100);
  const state: FilingReadinessStateV1 = requirements.some(
    (requirement) => requirement.status === "unsupported",
  )
    ? "unsupported"
    : hardBlockers.length === 0
      ? "ready"
      : satisfiedCount === 0
        ? "not_started"
        : "in_progress";
  const nextActionIds = hardBlockers
    .filter((requirement) =>
      state === "unsupported"
        ? requirement.status === "unsupported"
        : requirement.status !== "unsupported",
    )
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 3)
    .map((requirement) => requirement.id);

  return {
    schemaVersion: "taxahead.filing-readiness.v1",
    verticalId: CLOSED_BETA_VERTICAL_V1.id,
    filingUnitId: input.filingUnitId,
    state,
    score,
    requirements,
    hardBlockerIds: hardBlockers.map((requirement) => requirement.id),
    nextActionIds,
  };
}

/**
 * Wave 2 keeps the proven household/residency scope and extends one complete
 * vertical through simple Forms 1099-INT and 1099-DIV. V1 remains exported so
 * historical receipts and golden tests are still readable.
 */
export const CLOSED_BETA_VERTICAL_V2 = {
  id: "single-w2-investment-ga-2025-v2",
  taxYear: 2025,
  filingStatus: "single",
  residency: "ga_full_year",
  dependentCount: 0,
  deductionChoice: "standard",
  supportedDocumentTypes: ["w2_2025", "1099_int_2025", "1099_div_2025"],
} as const;

export type FilingRequirementIdV2 =
  | FilingRequirementIdV1
  | "documents.all_processing_resolved"
  | "scope.1099_int_supported_fields"
  | "scope.1099_div_supported_fields"
  | "income.1099_int_document"
  | "income.1099_int_completeness"
  | "income.1099_int_interest"
  | "withholding.1099_int_federal"
  | "withholding.1099_int_ga"
  | "income.1099_div_document"
  | "income.1099_div_completeness"
  | "income.1099_div_ordinary"
  | "income.1099_div_qualified"
  | "withholding.1099_div_federal"
  | "withholding.1099_div_ga";

export type FilingRequirementDefinitionV2 = Omit<FilingRequirementDefinitionV1, "id"> & {
  id: FilingRequirementIdV2;
};

const investmentDocumentDiscovery: RequirementDiscoveryStepV1[] = [
  "canonical_state",
  "authorized_sources",
  "processing",
  "additional_connection",
  "specific_document",
  "inference_confirmation",
  "direct_question",
];

export const FILING_REQUIREMENT_CATALOG_V2: readonly FilingRequirementDefinitionV2[] = [
  ...FILING_REQUIREMENT_CATALOG_V1,
  {
    id: "documents.all_processing_resolved",
    category: "scope",
    label: "Every supplied tax document finished processing",
    why: "Pending, failed, or review-required evidence cannot be silently omitted.",
    hardBlocker: true,
    priority: 7,
    resolutionMethods: ["document_upload", "source_connection"],
    discoveryOrder: ["canonical_state", "processing", "specific_document"],
  },
  {
    id: "scope.1099_int_supported_fields",
    category: "scope",
    label: "Every Form 1099-INT fits the simple interest scope",
    why: "All material boxes must be reviewed and unimplemented boxes must be zero.",
    hardBlocker: true,
    priority: 8,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "scope.1099_div_supported_fields",
    category: "scope",
    label: "Every Form 1099-DIV fits the simple dividend scope",
    why: "Capital gains and other unimplemented distributions cannot be silently omitted.",
    hardBlocker: true,
    priority: 9,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_int_document",
    category: "income",
    label: "Interest-income form expectation resolved",
    why: "TaxAhead must know whether all 2025 Forms 1099-INT have been supplied.",
    hardBlocker: true,
    priority: 25,
    resolutionMethods: ["document_upload", "source_connection", "profile_confirmation"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_int_completeness",
    category: "income",
    label: "All expected Forms 1099-INT are accounted for",
    why: "A discovered form does not prove there are no additional interest forms.",
    hardBlocker: true,
    priority: 26,
    resolutionMethods: ["profile_confirmation", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_int_interest",
    category: "income",
    label: "Every Form 1099-INT has official Box 1 evidence",
    why: "Interest income must be complete for every supplied form.",
    hardBlocker: true,
    priority: 27,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "withholding.1099_int_federal",
    category: "withholding",
    label: "Every Form 1099-INT has federal withholding evidence",
    why: "Box 4 must be evidenced as zero or positive for every supplied form.",
    hardBlocker: true,
    priority: 28,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "withholding.1099_int_ga",
    category: "withholding",
    label: "Every Form 1099-INT has Georgia withholding evidence",
    why: "Georgia withholding must be evidenced as zero or positive for every supplied form.",
    hardBlocker: true,
    priority: 29,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_div_document",
    category: "income",
    label: "Dividend-income form expectation resolved",
    why: "TaxAhead must know whether all 2025 Forms 1099-DIV have been supplied.",
    hardBlocker: true,
    priority: 30,
    resolutionMethods: ["document_upload", "source_connection", "profile_confirmation"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_div_completeness",
    category: "income",
    label: "All expected Forms 1099-DIV are accounted for",
    why: "A discovered form does not prove there are no additional dividend forms.",
    hardBlocker: true,
    priority: 31,
    resolutionMethods: ["profile_confirmation", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_div_ordinary",
    category: "income",
    label: "Every Form 1099-DIV has official Box 1a evidence",
    why: "Ordinary dividends must be complete for every supplied form.",
    hardBlocker: true,
    priority: 32,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "income.1099_div_qualified",
    category: "income",
    label: "Every Form 1099-DIV has official Box 1b evidence",
    why: "Qualified dividends must be evidenced as zero or positive and cannot exceed Box 1a.",
    hardBlocker: true,
    priority: 33,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "withholding.1099_div_federal",
    category: "withholding",
    label: "Every Form 1099-DIV has federal withholding evidence",
    why: "Box 4 must be evidenced as zero or positive for every supplied form.",
    hardBlocker: true,
    priority: 34,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
  {
    id: "withholding.1099_div_ga",
    category: "withholding",
    label: "Every Form 1099-DIV has Georgia withholding evidence",
    why: "Georgia withholding must be evidenced as zero or positive for every supplied form.",
    hardBlocker: true,
    priority: 35,
    resolutionMethods: ["canonical_fact", "document_upload", "source_connection"],
    discoveryOrder: investmentDocumentDiscovery,
  },
] as const;

export type FilingReadinessStatementKindV2 =
  | FilingReadinessDocumentExpectationV1["statementKind"]
  | "no_interest_income"
  | "all_1099_int_received"
  | "1099_int_expected_will_provide"
  | "interest_income_without_1099"
  | "no_dividend_income"
  | "all_1099_div_received"
  | "1099_div_expected_will_provide"
  | "dividend_income_without_1099";

export type FilingReadinessDocumentExpectationV2 = {
  statementId: string;
  subjectKind:
    | "employment_w2_expectation"
    | "investment_1099_int_expectation"
    | "investment_1099_div_expectation";
  statementKind: FilingReadinessStatementKindV2;
  documentIds?: string[];
};

export type DocumentCoverageV2 = {
  documentId: string;
  documentType: "w2_2025" | "1099_int_2025" | "1099_div_2025";
  processingState: "complete" | "pending" | "needs_review" | "failed";
  requiredSemanticBases: string[];
  presentSemanticBases: string[];
  reviewedMaterialFields: string[];
  unsupportedMaterialFields: string[];
  evidenceIds: string[];
  state: "complete" | "needs_information" | "conflicting" | "unsupported";
  reasonCodes: string[];
};

export type FilingReadinessInputV2 = Omit<FilingReadinessInputV1, "documentExpectation"> & {
  documentExpectations: FilingReadinessDocumentExpectationV2[];
  documentCoverage: DocumentCoverageV2[];
};

export type FilingRequirementEvaluationV2 = FilingRequirementDefinitionV2 & {
  status: FilingRequirementStatusV1;
  reasonCode: string | null;
  evidenceIds: string[];
};

export type FilingReadinessResultV2 = {
  schemaVersion: "taxahead.filing-readiness.v2";
  verticalId: typeof CLOSED_BETA_VERTICAL_V2.id;
  filingUnitId: string;
  state: FilingReadinessStateV1;
  score: number;
  requirements: FilingRequirementEvaluationV2[];
  hardBlockerIds: FilingRequirementIdV2[];
  nextActionIds: FilingRequirementIdV2[];
  documentCoverage: DocumentCoverageV2[];
};

const definitionV2 = (id: FilingRequirementIdV2): FilingRequirementDefinitionV2 => {
  const found = FILING_REQUIREMENT_CATALOG_V2.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown_requirement:${id}`);
  return found;
};

function resultV2(
  id: FilingRequirementIdV2,
  status: FilingRequirementStatusV1,
  reasonCode: string | null = null,
  evidenceIds: string[] = [],
): FilingRequirementEvaluationV2 {
  return {
    ...definitionV2(id),
    status,
    reasonCode,
    evidenceIds: [...new Set(evidenceIds)].sort(),
  };
}

function exactScopeV2(
  id: FilingRequirementIdV2,
  value: unknown,
  expected: unknown,
  missingReason: string,
  unsupportedReason: string,
): FilingRequirementEvaluationV2 {
  if (value === null || value === undefined) {
    return resultV2(id, "missing", missingReason);
  }
  return value === expected
    ? resultV2(id, "satisfied")
    : resultV2(id, "unsupported", unsupportedReason);
}

function matchingStatement(
  input: FilingReadinessInputV2,
  subjectKind: FilingReadinessDocumentExpectationV2["subjectKind"],
): FilingReadinessDocumentExpectationV2 | null {
  return (
    input.documentExpectations.find((statement) => statement.subjectKind === subjectKind) ?? null
  );
}

function perDocumentOfficialFact(
  input: FilingReadinessInputV2,
  id: FilingRequirementIdV2,
  docType: string,
  semanticBasis: string,
  notApplicableStatementKind?: FilingReadinessStatementKindV2,
): FilingRequirementEvaluationV2 {
  const documents = input.documents.filter(
    (document) => document.docType === docType && document.status === "classified",
  );
  const candidates = input.facts.filter((fact) => fact.semanticBasis === semanticBasis);
  if (documents.length === 0 && notApplicableStatementKind) {
    const statement = input.documentExpectations.find(
      (candidate) => candidate.statementKind === notApplicableStatementKind,
    );
    if (statement) {
      return resultV2(id, "satisfied", `not_applicable_confirmed:${docType}`, [
        statement.statementId,
      ]);
    }
  }
  if (documents.length === 0) {
    return resultV2(id, "missing", `missing_document:${docType}`);
  }

  const missingDocumentIds: string[] = [];
  const nonOfficialDocumentIds: string[] = [];
  const evidenceIds: string[] = [];
  for (const document of documents) {
    const documentFacts = candidates.filter((fact) => fact.documentIds?.includes(document.id));
    const official = documentFacts.find(
      (fact) => fact.source === "official_document" && fact.evidenceIds.length > 0,
    );
    if (official) {
      evidenceIds.push(...official.evidenceIds);
      continue;
    }
    if (documentFacts.some((fact) => fact.source !== "official_document")) {
      nonOfficialDocumentIds.push(document.id);
    } else {
      missingDocumentIds.push(document.id);
    }
  }
  if (nonOfficialDocumentIds.length > 0) {
    return resultV2(
      id,
      "missing",
      `official_document_required:${semanticBasis}:${nonOfficialDocumentIds.sort().join(",")}`,
    );
  }
  if (missingDocumentIds.length > 0) {
    return resultV2(
      id,
      "missing",
      `missing_document_fact:${semanticBasis}:${missingDocumentIds.sort().join(",")}`,
    );
  }
  return resultV2(id, "satisfied", null, evidenceIds);
}

type InvestmentFamilyEvaluation = {
  document: FilingRequirementEvaluationV2;
  completeness: FilingRequirementEvaluationV2;
};

function evaluateInvestmentFamily(
  input: FilingReadinessInputV2,
  config: {
    docType: "1099_int_2025" | "1099_div_2025";
    subjectKind: "investment_1099_int_expectation" | "investment_1099_div_expectation";
    documentRequirementId: "income.1099_int_document" | "income.1099_div_document";
    completenessRequirementId: "income.1099_int_completeness" | "income.1099_div_completeness";
    noIncomeKind: "no_interest_income" | "no_dividend_income";
    allReceivedKind: "all_1099_int_received" | "all_1099_div_received";
    willProvideKind: "1099_int_expected_will_provide" | "1099_div_expected_will_provide";
    withoutFormKind: "interest_income_without_1099" | "dividend_income_without_1099";
  },
): InvestmentFamilyEvaluation {
  const documents = input.documents.filter(
    (document) => document.docType === config.docType && document.status === "classified",
  );
  const documentIds = documents.map((document) => document.id).sort();
  const statement = matchingStatement(input, config.subjectKind);
  if (documents.length === 0) {
    if (statement?.statementKind === config.noIncomeKind) {
      const evidence = [statement.statementId];
      return {
        document: resultV2(
          config.documentRequirementId,
          "satisfied",
          `not_applicable_confirmed:${config.docType}`,
          evidence,
        ),
        completeness: resultV2(
          config.completenessRequirementId,
          "satisfied",
          `not_applicable_confirmed:${config.docType}`,
          evidence,
        ),
      };
    }
    if (statement?.statementKind === config.willProvideKind) {
      const evidence = [statement.statementId];
      return {
        document: resultV2(
          config.documentRequirementId,
          "pending",
          config.willProvideKind,
          evidence,
        ),
        completeness: resultV2(
          config.completenessRequirementId,
          "pending",
          config.willProvideKind,
          evidence,
        ),
      };
    }
    if (statement?.statementKind === config.withoutFormKind) {
      const evidence = [statement.statementId];
      return {
        document: resultV2(
          config.documentRequirementId,
          "unsupported",
          config.withoutFormKind,
          evidence,
        ),
        completeness: resultV2(
          config.completenessRequirementId,
          "unsupported",
          config.withoutFormKind,
          evidence,
        ),
      };
    }
    return {
      document: resultV2(
        config.documentRequirementId,
        "missing",
        `unresolved_document_expectation:${config.docType}`,
      ),
      completeness: resultV2(
        config.completenessRequirementId,
        "missing",
        `unresolved_document_expectation:${config.docType}`,
      ),
    };
  }

  const documentResult = resultV2(config.documentRequirementId, "satisfied", null, documentIds);
  if (statement?.statementKind !== config.allReceivedKind) {
    return {
      document: documentResult,
      completeness: resultV2(
        config.completenessRequirementId,
        "missing",
        `document_set_confirmation_required:${config.docType}`,
        documentIds,
      ),
    };
  }
  const confirmedIds = [...new Set(statement.documentIds ?? [])].sort();
  const matches =
    confirmedIds.length === documentIds.length &&
    confirmedIds.every((documentId, index) => documentId === documentIds[index]);
  return {
    document: documentResult,
    completeness: matches
      ? resultV2(config.completenessRequirementId, "satisfied", null, [
          statement.statementId,
          ...documentIds,
        ])
      : resultV2(
          config.completenessRequirementId,
          "missing",
          `stale_document_set_confirmation:${config.docType}`,
          [statement.statementId, ...documentIds],
        ),
  };
}

function coverageRequirement(
  input: FilingReadinessInputV2,
  docType: "1099_int_2025" | "1099_div_2025",
  id: "scope.1099_int_supported_fields" | "scope.1099_div_supported_fields",
): FilingRequirementEvaluationV2 {
  const documents = input.documents.filter(
    (document) => document.docType === docType && document.status === "classified",
  );
  if (documents.length === 0) {
    return resultV2(id, "satisfied", `not_applicable:${docType}`);
  }
  const byDocumentId = new Map(
    input.documentCoverage.map((coverage) => [coverage.documentId, coverage]),
  );
  const coverages = documents.map((document) => byDocumentId.get(document.id));
  if (coverages.some((coverage) => !coverage)) {
    return resultV2(id, "missing", `missing_document_coverage:${docType}`);
  }
  const typedCoverages = coverages.filter((coverage): coverage is DocumentCoverageV2 =>
    Boolean(coverage),
  );
  const unsupported = typedCoverages.filter((coverage) => coverage.state === "unsupported");
  if (unsupported.length > 0) {
    return resultV2(
      id,
      "unsupported",
      unsupported.flatMap((coverage) => coverage.reasonCodes)[0] ??
        `unsupported_material_fields:${docType}`,
      unsupported.flatMap((coverage) => coverage.evidenceIds),
    );
  }
  const conflicting = typedCoverages.filter((coverage) => coverage.state === "conflicting");
  if (conflicting.length > 0) {
    return resultV2(
      id,
      "conflicting",
      conflicting.flatMap((coverage) => coverage.reasonCodes)[0] ??
        `conflicting_document_coverage:${docType}`,
      conflicting.flatMap((coverage) => coverage.evidenceIds),
    );
  }
  const incomplete = typedCoverages.filter((coverage) => coverage.state !== "complete");
  if (incomplete.length > 0) {
    return resultV2(
      id,
      "missing",
      incomplete.flatMap((coverage) => coverage.reasonCodes)[0] ??
        `incomplete_document_coverage:${docType}`,
      incomplete.flatMap((coverage) => coverage.evidenceIds),
    );
  }
  return resultV2(
    id,
    "satisfied",
    null,
    typedCoverages.flatMap((coverage) => coverage.evidenceIds),
  );
}

export function evaluateFilingReadinessV2(input: FilingReadinessInputV2): FilingReadinessResultV2 {
  const profile = input.profile;
  const supportedDocumentTypes = new Set<string>(CLOSED_BETA_VERTICAL_V2.supportedDocumentTypes);
  const observedUnsupported = input.documents.flatMap((document) => {
    if (document.status === "classified" && !document.docType) return ["unclassified"];
    return document.docType && !supportedDocumentTypes.has(document.docType)
      ? [document.docType]
      : [];
  });
  const processingBlockers = input.documents.filter(
    (document) => document.status !== "classified" || !document.docType,
  );
  const w2Documents = input.documents.filter(
    (document) => document.docType === "w2_2025" && document.status === "classified",
  );
  const w2Statement = matchingStatement(input, "employment_w2_expectation");
  const w2DocumentRequirement =
    w2Documents.length > 0
      ? resultV2(
          "income.w2_document",
          "satisfied",
          null,
          w2Documents.map((document) => document.id),
        )
      : w2Statement?.statementKind === "no_w2_expected"
        ? resultV2("income.w2_document", "unsupported", "no_w2_expected_outside_vertical", [
            w2Statement.statementId,
          ])
        : w2Statement?.statementKind === "w2_expected_will_provide"
          ? resultV2("income.w2_document", "pending", "w2_expected_will_provide", [
              w2Statement.statementId,
            ])
          : w2Statement?.statementKind === "alternative_evidence_available"
            ? resultV2("income.w2_document", "pending", "alternative_w2_evidence_requires_review", [
                w2Statement.statementId,
              ])
            : resultV2("income.w2_document", "missing", "missing_w2_document");

  const intFamily = evaluateInvestmentFamily(input, {
    docType: "1099_int_2025",
    subjectKind: "investment_1099_int_expectation",
    documentRequirementId: "income.1099_int_document",
    completenessRequirementId: "income.1099_int_completeness",
    noIncomeKind: "no_interest_income",
    allReceivedKind: "all_1099_int_received",
    willProvideKind: "1099_int_expected_will_provide",
    withoutFormKind: "interest_income_without_1099",
  });
  const divFamily = evaluateInvestmentFamily(input, {
    docType: "1099_div_2025",
    subjectKind: "investment_1099_div_expectation",
    documentRequirementId: "income.1099_div_document",
    completenessRequirementId: "income.1099_div_completeness",
    noIncomeKind: "no_dividend_income",
    allReceivedKind: "all_1099_div_received",
    willProvideKind: "1099_div_expected_will_provide",
    withoutFormKind: "dividend_income_without_1099",
  });

  const requirements: FilingRequirementEvaluationV2[] = [
    exactScopeV2(
      "scope.tax_year_2025",
      profile.taxYear,
      CLOSED_BETA_VERTICAL_V2.taxYear,
      "missing_tax_year",
      "unsupported_tax_year",
    ),
    exactScopeV2(
      "scope.single_filer",
      profile.filingStatus,
      CLOSED_BETA_VERTICAL_V2.filingStatus,
      "missing_filing_status",
      "unsupported_filing_status",
    ),
    exactScopeV2(
      "scope.ga_full_year",
      profile.residency,
      CLOSED_BETA_VERTICAL_V2.residency,
      "missing_residency",
      "unsupported_residency",
    ),
    exactScopeV2(
      "scope.no_dependents",
      profile.dependentCount,
      CLOSED_BETA_VERTICAL_V2.dependentCount,
      "missing_dependent_count",
      "unsupported_dependents",
    ),
    exactScopeV2(
      "scope.standard_deduction",
      profile.deductionChoice,
      CLOSED_BETA_VERTICAL_V2.deductionChoice,
      "missing_deduction_choice",
      "unsupported_deduction_choice",
    ),
    observedUnsupported.length === 0
      ? resultV2("scope.supported_documents_only", "satisfied")
      : resultV2(
          "scope.supported_documents_only",
          "unsupported",
          `unsupported_document_type:${observedUnsupported.sort().join(",")}`,
        ),
    processingBlockers.length === 0
      ? resultV2("documents.all_processing_resolved", "satisfied")
      : resultV2(
          "documents.all_processing_resolved",
          "missing",
          "document_processing_incomplete",
          processingBlockers.map((document) => document.id),
        ),
    coverageRequirement(input, "1099_int_2025", "scope.1099_int_supported_fields"),
    coverageRequirement(input, "1099_div_2025", "scope.1099_div_supported_fields"),
    profile.taxpayerDateOfBirth
      ? resultV2("identity.taxpayer_date_of_birth", "satisfied")
      : resultV2("identity.taxpayer_date_of_birth", "missing", "missing_taxpayer_date_of_birth"),
    profile.taxpayerBlind === null || profile.taxpayerBlind === undefined
      ? resultV2("identity.taxpayer_blind_status", "missing", "missing_blind_status")
      : resultV2("identity.taxpayer_blind_status", "satisfied"),
    profile.taxpayerValidSsnConfirmed === true
      ? resultV2("identity.taxpayer_identifier_confirmed", "satisfied")
      : resultV2(
          "identity.taxpayer_identifier_confirmed",
          "missing",
          "taxpayer_identifier_not_confirmed",
        ),
    profile.primaryAddressComplete
      ? resultV2("identity.mailing_address", "satisfied")
      : resultV2("identity.mailing_address", "missing", "missing_mailing_address"),
    profile.claimableAsDependent === null || profile.claimableAsDependent === undefined
      ? resultV2(
          "household.claimable_as_dependent_status",
          "missing",
          "missing_claimable_as_dependent",
        )
      : profile.claimableAsDependent
        ? resultV2(
            "household.claimable_as_dependent_status",
            "unsupported",
            "unsupported_claimable_as_dependent",
          )
        : resultV2("household.claimable_as_dependent_status", "satisfied"),
    w2DocumentRequirement,
    perDocumentOfficialFact(input, "income.w2_wages", "w2_2025", "w2_box_1_wages"),
    perDocumentOfficialFact(
      input,
      "withholding.w2_federal",
      "w2_2025",
      "w2_box_2_federal_withholding",
    ),
    perDocumentOfficialFact(input, "income.w2_ga_wages", "w2_2025", "w2_box_16_state_wages"),
    perDocumentOfficialFact(input, "withholding.w2_ga", "w2_2025", "w2_box_17_state_withholding"),
    intFamily.document,
    intFamily.completeness,
    perDocumentOfficialFact(
      input,
      "income.1099_int_interest",
      "1099_int_2025",
      "interest_income_1099int_box1",
      "no_interest_income",
    ),
    perDocumentOfficialFact(
      input,
      "withholding.1099_int_federal",
      "1099_int_2025",
      "federal_withholding_1099int_box4",
      "no_interest_income",
    ),
    perDocumentOfficialFact(
      input,
      "withholding.1099_int_ga",
      "1099_int_2025",
      "state_withholding_1099int_box17",
      "no_interest_income",
    ),
    divFamily.document,
    divFamily.completeness,
    perDocumentOfficialFact(
      input,
      "income.1099_div_ordinary",
      "1099_div_2025",
      "ordinary_dividends_1099div_box1a",
      "no_dividend_income",
    ),
    perDocumentOfficialFact(
      input,
      "income.1099_div_qualified",
      "1099_div_2025",
      "qualified_dividends_1099div_box1b",
      "no_dividend_income",
    ),
    perDocumentOfficialFact(
      input,
      "withholding.1099_div_federal",
      "1099_div_2025",
      "federal_withholding_1099div_box4",
      "no_dividend_income",
    ),
    perDocumentOfficialFact(
      input,
      "withholding.1099_div_ga",
      "1099_div_2025",
      "state_withholding_1099div_box16",
      "no_dividend_income",
    ),
    input.unresolvedConflictIds.length === 0
      ? resultV2("conflicts.none_unresolved", "satisfied")
      : resultV2(
          "conflicts.none_unresolved",
          "conflicting",
          "unresolved_material_conflict",
          input.unresolvedConflictIds,
        ),
    input.calculation === null
      ? resultV2("calculation.federal_and_ga_computed", "pending", "calculation_not_run")
      : input.calculation.state === "computed"
        ? resultV2("calculation.federal_and_ga_computed", "satisfied", null, [
            input.calculation.runId,
          ])
        : resultV2(
            "calculation.federal_and_ga_computed",
            input.calculation.state === "unsupported" ? "unsupported" : "missing",
            input.calculation.reasonCodes[0] ?? `calculation_${input.calculation.state}`,
            [input.calculation.runId],
          ),
    input.evidenceIndex === null
      ? resultV2("package.evidence_index_complete", "pending", "package_not_generated")
      : input.evidenceIndex.sourceDocumentIds.length > 0 &&
          input.evidenceIndex.sourceDocumentIds.every((id) =>
            input.evidenceIndex!.indexedDocumentIds.includes(id),
          )
        ? resultV2(
            "package.evidence_index_complete",
            "satisfied",
            null,
            input.evidenceIndex.indexedDocumentIds,
          )
        : resultV2(
            "package.evidence_index_complete",
            "missing",
            "package_evidence_index_incomplete",
          ),
  ];

  const hardBlockers = requirements.filter((requirement) => requirement.status !== "satisfied");
  const satisfiedCount = requirements.length - hardBlockers.length;
  const score = Math.round((satisfiedCount / requirements.length) * 100);
  const state: FilingReadinessStateV1 = requirements.some(
    (requirement) => requirement.status === "unsupported",
  )
    ? "unsupported"
    : hardBlockers.length === 0
      ? "ready"
      : satisfiedCount === 0
        ? "not_started"
        : "in_progress";
  const nextActionIds = hardBlockers
    .filter((requirement) =>
      state === "unsupported"
        ? requirement.status === "unsupported"
        : requirement.status !== "unsupported",
    )
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 3)
    .map((requirement) => requirement.id);

  return {
    schemaVersion: "taxahead.filing-readiness.v2",
    verticalId: CLOSED_BETA_VERTICAL_V2.id,
    filingUnitId: input.filingUnitId,
    state,
    score,
    requirements,
    hardBlockerIds: hardBlockers.map((requirement) => requirement.id),
    nextActionIds,
    documentCoverage: input.documentCoverage,
  };
}

export type FilingAnswerTargetV1 =
  "profile_confirmation" | "document_expectation" | "requirement_resolution";

export type FilingAnswerCommandV1 = {
  schemaVersion: "taxahead.filing-answer.v1";
  idempotencyKey: string;
  requirementId: FilingRequirementIdV2;
  informationRequestId: string | null;
  target: FilingAnswerTargetV1;
  value: unknown;
  confirmed: true;
};

export type FilingReadyPackageV1 = {
  schemaVersion: "taxahead.filing-ready-package.v1";
  verticalId: typeof CLOSED_BETA_VERTICAL_V1.id;
  generatedAt: string;
  status: "not_ready" | "ready_for_professional_review";
  notFiled: true;
  readiness: Pick<FilingReadinessResultV1, "state" | "score" | "hardBlockerIds" | "nextActionIds">;
  calculationRunId: string | null;
  taxpayerSummary: Record<string, unknown>;
  calculationSummary: Record<string, unknown> | null;
  evidenceIndex: Array<{
    documentId: string;
    filename: string;
    documentType: string;
    sourceType: string | null;
  }>;
  disclosures: string[];
};

export type FilingReadyPackageV2 = {
  schemaVersion: "taxahead.filing-ready-package.v2";
  verticalId: typeof CLOSED_BETA_VERTICAL_V2.id;
  generatedAt: string;
  status: "not_ready" | "ready_for_professional_review";
  notFiled: true;
  readiness: Pick<FilingReadinessResultV2, "state" | "score" | "hardBlockerIds" | "nextActionIds">;
  calculationRunId: string | null;
  calculationInputSnapshotHash: string | null;
  taxpayerSummary: Record<string, unknown>;
  calculationSummary: Record<string, unknown> | null;
  documentCoverage: DocumentCoverageV2[];
  evidenceIndex: Array<{
    documentId: string;
    filename: string;
    documentType: string;
    sourceType: string | null;
    factIds: string[];
    evidenceIds: string[];
  }>;
  disclosures: string[];
};
