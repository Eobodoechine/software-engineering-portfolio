// supabase/functions/ask-taxahead/index.ts
// Minimal version of the "Chat" surface shown in the live frontend (WORKSPACE
// nav: Chat / Dashboard / Tax Package / Connections). Deliberately scoped down:
// stateless, single-turn, grounded ONLY in this filing unit's current facts and
// scores -- no persistent conversation memory (that's the real AI Memory
// Service, correctly out of scope for the pilot; see AI Intelligence Architecture
// doc). Every answer is logged to feed_messages so there's at least a visible
// history, even without true multi-turn continuity.
//
// Hard rule enforced in the system prompt: never compute or state a dollar
// figure that isn't already a discovered fact. Refund/liability estimation is
// the Tax Compliance Engine's job (P2, external), not this endpoint's -- same
// boundary already applied in get-tax-package's potential_deductions_total.
//
// Diagnostics (spec.md AC-3 item 6; four-way reconciliation Files 7 & 8): this
// is connector-platform's grounded-citation base with main's startRun/fail/
// succeed tracing wrapper threaded through it -- every early return finishes the
// run 'failed' (closing the audit's "ask/chat do not persist failure events"
// finding), the success path finishes 'succeeded'. The pre-existing best-effort
// feed_messages swallow is preserved exactly (a secondary feed write failing
// must never flip the outcome to failed). `deps` is the union of CP's `fetch`
// and main's `startRun` injection points so neither lineage's tests break.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clamp01 } from "../_shared/extraction.ts";
import { startRun as realStartRun, type StartRunFn } from "../_shared/tracing.ts";
import { logger } from "../_shared/logger.ts";
import { embedQuery } from "../_shared/kb-embeddings.ts";
import { rerankResults, type RerankInput } from "../_shared/kb-reranker.ts";
import {
  authorizePaidFeature,
  paidEntitlementErrorBody,
  type PaidEntitlementAuthorizer,
} from "../_shared/paid-entitlements.ts";

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

// Provider-agnostic model routing via OpenRouter. Override CHAT_MODEL to switch
// the underlying model/provider (e.g. "openai/gpt-4o") without code changes.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CHAT_MODEL = env("CHAT_MODEL") ?? "anthropic/claude-sonnet-5";
const MODEL_PROVIDER = CHAT_MODEL.includes("/") ? CHAT_MODEL.split("/")[0] : CHAT_MODEL;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const MAX_QUESTION_LEN = 2000;
const ANSWER_TOOL = {
  name: "answer_from_evidence",
  description:
    "Return a grounded answer status, answer text, and citation IDs using only supplied evidence. " +
    "Use citation_ids for user fact citations [C*] and knowledge_citation_ids for knowledge base citations [K*].",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "answer", "citation_ids"],
    properties: {
      status: {
        type: "string",
        enum: ["answerable", "insufficient_context", "out_of_scope"],
      },
      answer: { type: "string" },
      citation_ids: {
        type: "array",
        items: { type: "string" },
      },
      knowledge_citation_ids: {
        type: "array",
        items: { type: "string" },
      },
      estimate_citation_ids: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
} as const;

type SupabaseLike = import("../_shared/supabase-client-types.ts").SupabaseLike;
type FactRow = {
  id: string;
  filing_unit_id: string;
  category: string;
  key: string;
  value: unknown;
  confidence: number | null;
  state: string;
  fact_evidence?: Array<{
    evidence: {
      id: string;
      filing_unit_id: string;
      document?: {
        id: string;
        filing_unit_id: string;
        filename: string;
        doc_type: string | null;
        issuer: string | null;
        source?: { id: string; filing_unit_id: string; label: string; type: string };
      };
    };
  }>;
};
type AnswerStatus = "answerable" | "insufficient_context" | "out_of_scope";
type ToolInput = {
  status: AnswerStatus;
  answer: string;
  citation_ids: string[];
  knowledge_citation_ids?: string[];
  estimate_citation_ids?: string[];
};
type KBSearchResult = RerankInput & {
  source_file: string;
  layer: string;
  chunk_index: number;
  metadata: unknown;
  combined_score: number;
  vector_score: number;
  text_score: number;
  jurisdiction: string;
  jurisdiction_type: string;
  tax_year: number | null;
  effective_start: string | null;
  effective_end: string | null;
  source_url: string | null;
  source_version: string | null;
  authority_type: string;
  confidence: number;
  rerank_score: number;
};
type GroundingCitation = {
  id: string;
  fact_id: string;
  evidence_id: string;
  document_id: string;
  filename: string;
  doc_type: string | null;
  issuer: string | null;
  source_id: string;
  source_label: string;
  source_type: string;
};
type InvokeFunction = (
  name: string,
  options: { body: Record<string, unknown>; headers: Record<string, string> },
) => Promise<{ data: unknown; error: unknown }>;

type EstimateCitation = {
  id: string;
  value_label: string;
  computed_value: number;
  source_type: "kb_document" | "discovered_fact" | "irs_bracket_table";
  source_ref: string;
  rule_summary: string;
};

type EstimateSummary = {
  estimated_tax: number | null;
  taxable_income: number | null;
  effective_rate: number | null;
  estimated_tax_after_credits: number | null;
};

type ProofMetadata = {
  run_id: string;
  grounding_status: AnswerStatus;
  retrieval_count: number;
  citation_count: number;
  kb_retrieval_count: number;
  kb_citation_count: number;
  estimate_retrieval_count: number;
  estimate_citation_count: number;
  validated: boolean;
  model_provider: string;
  context_hash: string;
};

const STATE_AND_DC_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

function validStoredJurisdiction(value: unknown): value is string {
  if (value === "US-FED") return true;
  return (
    typeof value === "string" &&
    /^US-[A-Z]{2}$/.test(value) &&
    STATE_AND_DC_CODES.has(value.slice(3))
  );
}

function validStoredTaxYear(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 1900 &&
    value <= 2100
  );
}

const SYSTEM_PROMPT =
  "You are TaxAhead's assistant. You answer questions about the member's tax " +
  "profile using ONLY the CONTEXT block provided below -- never invent facts, " +
  "amounts, or documents that aren't in it. The CONTEXT may include two sections: " +
  "'Discovered facts' (the member's own tax records, cited as [C1], [C2], etc.) " +
  "and 'Tax knowledge' (general tax law reference material, cited as [K1], [K2], etc.), " +
  "and optionally 'Tax estimate' (computed figures from the estimate engine, cited as [E*], [E*], etc.). " +
  "You must never compute a dollar figure yourself — only reference figures that " +
  "appear in the CONTEXT block. The [E*] estimate context block contains computed " +
  "figures from TaxAhead's estimate engine. You MAY reference these figures in your " +
  "answer, citing them as [E*], [E*], etc. " +
  "Treat [E*] citations the same as [C*] citations: every factual sentence referencing " +
  "an estimate figure must include the corresponding [E*] marker. If neither section contains " +
  "enough information to answer, say so plainly and suggest what would help (e.g. " +
  "connecting a source or uploading a document). Be concise, warm, and professional -- " +
  "like an organized advisor, not a chatbot. Never claim the member is 'done' or " +
  "'guaranteed' anything; readiness reflects currently available information only. " +
  "If the member states a dollar amount themselves (e.g. 'my refund should be about " +
  "$5,000, right?'), do not confirm, validate, or repeat it as accurate -- only " +
  "reference figures that appear in the CONTEXT block, and clarify that any other " +
  "amount can't be verified from currently discovered information. Use the " +
  "answer_from_evidence tool. Set status to insufficient_context when neither the tax " +
  "records nor the knowledge base contain enough evidence to answer, or out_of_scope " +
  "when the question is not about tax at all. For answerable responses, every factual " +
  "sentence must contain one or more exact bracket markers: [C1] for user facts, [K1] " +
  "for knowledge base passages, [E*] for estimate values. Return user fact citations in citation_ids and knowledge " +
  "citations in knowledge_citation_ids. Every returned ID must appear as a bracket marker " +
  "in the answer, and every answer marker must be returned in the appropriate list. " +
  "Never create a citation ID that isn't in the CONTEXT. When answering from the knowledge " +
  "base, note that this is general tax information, not personalized tax advice. " +
  "Return knowledge_citation_ids as an empty array if no knowledge passages were used. " +
  "CRITICAL — Circular 230 compliance: Any interpretive claim, recommendation, or " +
  "guidance about what the member should do (e.g., 'you should file', 'consider deducting', " +
  "'you may be eligible') MUST be supported by at least one [K*] knowledge base citation. " +
  "Never make a tax recommendation without a knowledge base citation. Factual reporting " +
  "of the member's own records (with [C*] citations) does not require [K*] citations.";

// Circular 230 compliance disclaimer — appended to any response that includes
// knowledge base (tax law) information. Per IRS OPR Alert 2026-19, AI-generated
// tax guidance must clearly state that it is not personalized tax advice.
const CIRCULAR_230_DISCLAIMER =
  "This is general tax information, not tax advice. Consult a tax professional " +
  "for advice specific to your situation.";

// Patterns that indicate an interpretive claim or recommendation.
// These require at least one [K*] knowledge citation to be compliant.
const INTERPRETIVE_PATTERNS = [
  /\byou should\b/i,
  /\byou may (?:want to|be (?:eligible|able|qualified))\b/i,
  /\bconsider\b/i,
  /\brecommend(?:ed|ation)?\b/i,
  /\bwe (?:suggest|advise|recommend)\b/i,
  /\byou (?:could|might|can) (?:deduct|claim|file|qualify)\b/i,
  /\bit (?:would|may|could) be (?:beneficial|advantageous|wise)\b/i,
  /\byou (?:are|may be) (?:eligible|entitled|qualified)\b/i,
];

/**
 * Check if an answer contains interpretive claims that lack [K*] citations.
 * Returns an array of warning messages for any un-cited recommendations.
 */
export function detectUncitedRecommendations(answer: string): string[] {
  const sentences = answer.split(/[.!?]+/).filter((s) => s.trim());
  const warnings: string[] = [];

  for (const sentence of sentences) {
    const isInterpretive = INTERPRETIVE_PATTERNS.some((p) => p.test(sentence));
    if (!isInterpretive) continue;

    const hasKCitation = /\[K[1-9]\d*\]/.test(sentence);
    if (!hasKCitation) {
      warnings.push(
        `Interpretive claim without [K*] citation: "${sentence.trim().slice(0, 100)}..."`,
      );
    }
  }

  return warnings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Keep the user-visible failure machine-readable and safe for CI diagnostics.
// Provider bodies can contain request context, so they must never be passed
// through from this public edge function.
function classifyChatProviderStatus(status: number): string {
  if (status === 400) return "provider_rejected_request";
  if (status === 401 || status === 403) return "provider_auth_rejected";
  if (status === 404) return "provider_model_not_found";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500 && status < 600) return "provider_unavailable";
  return "provider_http_error";
}

function parseToolInput(input: unknown): ToolInput | null {
  if (!isRecord(input)) return null;
  // Anthropic still receives an `additionalProperties: false` schema. Project
  // only its declared answer fields here rather than rejecting a response that
  // carries provider metadata alongside them. Nothing outside this allowlist
  // can reach the answer, citations, proof, or persistence paths below.
  const { answer, citation_ids } = input;
  const knowledge_citation_ids = input.knowledge_citation_ids as unknown;
  const estimate_citation_ids = input.estimate_citation_ids as unknown;
  if (typeof answer !== "string") return null;
  if (!Array.isArray(citation_ids) || citation_ids.some((id) => typeof id !== "string"))
    return null;
  // knowledge_citation_ids is optional; if present, must be string[]
  let kbCitationIds: string[] | undefined;
  if (knowledge_citation_ids !== undefined) {
    if (
      !Array.isArray(knowledge_citation_ids) ||
      knowledge_citation_ids.some((id) => typeof id !== "string")
    )
      return null;
    kbCitationIds = knowledge_citation_ids;
  }
  // estimate_citation_ids is optional; if present, must be string[]
  let estCitationIds: string[] | undefined;
  if (estimate_citation_ids !== undefined) {
    if (
      !Array.isArray(estimate_citation_ids) ||
      estimate_citation_ids.some((id) => typeof id !== "string")
    )
      return null;
    estCitationIds = estimate_citation_ids;
  }
  // Provider tool-schema enums are not a trust boundary: deployed models have
  // omitted `status` and have emitted non-enum labels despite the forced tool.
  // Derive only the minimum semantic status needed to reach the real trust
  // boundary below. A response with any declared citation is merely a candidate
  // answerable response and must still pass bidirectional marker/evidence checks;
  // a response with no citations is forced onto the non-answer path.
  const hasDeclaredCitation =
    citation_ids.length > 0 ||
    (kbCitationIds?.length ?? 0) > 0 ||
    (estCitationIds?.length ?? 0) > 0;
  const status =
    normalizeAnswerStatus(input.status) ??
    (hasDeclaredCitation ? "answerable" : "insufficient_context");
  return {
    status,
    answer,
    citation_ids,
    knowledge_citation_ids: kbCitationIds,
    estimate_citation_ids: estCitationIds,
  };
}

function normalizeAnswerStatus(value: unknown): AnswerStatus | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase();
  if (canonical === "answerable") return "answerable";
  if (canonical === "insufficient_context") return "insufficient_context";
  if (canonical === "out_of_scope") return "out_of_scope";
  return null;
}

function classifyInvalidToolInput(input: unknown): string {
  if (!isRecord(input)) return "tool_input_not_object";
  if (typeof input.answer !== "string") return "tool_input_answer_invalid";
  if (
    !Array.isArray(input.citation_ids) ||
    input.citation_ids.some((id) => typeof id !== "string")
  ) {
    return "tool_input_citations_invalid";
  }
  if (
    input.knowledge_citation_ids !== undefined &&
    (!Array.isArray(input.knowledge_citation_ids) ||
      input.knowledge_citation_ids.some((id) => typeof id !== "string"))
  ) {
    return "tool_input_knowledge_citations_invalid";
  }
  if (
    input.estimate_citation_ids !== undefined &&
    (!Array.isArray(input.estimate_citation_ids) ||
      input.estimate_citation_ids.some((id) => typeof id !== "string"))
  ) {
    return "tool_input_estimate_citations_invalid";
  }
  return "tool_input_semantics_invalid";
}

function answerSentences(answer: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < answer.length; i += 1) {
    if (!/[.!?]/.test(answer[i])) continue;
    let next = i + 1;
    if (next < answer.length && !/\s/.test(answer[next]) && answer[next] !== "[") continue;
    let consumedMarker = false;
    while (next < answer.length) {
      while (next < answer.length && /\s/.test(answer[next])) next += 1;
      const marker = /^\[([CKE][1-9]\d*)\]/.exec(answer.slice(next));
      if (!marker) break;
      next += marker[0].length;
      consumedMarker = true;
    }
    sentences.push(answer.slice(start, consumedMarker ? next : i + 1).trim());
    start = consumedMarker ? next : i + 1;
    i = start - 1;
  }
  const tail = answer.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.filter(Boolean);
}

function validateGroundedAnswer(
  answer: string,
  citationIds: string[],
  knownCitationIds: Set<string>,
  knowledgeCitationIds?: string[],
  knownKbCitationIds?: Set<string>,
  knownEstimateCitationIds?: Set<string>,
  estimateCitationIds?: string[],
): boolean {
  if (!answer.trim()) return false;

  // Check [C*] markers (user facts)
  const cMarkerMatches = [...answer.matchAll(/\[(C[1-9]\d*)\]/g)];
  const cAnswerMarkers = new Set(cMarkerMatches.map((match) => match[1]));
  const cReturnedIds = new Set(citationIds);

  // Check [K*] markers (knowledge base)
  const kMarkerMatches = [...answer.matchAll(/\[(K[1-9]\d*)\]/g)];
  const kAnswerMarkers = new Set(kMarkerMatches.map((match) => match[1]));
  const kReturnedIds = new Set(knowledgeCitationIds ?? []);

  // Check [E*] markers (estimate)
  const eMarkerMatches = [...answer.matchAll(/\[(E[1-9]\d*)\]/g)];
  const eAnswerMarkers = new Set(eMarkerMatches.map((match) => match[1]));
  const eReturnedIds = new Set(estimateCitationIds ?? []);

  // At least one citation type must be present
  const totalMarkers = cAnswerMarkers.size + kAnswerMarkers.size + eAnswerMarkers.size;
  const totalReturned = cReturnedIds.size + kReturnedIds.size + eReturnedIds.size;
  if (totalReturned === 0 || totalMarkers === 0) return false;

  // Validate [C*] bidirectional consistency
  if ([...cReturnedIds].some((id) => !knownCitationIds.has(id))) return false;
  if ([...cAnswerMarkers].some((id) => !knownCitationIds.has(id))) return false;
  if ([...cReturnedIds].some((id) => !cAnswerMarkers.has(id))) return false;
  if ([...cAnswerMarkers].some((id) => !cReturnedIds.has(id))) return false;

  // Validate [K*] bidirectional consistency (if KB citations present)
  if (knownKbCitationIds && kReturnedIds.size > 0) {
    if ([...kReturnedIds].some((id) => !knownKbCitationIds.has(id))) return false;
    if ([...kAnswerMarkers].some((id) => !knownKbCitationIds.has(id))) return false;
    if ([...kReturnedIds].some((id) => !kAnswerMarkers.has(id))) return false;
    if ([...kAnswerMarkers].some((id) => !kReturnedIds.has(id))) return false;
  } else if (kReturnedIds.size > 0 || kAnswerMarkers.size > 0) {
    // K markers present but no known KB IDs → invalid
    return false;
  }

  // Validate [E*] bidirectional consistency (if estimate citations present)
  if (knownEstimateCitationIds && eReturnedIds.size > 0) {
    if ([...eReturnedIds].some((id) => !knownEstimateCitationIds.has(id))) return false;
    if ([...eAnswerMarkers].some((id) => !knownEstimateCitationIds.has(id))) return false;
    if ([...eReturnedIds].some((id) => !eAnswerMarkers.has(id))) return false;
    if ([...eAnswerMarkers].some((id) => !eReturnedIds.has(id))) return false;
  } else if (eReturnedIds.size > 0 || eAnswerMarkers.size > 0) {
    // E markers present but no known estimate IDs → invalid
    return false;
  }

  // Every sentence must have at least one valid citation (C, K, or E)
  return answerSentences(answer).every((sentence) => {
    const cMarkers = [...sentence.matchAll(/\[(C[1-9]\d*)\]/g)];
    const kMarkers = [...sentence.matchAll(/\[(K[1-9]\d*)\]/g)];
    const eMarkers = [...sentence.matchAll(/\[(E[1-9]\d*)\]/g)];
    const hasCitation =
      cMarkers.some((m) => knownCitationIds.has(m[1])) ||
      (knownKbCitationIds && kMarkers.some((m) => knownKbCitationIds.has(m[1]))) ||
      (knownEstimateCitationIds && eMarkers.some((m) => knownEstimateCitationIds.has(m[1])));
    return hasCitation;
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function proofMetadata(args: {
  run: Awaited<ReturnType<StartRunFn>>;
  status: AnswerStatus;
  retrievalCount: number;
  citationCount: number;
  kbRetrievalCount?: number;
  kbCitationCount?: number;
  estimateRetrievalCount?: number;
  estimateCitationCount?: number;
  validated: boolean;
  contextHash: string;
}): ProofMetadata {
  return {
    run_id: args.run.runId ?? args.run.request_id,
    grounding_status: args.status,
    retrieval_count: args.retrievalCount,
    citation_count: args.citationCount,
    kb_retrieval_count: args.kbRetrievalCount ?? 0,
    kb_citation_count: args.kbCitationCount ?? 0,
    estimate_retrieval_count: args.estimateRetrievalCount ?? 0,
    estimate_citation_count: args.estimateCitationCount ?? 0,
    validated: args.validated,
    model_provider: MODEL_PROVIDER,
    context_hash: args.contextHash,
  };
}

/**
 * Search the knowledge base for relevant tax knowledge chunks.
 * Best-effort: any failure returns empty array (KB must never block the response).
 */
async function searchKB(
  query: string,
  supabase: SupabaseLike,
  fetchImpl: typeof fetch,
  opts: {
    topK?: number;
    jurisdiction?: string | null;
    taxYear?: number | null;
    cohereApiKey?: string | null;
  } = {},
): Promise<KBSearchResult[]> {
  try {
    const topK = opts.topK ?? 5;
    const jurisdictionFilter =
      opts.jurisdiction === "US-FED" ? null : ["US-FED", opts.jurisdiction!];
    const candidateCount = Math.min(topK * 3, 50);
    const embedding = await embedQuery(query, fetchImpl);
    const { data, error } = await supabase.rpc("search_knowledge_base", {
      query_embedding: JSON.stringify(embedding),
      query_text: query,
      match_count: candidateCount,
      layer_filter: null,
      jurisdiction_filter: jurisdictionFilter,
      tax_year_filter: opts.taxYear ?? null,
      min_confidence: 0.3,
      effective_date_filter: new Date().toISOString().slice(0, 10),
    });
    if (error || !data) {
      console.error("[ask-taxahead] KB search RPC failed:", error);
      return [];
    }
    const candidates: KBSearchResult[] = (data as KBSearchResult[]).map((row): KBSearchResult => ({
      ...row,
      id: row.id,
      source_file: row.source_file,
      layer: row.layer,
      title: row.title,
      content: row.content,
      chunk_index: row.chunk_index,
      vector_score: row.vector_score ?? 0,
      text_score: row.text_score ?? 0,
      combined_score: row.combined_score ?? 0,
      metadata: row.metadata ?? null,
      jurisdiction: row.jurisdiction ?? "US-FED",
      jurisdiction_type: row.jurisdiction_type ?? "federal",
      tax_year: row.tax_year ?? null,
      effective_start: row.effective_start ?? null,
      effective_end: row.effective_end ?? null,
      source_url: row.source_url ?? null,
      source_version: row.source_version ?? null,
      authority_type: row.authority_type ?? "secondary",
      confidence: row.confidence ?? 0.5,
      rerank_score: 0,
    }));
    const reranked = await rerankResults(query, candidates, {
      topK,
      fetchImpl,
      ...(Object.prototype.hasOwnProperty.call(opts, "cohereApiKey")
        ? { apiKey: opts.cohereApiKey }
        : {}),
    });
    return reranked.map((row) => row as KBSearchResult);
  } catch (e) {
    console.error("[ask-taxahead] KB search failed (best-effort):", e);
    return [];
  }
}

export async function handler(
  req: Request,
  deps?: {
    supabase?: SupabaseLike;
    fetch?: typeof fetch;
    startRun?: StartRunFn;
    cohereApiKey?: string | null;
    invokeFunction?: InvokeFunction;
    paidEntitlement?: PaidEntitlementAuthorizer;
  },
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const startRun = deps?.startRun ?? realStartRun;
  const run = await startRun({
    workflow_name: "ask-taxahead",
    entity_type: "filing_unit",
  });
  const log = logger("ask-taxahead");
  const fail = async (
    code: string,
    status: number,
    detail?: string,
    extra?: Record<string, unknown>,
  ) => {
    log.error(code, detail ? { detail } : undefined);
    await run.finish("failed", { error_code: code, error_detail: detail });
    return json({ error: code, ...(detail ? { detail } : {}), ...(extra ?? {}) }, status);
  };
  const succeed = async (body: unknown) => {
    await run.finish("succeeded", {});
    return json(body);
  };

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return fail("missing_authorization", 401);

  let body: { filing_unit_id?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const { filing_unit_id, question } = body;
  if (!filing_unit_id || !question) {
    return fail("filing_unit_id_and_question_required", 400);
  }
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) return fail("question_empty", 400);
  if (trimmedQuestion.length > MAX_QUESTION_LEN) {
    return fail("question_too_long", 400, undefined, {
      max_length: MAX_QUESTION_LEN,
    });
  }

  const supabaseUrl = env("SUPABASE_URL") ?? "";
  const supabaseAnonKey = env("SUPABASE_ANON_KEY") ?? "";
  const supabase: SupabaseLike =
    deps?.supabase ??
    (createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    }) as unknown as SupabaseLike);
  const entitlement = deps?.paidEntitlement
    ? await deps.paidEntitlement(supabase, "advisor")
    : deps?.supabase
      ? ({ allowed: true, status: 200, reason: "entitled", feature: "advisor" } as const)
      : await authorizePaidFeature(supabase, "advisor");
  if (!entitlement.allowed) {
    log.error(entitlement.error, { feature: entitlement.feature });
    await run.finish("failed", { error_code: entitlement.error });
    return json(paidEntitlementErrorBody(entitlement), entitlement.status);
  }
  const fetchImpl = deps?.fetch ?? fetch;
  const invokeFunction: InvokeFunction | undefined = deps?.invokeFunction;

  const fuResult = await Promise.resolve(
    supabase
      .from("filing_units")
      .select("id, tax_year, filing_status, jurisdiction")
      .eq("id", filing_unit_id)
      .maybeSingle(),
  ).catch(() => null);
  if (!fuResult) return fail("lookup_failed", 500);
  const { data: fu, error: fuErr } = fuResult;
  if (fuErr) return fail("lookup_failed", 500);
  if (!fu) return fail("filing_unit_not_found_or_unauthorized", 403);
  if (!validStoredJurisdiction(fu.jurisdiction) || !validStoredTaxYear(fu.tax_year)) {
    return fail("invalid_filing_unit_scope", 422);
  }

  // Ground the answer in a lean slice of current state -- enough to answer
  // realistic questions without pulling the entire Tax Package payload.
  const grounding = await Promise.all([
    supabase
      .from("scores")
      .select("readiness, filing_confidence, discovery_confidence")
      .eq("filing_unit_id", filing_unit_id)
      .order("computed_at", {
        ascending: false,
      })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("facts")
      .select(
        "id, filing_unit_id, category, key, value, confidence, state, fact_evidence(evidence:evidence(id, filing_unit_id, extraction_confidence, document:documents(id, filing_unit_id, filename, doc_type, issuer, source:sources(id, filing_unit_id, label, type))))",
      )
      .eq("filing_unit_id", filing_unit_id)
      .order("id", { ascending: true })
      .order("evidence_id", { ascending: true, referencedTable: "fact_evidence" }),
    supabase
      .from("expected_items")
      .select("category, label")
      .eq("filing_unit_id", filing_unit_id)
      .eq("state", "missing"),
  ]).catch(() => null);
  if (!grounding) return fail("grounding_lookup_failed", 500);
  const [scoreResult, factsResult, missingResult] = grounding;

  if (scoreResult.error || factsResult.error || missingResult.error) {
    return fail("grounding_lookup_failed", 500);
  }
  const score = scoreResult.data;
  const missing = (missingResult.data ?? []) as Array<{ label: string; category: string }>;
  const citations: GroundingCitation[] = [];
  const factLines: string[] = [];
  for (const f of (factsResult.data ?? []) as FactRow[]) {
    const evidence = f.fact_evidence?.[0]?.evidence;
    const document = evidence?.document;
    const source = document?.source;
    const lineage = [f, evidence, document, source];
    if (
      !f.id ||
      !evidence?.id ||
      !document?.id ||
      !document?.filename ||
      !source?.id ||
      !source?.label ||
      !source?.type ||
      lineage.some((row) => row?.filing_unit_id !== filing_unit_id)
    )
      continue;
    const citation = {
      id: `C${citations.length + 1}`,
      fact_id: f.id,
      evidence_id: evidence.id,
      document_id: document.id,
      filename: document.filename,
      doc_type: document.doc_type ?? null,
      issuer: document.issuer ?? null,
      source_id: source.id,
      source_label: source.label,
      source_type: source.type,
    };
    citations.push(citation);
    const v = (f.value as { v?: unknown })?.v;
    factLines.push(
      `- [${citation.id}] [${f.category}] ${f.key}: ${JSON.stringify(v)} ` +
        `(confidence ${clamp01(f.confidence ?? 0)}, ${f.state}; ` +
        `document ${citation.filename}; issuer ${citation.issuer ?? "unknown"}; ` +
        `source ${citation.source_label})`,
    );
  }
  // Knowledge base search (best-effort — never blocks the response)
  const kbResults = await searchKB(trimmedQuestion, supabase, fetchImpl, {
    topK: 5,
    jurisdiction: fu.jurisdiction,
    taxYear: fu.tax_year,
    ...(deps && Object.prototype.hasOwnProperty.call(deps, "cohereApiKey")
      ? { cohereApiKey: deps.cohereApiKey }
      : {}),
  });

  // Fail only if BOTH user facts and knowledge base are empty
  if (!factLines.length && kbResults.length === 0) {
    return fail("insufficient_grounded_evidence", 422);
  }

  const missingLines = missing.map((m) => `- ${m.label} (${m.category})`);

  // Build KB context lines with [K*] citations
  const kbLines: string[] = [];
  const kbCitations: KBSearchResult[] = [];
  for (let i = 0; i < kbResults.length; i++) {
    const kb = kbResults[i];
    const kbId = `K${i + 1}`;
    kbCitations.push(kb);
    kbLines.push(
      `- [${kbId}] [${kb.layer}] ${kb.title} (chunk ${kb.chunk_index}): ` +
        kb.content.slice(0, 1200),
    );
  }

  const contextParts = [
    `Tax year: ${fu.tax_year}. Filing status: ${fu.filing_status}.`,
    `Readiness: ${score?.readiness ?? 0}%. Package confidence: ${
      score?.filing_confidence ?? 0
    }%. ` + `Discovery confidence: ${score?.discovery_confidence ?? 0}%.`,
  ];
  if (factLines.length) {
    contextParts.push("Discovered facts:", factLines.join("\n"));
  } else {
    contextParts.push("Discovered facts:", "(no records available)");
  }
  if (kbLines.length) {
    contextParts.push(
      "",
      "Tax knowledge (general reference — cite as [K1], [K2], etc.):",
      kbLines.join("\n"),
    );
  }
  contextParts.push(
    "",
    "Missing information:",
    missingLines.length ? missingLines.join("\n") : "(none identified)",
  );
  const context = contextParts.join("\n");
  // contextHash is used when estimate context is not available; finalContextHash is always computed

  // ── Estimate context (best-effort: compute-federal-tax-estimate) ──────
  let estimateCitations: EstimateCitation[] | null = null;
  let estimateSummary: EstimateSummary | null = null;
  let estimateRetrievalCount = 0;
  const estimateCitationCount = 0;
  let estimateContextLines: string[] = [];

  if (invokeFunction) {
    try {
      const estimateResult = await Promise.race([
        invokeFunction("compute-federal-tax-estimate", {
          body: { filing_unit_id },
          headers: { Authorization: authHeader },
        }),
        new Promise<{ data: null; error: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: "timeout" }), 5000),
        ),
      ]);
      const resultData = estimateResult.data as Record<string, unknown> | null;
      const resultError = estimateResult.error;
      if (
        !resultError &&
        resultData &&
        resultData.status === "success" &&
        typeof resultData.gross_income === "number" &&
        resultData.gross_income > 0
      ) {
        const taxableIncome = resultData.taxable_income as number | null;
        const estimatedTax = resultData.estimated_tax as number | null;
        const effectiveRate = resultData.effective_rate as number | null;
        const estimatedTaxAfterCredits = resultData.estimated_tax_after_credits as number | null;
        const potentialDeductions = resultData.potential_deductions as Record<
          string,
          unknown
        > | null;
        const potentialCredits = resultData.potential_credits as Record<string, unknown> | null;
        const recommendations = resultData.recommendations as Array<Record<string, unknown>> | null;
        const missedOpportunities = resultData.missed_opportunities as Array<
          Record<string, unknown>
        > | null;
        const citations = resultData.citations as Array<Record<string, unknown>> | null;

        let eNumber = 0;

        // Base entries
        const baseLines: string[] = [];
        baseLines.push(`--- Tax estimate (computed by TaxAhead's estimate engine) ---`);
        eNumber += 1;
        baseLines.push(
          `[E${eNumber}] Estimated taxable income: $${(taxableIncome ?? 0).toFixed(2)} (after standard deduction)`,
        );
        eNumber += 1;
        baseLines.push(
          `[E${eNumber}] Estimated federal tax: $${(estimatedTax ?? 0).toFixed(2)} (before credits)`,
        );
        eNumber += 1;
        baseLines.push(`[E${eNumber}] Effective tax rate: ${(effectiveRate ?? 0).toFixed(1)}%`);
        eNumber += 1;
        baseLines.push(
          `[E${eNumber}] Estimated tax after credits: $${(estimatedTaxAfterCredits ?? 0).toFixed(2)}`,
        );
        eNumber += 1;
        const dedTotal = (potentialDeductions?.total as number) ?? 0;
        const credTotal = (potentialCredits?.total as number) ?? 0;
        baseLines.push(
          `[E${eNumber}] Potential deductions: $${dedTotal.toFixed(2)}; Potential credits: $${credTotal.toFixed(2)}`,
        );

        // Recommendations
        const recLines: string[] = [];
        if (recommendations && recommendations.length > 0) {
          for (const rec of recommendations) {
            eNumber += 1;
            recLines.push(
              `[E${eNumber}] Recommendation: ${rec.title as string}: ${rec.description as string}`,
            );
          }
        }

        // Missed opportunities
        const oppLines: string[] = [];
        if (missedOpportunities && missedOpportunities.length > 0) {
          for (const mo of missedOpportunities) {
            eNumber += 1;
            oppLines.push(`[E${eNumber}] Missed opportunity: ${mo.description as string}`);
          }
        }

        // Rule citations
        const citLines: string[] = [];
        if (citations && citations.length > 0) {
          for (const cit of citations) {
            eNumber += 1;
            citLines.push(
              `[E${eNumber}] Rule: ${cit.value_label as string} = $${(cit.computed_value as number).toFixed(2)} (${cit.rule_summary as string})`,
            );
          }
        }

        // Build estimate context lines
        estimateContextLines = [...baseLines, ...recLines, ...oppLines, ...citLines];

        // Build estimateCitations (for response)
        estimateCitations = [];
        let ecNumber = 0;
        // Base estimate citations
        ecNumber += 1;
        estimateCitations.push({
          id: `E${ecNumber}`,
          value_label: "Taxable Income",
          computed_value: taxableIncome ?? 0,
          source_type: "irs_bracket_table",
          source_ref: "irs_2025_bracket_table",
          rule_summary: `Gross income minus standard deduction`,
        });
        ecNumber += 1;
        estimateCitations.push({
          id: `E${ecNumber}`,
          value_label: "Federal Income Tax",
          computed_value: estimatedTax ?? 0,
          source_type: "irs_bracket_table",
          source_ref: "irs_2025_bracket_table",
          rule_summary: `Marginal bracket tax on taxable income`,
        });
        ecNumber += 1;
        estimateCitations.push({
          id: `E${ecNumber}`,
          value_label: "Effective Tax Rate",
          computed_value: Math.round((effectiveRate ?? 0) * 100) / 100,
          source_type: "irs_bracket_table",
          source_ref: "irs_2025_bracket_table",
          rule_summary: `Estimated tax divided by gross income`,
        });
        ecNumber += 1;
        estimateCitations.push({
          id: `E${ecNumber}`,
          value_label: "Estimated Tax After Credits",
          computed_value: estimatedTaxAfterCredits ?? 0,
          source_type: "irs_bracket_table",
          source_ref: "irs_2025_bracket_table",
          rule_summary: `Federal income tax minus credits`,
        });
        ecNumber += 1;
        estimateCitations.push({
          id: `E${ecNumber}`,
          value_label: "Potential Deductions and Credits",
          computed_value: dedTotal + credTotal,
          source_type: "discovered_fact",
          source_ref: "multiple",
          rule_summary: `Total potential deductions and credits from discovered facts`,
        });

        // Append rule citations from the estimate response
        if (citations && citations.length > 0) {
          for (const cit of citations) {
            ecNumber += 1;
            estimateCitations.push({
              id: `E${ecNumber}`,
              value_label: cit.value_label as string,
              computed_value: cit.computed_value as number,
              source_type: cit.source_type as
                "kb_document" | "discovered_fact" | "irs_bracket_table",
              source_ref: cit.source_ref as string,
              rule_summary: cit.rule_summary as string,
            });
          }
        }

        // Build estimateSummary
        estimateSummary = {
          estimated_tax: estimatedTax ?? null,
          taxable_income: taxableIncome ?? null,
          effective_rate: effectiveRate ?? null,
          estimated_tax_after_credits: estimatedTaxAfterCredits ?? null,
        };

        // Count only [E*] entries, not the header line
        estimateRetrievalCount = eNumber;
      }
    } catch {
      // Best-effort: estimate failure is swallowed
    }
  }

  // Inject estimate context into the CONTEXT block
  if (estimateContextLines.length > 0) {
    contextParts.push("", ...estimateContextLines);
  }
  const finalContext = contextParts.join("\n");
  const finalContextHash = await sha256Hex(finalContext);

  let toolInput: ToolInput;
  let chatFailure = "provider_transport_failed";
  try {
    const openrouterApiKey = env("OPENROUTER_API_KEY") ?? "";
    const resp = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${openrouterApiKey}`,
        "content-type": "application/json",
        "http-referer": "https://taxahead.app",
        "x-title": "TaxAhead",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `CONTEXT:\n${finalContext}\n\nQUESTION: ${trimmedQuestion}`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: ANSWER_TOOL.name,
              description: ANSWER_TOOL.description,
              parameters: ANSWER_TOOL.input_schema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: ANSWER_TOOL.name } },
      }),
    });
    if (!resp.ok) {
      chatFailure = classifyChatProviderStatus(resp.status);
      throw new Error(chatFailure);
    }
    const data = (await resp.json()) as {
      choices?: Array<{
        message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
      }>;
    };
    const toolCalls = data.choices?.[0]?.message?.tool_calls ?? [];
    const toolCall = toolCalls.find((c) => c.function?.name === ANSWER_TOOL.name) ?? toolCalls[0];
    const rawArgs = toolCall?.function?.arguments;
    if (rawArgs === undefined) {
      chatFailure = "tool_use_missing";
      throw new Error(chatFailure);
    }
    let toolInputRaw: unknown;
    try {
      toolInputRaw = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    } catch {
      chatFailure = "tool_use_missing";
      throw new Error(chatFailure);
    }
    const parsed = parseToolInput(toolInputRaw);
    chatFailure = parsed ? "provider_transport_failed" : classifyInvalidToolInput(toolInputRaw);
    if (!parsed) throw new Error("invalid_tool_response");
    toolInput = parsed;
  } catch {
    return fail("chat_failed", 502, undefined, { chat_failure: chatFailure });
  }

  if (toolInput.status === "insufficient_context") {
    const proof = proofMetadata({
      run,
      status: "insufficient_context",
      retrievalCount: citations.length,
      citationCount: 0,
      kbRetrievalCount: kbCitations.length,
      kbCitationCount: 0,
      estimateRetrievalCount,
      estimateCitationCount: 0,
      validated: true,
      contextHash: finalContextHash,
    });
    return fail(
      "insufficient_context",
      422,
      "I do not have enough grounded tax evidence to answer that from your records.",
      { proof, ...proof },
    );
  }
  if (toolInput.status === "out_of_scope") {
    const proof = proofMetadata({
      run,
      status: "out_of_scope",
      retrievalCount: citations.length,
      citationCount: 0,
      kbRetrievalCount: kbCitations.length,
      kbCitationCount: 0,
      estimateRetrievalCount,
      estimateCitationCount: 0,
      validated: true,
      contextHash: finalContextHash,
    });
    return fail(
      "out_of_scope",
      422,
      "I can only answer questions about tax topics and your TaxAhead tax records.",
      { proof, ...proof },
    );
  }

  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  const uniqueIds = [...new Set(toolInput.citation_ids)];
  const kbById = new Map(kbCitations.map((kb) => [`K${kbCitations.indexOf(kb) + 1}`, kb]));
  const uniqueKbIds = [...new Set(toolInput.knowledge_citation_ids ?? [])];

  // Build known estimate citation IDs from the estimateCitations array
  const knownEstimateIdSet: Set<string> | undefined = estimateCitations
    ? new Set(estimateCitations.map((ec) => ec.id))
    : undefined;
  const uniqueEstimateIds = [...new Set(toolInput.estimate_citation_ids ?? [])];

  if (
    !validateGroundedAnswer(
      toolInput.answer,
      toolInput.citation_ids,
      new Set(byId.keys()),
      toolInput.knowledge_citation_ids,
      kbCitations.length > 0 ? new Set(kbById.keys()) : undefined,
      knownEstimateIdSet,
      toolInput.estimate_citation_ids,
    )
  ) {
    return fail("invalid_grounded_answer", 502);
  }
  const usedCitations = uniqueIds.map((id) => byId.get(id)!);
  const usedKbCitations = uniqueKbIds.map((id) => kbById.get(id)!).filter(Boolean);
  const proof = proofMetadata({
    run,
    status: "answerable",
    retrievalCount: citations.length,
    citationCount: usedCitations.length,
    kbRetrievalCount: kbCitations.length,
    kbCitationCount: usedKbCitations.length,
    estimateRetrievalCount,
    estimateCitationCount: uniqueEstimateIds.length,
    validated: true,
    contextHash: finalContextHash,
  });

  // Best-effort visibility into feed history; not load-bearing for the answer
  // already returned to the client. Explicitly caught: a Postgrest-level error
  // resolves rather than throws, but a network-level failure on the fetch
  // itself would reject and must not be allowed to discard the already-
  // generated (already-paid-for) answer.
  let historyPersisted = true;
  try {
    const { error: historyError } = await supabase.from("feed_messages").insert({
      filing_unit_id,
      type: "chat",
      priority: 5,
      title: trimmedQuestion.slice(0, 120),
      body: toolInput.answer,
      actions: [
        {
          label: "View sources",
          action: "view_evidence",
          citations: usedCitations,
        },
      ],
      state: "resolved",
    });
    if (historyError) historyPersisted = false;
  } catch {
    historyPersisted = false;
  }

  // Circular 230 compliance: append disclaimer when KB citations are used
  const hasKbCitations = usedKbCitations.length > 0;
  const complianceWarnings = hasKbCitations ? detectUncitedRecommendations(toolInput.answer) : [];
  const disclaimer = hasKbCitations ? CIRCULAR_230_DISCLAIMER : undefined;

  return succeed({
    status: "answerable",
    answer: toolInput.answer,
    citation_ids: uniqueIds,
    citations: usedCitations,
    knowledge_citation_ids: uniqueKbIds.length > 0 ? uniqueKbIds : undefined,
    kb_citations:
      usedKbCitations.length > 0
        ? usedKbCitations.map((kb) => ({
            id: kb.id,
            citation_key: `K${kbCitations.indexOf(kb) + 1}`,
            source_file: kb.source_file,
            layer: kb.layer,
            title: kb.title,
            content: kb.content,
            chunk_index: kb.chunk_index,
            metadata: kb.metadata,
            jurisdiction: kb.jurisdiction,
            jurisdiction_type: kb.jurisdiction_type,
            tax_year: kb.tax_year,
            effective_start: kb.effective_start,
            effective_end: kb.effective_end,
            source_url: kb.source_url,
            source_version: kb.source_version,
            authority_type: kb.authority_type,
            confidence: kb.confidence,
            vector_score: kb.vector_score,
            text_score: kb.text_score,
            combined_score: kb.combined_score,
            rerank_score: kb.rerank_score,
          }))
        : undefined,
    disclaimer,
    compliance_warnings: complianceWarnings.length > 0 ? complianceWarnings : undefined,
    estimate_citations: estimateCitations ? estimateCitations : undefined,
    estimate_summary: estimateSummary ? estimateSummary : undefined,
    proof,
    ...proof,
    history_persisted: historyPersisted,
    history_error: historyPersisted ? null : "answer_history_write_failed",
  });
}

if (import.meta.main) {
  Deno.serve((req) => handler(req));
}
