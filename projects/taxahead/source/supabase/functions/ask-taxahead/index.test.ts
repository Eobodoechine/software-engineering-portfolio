import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createFakeClient as createBaseFakeClient,
  type FakeClientConfig,
} from "../_shared/test-support/fake-client.ts";
import { handler as productionHandler } from "./index.ts";

function createFakeClient(config: FakeClientConfig) {
  return createBaseFakeClient({
    ...config,
    rpc: {
      search_knowledge_base: () => ({ data: [], error: null }),
      ...(config.rpc ?? {}),
    },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

async function handler(
  req: Request,
  deps?: Parameters<typeof productionHandler>[1],
): Promise<Response> {
  const downstreamFetch = deps?.fetch ?? fetch;
  return productionHandler(req, {
    ...deps,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("api.openai.com/v1/embeddings")) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array(1536).fill(0.01) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("api.cohere.com/v2/rerank")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const count = Math.min(body.top_n ?? 0, body.documents?.length ?? 0);
        return new Response(
          JSON.stringify({
            results: Array.from({ length: count }, (_, index) => ({
              index,
              relevance_score: 1 - index / Math.max(count, 1),
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return downstreamFetch(input, init);
    },
  });
}

type ModelCitationCase = "known" | "unknown" | "empty";
type ModelResponseOptions = {
  status?: string;
  answer?: string;
  citationIds?: string[];
  extraInput?: Record<string, unknown>;
};

function req(body: unknown, authorized = true): Request {
  return new Request("http://localhost/ask-taxahead", {
    method: "POST",
    headers: {
      ...(authorized ? { Authorization: "Bearer test-jwt" } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function linkedFact() {
  return {
    id: "fact-1",
    filing_unit_id: "fu-1",
    category: "income",
    key: "wages",
    value: { v: 123456.78 },
    confidence: 0.99,
    state: "confirmed",
    fact_evidence: [
      {
        evidence: {
          id: "evidence-1",
          filing_unit_id: "fu-1",
          extraction_confidence: 0.98,
          document: {
            id: "document-1",
            filing_unit_id: "fu-1",
            filename: "2025-W2-ACME.pdf",
            doc_type: "W-2",
            issuer: "ACME Corporation",
            source: {
              id: "source-1",
              filing_unit_id: "fu-1",
              label: "Gmail",
              type: "gmail",
            },
          },
        },
      },
    ],
  };
}

function secondLinkedFact() {
  return {
    id: "fact-2",
    filing_unit_id: "fu-1",
    category: "deduction",
    key: "mortgage_interest",
    value: { v: 4200 },
    confidence: 0.97,
    state: "confirmed",
    fact_evidence: [
      {
        evidence: {
          id: "evidence-2",
          filing_unit_id: "fu-1",
          extraction_confidence: 0.96,
          document: {
            id: "document-2",
            filing_unit_id: "fu-1",
            filename: "2025-1098-Bank.pdf",
            doc_type: "1098",
            issuer: "Example Bank",
            source: {
              id: "source-2",
              filing_unit_id: "fu-1",
              label: "Drive",
              type: "drive",
            },
          },
        },
      },
    ],
  };
}

function tableResolvers(
  factsResult:
    | { data: unknown; error: null }
    | {
        data: null;
        error: { message: string; code?: string };
      },
  feedResult:
    | { data: unknown; error: null }
    | {
        data: null;
        error: { message: string; code?: string };
      } = { data: [{ id: "feed-1" }], error: null },
) {
  return {
    "filing_units:select": () => ({
      data: [
        {
          id: "fu-1",
          tax_year: 2025,
          filing_status: "single",
          jurisdiction: "US-FED",
        },
      ],
      error: null,
    }),
    "scores:select": () => ({
      data: [
        {
          readiness: 72,
          filing_confidence: 81,
          discovery_confidence: 90,
        },
      ],
      error: null,
    }),
    "facts:select": () => factsResult,
    "expected_items:select": () => ({ data: [], error: null }),
    "feed_messages:insert": () => feedResult,
  };
}

function modelResponse(options: ModelCitationCase | ModelResponseOptions = "known"): Response {
  const normalized: ModelResponseOptions =
    typeof options === "string"
      ? {
          citationIds: options === "known" ? ["C1"] : options === "unknown" ? ["C999"] : [],
        }
      : options;
  const citationIds = normalized.citationIds ?? ["C1"];
  const answer = normalized.answer ?? "Your persisted W-2 reports wages of $123,456.78. [C1]";
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "answer_from_evidence",
                  arguments: JSON.stringify({
                    status: normalized.status ?? "answerable",
                    answer,
                    citation_ids: citationIds,
                    ...(normalized.extraInput ?? {}),
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function feedInsertCount(calls: ReturnType<typeof createFakeClient>["calls"]): number {
  return calls.filter(
    (call) => call.kind === "table" && call.table === "feed_messages" && call.action === "insert",
  ).length;
}

async function captureConsole(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = capture;
  console.warn = capture;
  console.log = capture;
  try {
    await run();
  } finally {
    console.error = original.error;
    console.warn = original.warn;
    console.log = original.log;
  }
  return logs;
}

function assertNoCanary(surface: string, canary: string) {
  for (const forbidden of [canary, encodeURIComponent(canary), btoa(canary)]) {
    assert(!surface.includes(forbidden), `canary leaked: ${surface}`);
  }
}

Deno.test(
  "[CONTROL] ask-taxahead rejects missing auth before any retrieval or model call",
  async () => {
    const modelCalls: unknown[] = [];
    const res = await handler(
      req({ filing_unit_id: "fu-1", question: "What were my wages?" }, false),
      {
        fetch: (...args: Parameters<typeof fetch>) => {
          modelCalls.push(args);
          return Promise.resolve(modelResponse());
        },
      },
    );

    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "missing_authorization");
    assertEquals(modelCalls.length, 0);
  },
);

Deno.test("[CONTROL] ask-taxahead preserves the filing-unit ownership boundary", async () => {
  const { client } = createFakeClient({
    table: {
      "filing_units:select": () => ({ data: [], error: null }),
    },
  });
  const modelCalls: unknown[] = [];
  const res = await handler(
    req({
      filing_unit_id: "not-owned",
      question: "What were my wages?",
    }),
    {
      supabase: client,
      fetch: (...args: Parameters<typeof fetch>) => {
        modelCalls.push(args);
        return Promise.resolve(modelResponse());
      },
    },
  );

  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, "filing_unit_not_found_or_unauthorized");
  assertEquals(modelCalls.length, 0);
});

Deno.test("[BEHAVIORAL] state filing scope reaches the eight-argument KB RPC exactly", async () => {
  let rpcArgs: Record<string, unknown> | undefined;
  const { client, calls } = createFakeClient({
    table: {
      ...tableResolvers({ data: [linkedFact()], error: null }),
      "filing_units:select": () => ({
        data: [
          {
            id: "fu-1",
            tax_year: 2025,
            filing_status: "single",
            jurisdiction: "US-GA",
          },
        ],
        error: null,
      }),
    },
    rpc: {
      search_knowledge_base: (args) => {
        rpcArgs = args;
        return { data: [], error: null };
      },
    },
  });
  const response = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
    supabase: client,
    fetch: () => Promise.resolve(modelResponse()),
  });

  assertEquals(response.status, 200);
  assertEquals(rpcArgs, {
    query_embedding: JSON.stringify(new Array(1536).fill(0.01)),
    query_text: "What were my wages?",
    match_count: 15,
    layer_filter: null,
    jurisdiction_filter: ["US-FED", "US-GA"],
    tax_year_filter: 2025,
    min_confidence: 0.3,
    effective_date_filter: new Date().toISOString().slice(0, 10),
  });
  const filingLookup = calls.find((call) => call.kind === "table" && call.table === "filing_units");
  assert(
    filingLookup?.kind === "table" &&
      filingLookup.filters.some(
        (filter) =>
          filter.method === "select" &&
          String(filter.args[0]).includes("jurisdiction") &&
          String(filter.args[0]).includes("tax_year"),
      ),
    "filing-unit lookup did not select jurisdiction and tax_year",
  );
});

Deno.test("[BEHAVIORAL] federal filing scope sends a null jurisdiction filter", async () => {
  let rpcArgs: Record<string, unknown> | undefined;
  const { client } = createFakeClient({
    table: tableResolvers({ data: [linkedFact()], error: null }),
    rpc: {
      search_knowledge_base: (args) => {
        rpcArgs = args;
        return { data: [], error: null };
      },
    },
  });
  const response = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
    supabase: client,
    fetch: () => Promise.resolve(modelResponse()),
  });

  assertEquals(response.status, 200);
  assertEquals(rpcArgs?.jurisdiction_filter, null);
  assertEquals(rpcArgs?.tax_year_filter, 2025);
  assertEquals(rpcArgs?.match_count, 15);
});

Deno.test(
  "[BEHAVIORAL] rejected filing-unit lookup becomes a sanitized stable 500 with no model call",
  async () => {
    const canary = "refresh_token=filing-lookup-canary";
    const { client } = createFakeClient({
      table: {
        "filing_units:select": () => Promise.reject(new Error(canary)),
      },
    });
    const modelCalls: unknown[] = [];
    let response: Response | undefined;
    let rejected: unknown;
    const logs = await captureConsole(async () => {
      try {
        response = await handler(
          req({
            filing_unit_id: "fu-1",
            question: "What were my wages?",
          }),
          {
            supabase: client,
            fetch: (...args: Parameters<typeof fetch>) => {
              modelCalls.push(args);
              return Promise.resolve(modelResponse());
            },
          },
        );
      } catch (error) {
        rejected = error;
      }
    });

    const bodyText = response ? await response.text() : "";
    assertNoCanary(`${bodyText}\n${logs.join("\n")}`, canary);
    assertEquals(
      {
        rejected: rejected === undefined ? null : String(rejected),
        status: response?.status ?? null,
        error: bodyText ? JSON.parse(bodyText).error : null,
        model_calls: modelCalls.length,
      },
      {
        rejected: null,
        status: 500,
        error: "lookup_failed",
        model_calls: 0,
      },
    );
  },
);

Deno.test(
  "[BEHAVIORAL] rejected grounding lookup becomes a sanitized stable 500 with no model call",
  async () => {
    const canary = "access_token=grounding-lookup-canary";
    const { client } = createFakeClient({
      table: {
        ...tableResolvers({ data: [linkedFact()], error: null }),
        "facts:select": () => Promise.reject(new Error(canary)),
      },
    });
    const modelCalls: unknown[] = [];
    let response: Response | undefined;
    let rejected: unknown;
    const logs = await captureConsole(async () => {
      try {
        response = await handler(
          req({
            filing_unit_id: "fu-1",
            question: "What were my wages?",
          }),
          {
            supabase: client,
            fetch: (...args: Parameters<typeof fetch>) => {
              modelCalls.push(args);
              return Promise.resolve(modelResponse());
            },
          },
        );
      } catch (error) {
        rejected = error;
      }
    });

    const bodyText = response ? await response.text() : "";
    assertNoCanary(`${bodyText}\n${logs.join("\n")}`, canary);
    assertEquals(
      {
        rejected: rejected === undefined ? null : String(rejected),
        status: response?.status ?? null,
        error: bodyText ? JSON.parse(bodyText).error : null,
        model_calls: modelCalls.length,
      },
      {
        rejected: null,
        status: 500,
        error: "grounding_lookup_failed",
        model_calls: 0,
      },
    );
  },
);

Deno.test(
  "[BEHAVIORAL] retrieval error fails closed with 500 and never calls the model",
  async () => {
    const secret = "refresh_token=retrieval-secret";
    const { client } = createFakeClient({
      table: tableResolvers({
        data: null,
        error: { message: `facts unavailable ${secret}` },
      }),
    });
    const modelCalls: unknown[] = [];
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: (...args: Parameters<typeof fetch>) => {
          modelCalls.push(args);
          return Promise.resolve(modelResponse());
        },
      },
    );

    const bodyText = await res.text();
    assertEquals(res.status, 500);
    assertEquals(JSON.parse(bodyText).error, "grounding_lookup_failed");
    assertEquals(modelCalls.length, 0);
    assert(!bodyText.includes("retrieval-secret"), bodyText);
  },
);

Deno.test(
  "[BEHAVIORAL] an unlinked fact is insufficient grounded evidence and never reaches the model",
  async () => {
    const { client } = createFakeClient({
      table: tableResolvers({
        data: [{ ...linkedFact(), fact_evidence: [] }],
        error: null,
      }),
    });
    const modelCalls: unknown[] = [];
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: (...args: Parameters<typeof fetch>) => {
          modelCalls.push(args);
          return Promise.resolve(modelResponse());
        },
      },
    );

    assertEquals(res.status, 422);
    assertEquals((await res.json()).error, "insufficient_grounded_evidence");
    assertEquals(modelCalls.length, 0);
  },
);

Deno.test(
  "[BEHAVIORAL] every nested citation lineage row must belong to the requested filing unit",
  async () => {
    const outcomes: Array<{ layer: string; status: number; model_calls: number }> = [];
    for (const layer of ["fact", "evidence", "document", "source"] as const) {
      const fact = structuredClone(linkedFact());
      const evidence = fact.fact_evidence[0].evidence;
      if (layer === "fact") fact.filing_unit_id = "fu-other";
      if (layer === "evidence") evidence.filing_unit_id = "fu-other";
      if (layer === "document") evidence.document.filing_unit_id = "fu-other";
      if (layer === "source") {
        evidence.document.source.filing_unit_id = "fu-other";
      }

      const { client } = createFakeClient({
        table: tableResolvers({ data: [fact], error: null }),
      });
      let modelCalls = 0;
      const res = await handler(
        req({
          filing_unit_id: "fu-1",
          question: "What were my wages?",
        }),
        {
          supabase: client,
          fetch: () => {
            modelCalls += 1;
            return Promise.resolve(modelResponse());
          },
        },
      );
      outcomes.push({ layer, status: res.status, model_calls: modelCalls });
    }

    assertEquals(outcomes, [
      { layer: "fact", status: 422, model_calls: 0 },
      { layer: "evidence", status: 422, model_calls: 0 },
      { layer: "document", status: 422, model_calls: 0 },
      { layer: "source", status: 422, model_calls: 0 },
    ]);
  },
);

Deno.test(
  "[BEHAVIORAL] linked evidence grounds the prompt, response, and persisted citation",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          modelCalls.push({ input, init });
          return Promise.resolve(modelResponse());
        },
      },
    );

    assertEquals(res.status, 200);
    assertEquals(modelCalls.length, 1);
    const modelBody = JSON.parse(String(modelCalls[0].init?.body));
    const prompt = JSON.stringify(modelBody.messages);
    const modelInstructions = `${modelBody.system ?? ""}\n${prompt}`;
    assertStringIncludes(prompt, "123456.78");
    assertStringIncludes(prompt, "2025-W2-ACME.pdf");
    assertStringIncludes(prompt, "ACME Corporation");
    assertStringIncludes(prompt, "Gmail");
    assertStringIncludes(prompt, "C1");
    assertStringIncludes(
      modelInstructions,
      "Set status to insufficient_context when neither the tax records nor the knowledge base contain enough evidence to answer",
    );
    assertStringIncludes(
      modelInstructions,
      "out_of_scope when the question is not about tax at all",
    );
    assertStringIncludes(modelInstructions, "For answerable responses");
    assertStringIncludes(
      modelInstructions,
      "every factual sentence must contain one or more exact bracket markers",
    );
    assertStringIncludes(modelInstructions, "Every returned ID must appear as a bracket marker");
    assertEquals(modelBody.tool_choice, {
      type: "function",
      function: { name: "answer_from_evidence" },
    });
    assertEquals(modelBody.tools[0].function.parameters, {
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
    });

    const body = await res.json();
    assertEquals(body.answer, "Your persisted W-2 reports wages of $123,456.78. [C1]");
    assertEquals(body.status, "answerable");
    assertEquals(body.grounding_status, "answerable");
    assertEquals(body.citation_ids, ["C1"]);
    assertEquals(body.proof?.run_id, body.run_id);
    assertEquals(body.proof?.grounding_status, "answerable");
    assertEquals(body.proof?.retrieval_count, 1);
    assertEquals(body.proof?.citation_count, 1);
    assertEquals(body.proof?.validated, true);
    assertEquals(body.proof?.model_provider, "anthropic");
    assert(
      /^[0-9a-f]{64}$/.test(body.proof?.context_hash ?? ""),
      `context_hash was not a sha256 hex digest: ${body.proof?.context_hash}`,
    );
    assertEquals(body.context_hash, body.proof.context_hash);
    assertEquals(body.validated, true);
    assertEquals(body.history_persisted, true);
    assertEquals(body.citations, [
      {
        id: "C1",
        fact_id: "fact-1",
        evidence_id: "evidence-1",
        document_id: "document-1",
        filename: "2025-W2-ACME.pdf",
        doc_type: "W-2",
        issuer: "ACME Corporation",
        source_id: "source-1",
        source_label: "Gmail",
        source_type: "gmail",
      },
    ]);

    const feedInsert = calls.find(
      (call) => call.kind === "table" && call.table === "feed_messages" && call.action === "insert",
    );
    assert(feedInsert && feedInsert.kind === "table", "feed answer was not persisted");
    const persisted = JSON.stringify(feedInsert.payload);
    assertStringIncludes(persisted, "evidence-1");
    assertStringIncludes(persisted, "document-1");
    assertStringIncludes(persisted, "2025-W2-ACME.pdf");
  },
);

Deno.test(
  "[BEHAVIORAL] rejected chat-provider requests fail closed with a safe classification, never provider body text",
  async () => {
    const secretCanary = "provider-body-must-not-leak";
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: secretCanary } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const body = await res.json();
    assertEquals(res.status, 502);
    assertEquals(body.error, "chat_failed");
    assertEquals(body.chat_failure, "provider_rejected_request");
    assert(!JSON.stringify(body).includes(secretCanary));
  },
);

Deno.test(
  "[BEHAVIORAL] provider metadata on a valid chat tool input is ignored and never reaches the answer",
  async () => {
    const secretCanary = "model-output-must-not-leak";
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: () =>
        Promise.resolve(
          modelResponse({
            extraInput: { unexpected_model_field: secretCanary },
          }),
        ),
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.status, "answerable");
    assertEquals(body.citation_ids, ["C1"]);
    assert(!JSON.stringify(body).includes(secretCanary));
  },
);

Deno.test(
  "[BEHAVIORAL] provider casing drift for a declared answer status is canonicalized before grounding validation",
  async () => {
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: () => Promise.resolve(modelResponse({ status: "ANSWERABLE" })),
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.status, "answerable");
    assertEquals(body.citation_ids, ["C1"]);
  },
);

Deno.test(
  "[BEHAVIORAL] a provider tool input that omits a declared status defaults to answerable when grounded",
  async () => {
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        type: "function",
                        function: {
                          name: "answer_from_evidence",
                          arguments: JSON.stringify({
                            answer: "Your persisted W-2 reports wages of $123,456.78. [C1]",
                            citation_ids: ["C1"],
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.status, "answerable");
    assertEquals(body.citation_ids, ["C1"]);
  },
);

Deno.test(
  "[BEHAVIORAL] a non-enum provider status reaches grounding validation when declared citations exist",
  async () => {
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: () => Promise.resolve(modelResponse({ status: "supported" })),
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.status, "answerable");
    assertEquals(body.citation_ids, ["C1"]);
  },
);

Deno.test(
  "[BEHAVIORAL] a non-enum provider status without citations is forced onto the fail-closed path",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: () =>
        Promise.resolve(
          modelResponse({
            status: "supported",
            answer: "The model claims an answer without evidence.",
            citationIds: [],
          }),
        ),
    });
    const body = await res.json();
    assertEquals(res.status, 422);
    assertEquals(body.error, "insufficient_context");
    assertEquals(body.answer, undefined);
    assertEquals(feedInsertCount(calls), 0);
  },
);

Deno.test(
  "[BEHAVIORAL] insufficient_context and out_of_scope fail closed as non-answers without history",
  async () => {
    for (const status of ["insufficient_context", "out_of_scope"] as const) {
      const { client, calls } = createFakeClient({
        table: tableResolvers({ data: [linkedFact()], error: null }),
      });
      const res = await handler(
        req({
          filing_unit_id: "fu-1",
          question:
            status === "out_of_scope"
              ? "Can you write my landlord a legal threat letter?"
              : "Did I receive a 1099-NEC?",
        }),
        {
          supabase: client,
          fetch: () =>
            Promise.resolve(
              modelResponse({
                status,
                answer:
                  status === "out_of_scope"
                    ? "That is outside what I can answer from your tax records."
                    : "I do not have enough grounded tax evidence to answer.",
                citationIds: [],
              }),
            ),
        },
      );

      const body = await res.json();
      assertEquals(res.status, 422, status);
      assertEquals(body.error, status, status);
      assertEquals(body.proof?.grounding_status, status, status);
      assertEquals(body.proof?.retrieval_count, 1, status);
      assertEquals(body.proof?.citation_count, 0, status);
      assertEquals(body.proof?.validated, true, status);
      assertEquals(body.grounding_status, status, status);
      assertEquals(body.citation_count, 0, status);
      assert(
        /^[0-9a-f]{64}$/.test(body.context_hash ?? ""),
        `${status} context_hash was not a sha256 hex digest`,
      );
      assert(!("answer" in body), `${status} returned answer text`);
      assert(!("citations" in body), `${status} returned citations`);
      assertEquals(feedInsertCount(calls), 0, status);
    }
  },
);

Deno.test(
  "[BEHAVIORAL] answerable status succeeds only with complete known bracket-marker grounding",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: () =>
          Promise.resolve(
            modelResponse({
              status: "answerable",
              answer: "Your persisted W-2 reports wages of $123,456.78. [C1]",
              citationIds: ["C1"],
            }),
          ),
      },
    );

    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.answer, "Your persisted W-2 reports wages of $123,456.78. [C1]");
    assertEquals(
      body.citations.map((citation: { id: string }) => citation.id),
      ["C1"],
    );
    assertEquals(feedInsertCount(calls), 1);
  },
);

Deno.test(
  "[BEHAVIORAL] unknown or empty model citations fail closed without returning an answer",
  async () => {
    for (const citationCase of ["unknown", "empty"] as const) {
      const { client, calls } = createFakeClient({
        table: tableResolvers({ data: [linkedFact()], error: null }),
      });
      const res = await handler(
        req({
          filing_unit_id: "fu-1",
          question: "What were my wages?",
        }),
        {
          supabase: client,
          fetch: () => Promise.resolve(modelResponse(citationCase)),
        },
      );

      const body = await res.json();
      assertEquals(res.status, 502, citationCase);
      assertEquals(body.error, "invalid_grounded_answer", citationCase);
      assert(!("answer" in body), `${citationCase} returned an ungrounded answer`);
      assertEquals(
        calls.filter(
          (call) =>
            call.kind === "table" && call.table === "feed_messages" && call.action === "insert",
        ).length,
        0,
        citationCase,
      );
    }
  },
);

Deno.test(
  "[BEHAVIORAL] answerable missing bracket marker fails closed without history",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: () =>
          Promise.resolve(
            modelResponse({
              status: "answerable",
              answer: "Your persisted W-2 reports wages of $123,456.78.",
              citationIds: ["C1"],
            }),
          ),
      },
    );

    const body = await res.json();
    assertEquals(res.status, 502);
    assertEquals(body.error, "invalid_grounded_answer");
    assert(!("answer" in body), "missing-marker response returned answer text");
    assertEquals(feedInsertCount(calls), 0);
  },
);

Deno.test(
  "[BEHAVIORAL] answerable unknown answer marker fails closed without history",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: () =>
          Promise.resolve(
            modelResponse({
              status: "answerable",
              answer: "Your persisted W-2 reports wages of $123,456.78. [C1] [C999]",
              citationIds: ["C1"],
            }),
          ),
      },
    );

    const body = await res.json();
    assertEquals(res.status, 502);
    assertEquals(body.error, "invalid_grounded_answer");
    assert(!("answer" in body), "unknown-marker response returned answer text");
    assertEquals(feedInsertCount(calls), 0);
  },
);

Deno.test(
  "[BEHAVIORAL] answerable returned citation id missing from answer fails closed without history",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({
        data: [linkedFact(), secondLinkedFact()],
        error: null,
      }),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What records do you have?",
      }),
      {
        supabase: client,
        fetch: () =>
          Promise.resolve(
            modelResponse({
              status: "answerable",
              answer: "Your persisted W-2 reports wages of $123,456.78. [C1]",
              citationIds: ["C1", "C2"],
            }),
          ),
      },
    );

    const body = await res.json();
    assertEquals(res.status, 502);
    assertEquals(body.error, "invalid_grounded_answer");
    assert(!("answer" in body), "returned-unmarked citation response returned answer text");
    assertEquals(feedInsertCount(calls), 0);
  },
);

Deno.test(
  "[BEHAVIORAL] answerable uncited non-empty sentence fails closed without history",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: () =>
          Promise.resolve(
            modelResponse({
              status: "answerable",
              answer:
                "Your persisted W-2 reports wages of $123,456.78 [C1]. This looks ready for review.",
              citationIds: ["C1"],
            }),
          ),
      },
    );

    const body = await res.json();
    assertEquals(res.status, 502);
    assertEquals(body.error, "invalid_grounded_answer");
    assert(!("answer" in body), "uncited-sentence response returned answer text");
    assertEquals(feedInsertCount(calls), 0);
  },
);

Deno.test(
  "[BEHAVIORAL] answerable uncited trailing fragment fails closed without history",
  async () => {
    const { client, calls } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: () =>
          Promise.resolve(
            modelResponse({
              status: "answerable",
              answer:
                "Your persisted W-2 reports wages of $123,456.78. [C1] This looks ready for review",
              citationIds: ["C1"],
            }),
          ),
      },
    );

    const body = await res.json();
    assertEquals(res.status, 502);
    assertEquals(body.error, "invalid_grounded_answer");
    assert(!("answer" in body), "trailing-fragment response returned answer text");
    assertEquals(feedInsertCount(calls), 0);
  },
);

Deno.test(
  "[BEHAVIORAL] resolved feed insert error is surfaced and never reported as persisted",
  async () => {
    const secret = "access_token=feed-secret";
    const { client } = createFakeClient({
      table: tableResolvers(
        { data: [linkedFact()], error: null },
        { data: null, error: { message: `insert failed ${secret}` } },
      ),
    });
    const res = await handler(
      req({
        filing_unit_id: "fu-1",
        question: "What were my wages?",
      }),
      {
        supabase: client,
        fetch: () => Promise.resolve(modelResponse()),
      },
    );

    const bodyText = await res.text();
    const body = JSON.parse(bodyText);
    assertEquals(res.status, 200);
    assertEquals(body.history_persisted, false);
    assertEquals(body.history_error, "answer_history_write_failed");
    assertEquals(body.citations?.[0]?.evidence_id, "evidence-1");
    assert(!bodyText.includes("feed-secret"), bodyText);
  },
);

// ---------------------------------------------------------------------------
// Estimate context tests (ask-taxahead conversational enhancement spec)
// ---------------------------------------------------------------------------

type InvokeFunction = (
  name: string,
  options: { body: Record<string, unknown>; headers: Record<string, string> },
) => Promise<{ data: unknown; error: unknown }>;

function estimateResponse(
  opts: {
    gross_income?: number;
    recommendations?: unknown[];
    missed_opportunities?: unknown[];
    citations?: unknown[];
  } = {},
) {
  return {
    status: "success",
    filing_unit_id: "fu-1",
    tax_year: 2025,
    filing_status: "single",
    gross_income: opts.gross_income ?? 123456.78,
    income_breakdown: [
      {
        category: "wages",
        amount: opts.gross_income ?? 123456.78,
        source_fact_ids: ["fact-1"],
      },
    ],
    standard_deduction: 14600,
    deduction_source: null,
    taxable_income: 108856.78,
    estimated_tax: 18362.45,
    effective_rate: 14.9,
    estimated_tax_after_credits: 17000,
    potential_deductions: { total: 0, items: [] },
    potential_credits: { total: 0, items: [] },
    citations: opts.citations ?? [],
    kb_review: null,
    missed_opportunities: opts.missed_opportunities ?? [],
    recommendations: opts.recommendations ?? [],
    generated_at: "2025-01-15T00:00:00.000Z",
  };
}

function modelResponseWithE(
  answer: string,
  citationIds: string[],
  estimateCitationIds: string[],
  status: string = "answerable",
): Response {
  return modelResponse({
    status,
    answer,
    citationIds,
    extraInput: { estimate_citation_ids: estimateCitationIds },
  });
}

function extractPrompt(
  modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }>,
): string {
  const modelBody = JSON.parse(String(modelCalls[0].init?.body));
  const prompt = JSON.stringify(modelBody.messages);
  return `${modelBody.system ?? ""}\n${prompt}`;
}

Deno.test(
  "[BEHAVIORAL] estimate context injected when invokeFunction returns success with gross_income > 0",
  async () => {
    const est = estimateResponse();
    let invokeCall:
      | {
          name: string;
          options: { body: Record<string, unknown>; headers: Record<string, string> };
        }
      | undefined;
    const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });

    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      invokeFunction: (
        name: string,
        options: { body: Record<string, unknown>; headers: Record<string, string> },
      ) => {
        invokeCall = { name, options };
        return Promise.resolve({ data: est, error: null });
      },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        modelCalls.push({ input, init });
        return Promise.resolve(modelResponse());
      },
    } as Parameters<typeof productionHandler>[1] & {
      invokeFunction: InvokeFunction;
    });

    assertEquals(res.status, 200);
    assert(invokeCall !== undefined, "invokeFunction should have been called");
    assertEquals(invokeCall!.name, "compute-federal-tax-estimate");
    assertEquals(invokeCall!.options.body, { filing_unit_id: "fu-1" });
    assert(
      typeof invokeCall!.options.headers.Authorization === "string" &&
        invokeCall!.options.headers.Authorization.length > 0,
      "auth header should be forwarded",
    );

    const modelInstructions = extractPrompt(modelCalls);
    assertStringIncludes(modelInstructions, "[E1]");
    assertStringIncludes(modelInstructions, "[E2]");
    assertStringIncludes(modelInstructions, "[E3]");
    assertStringIncludes(modelInstructions, "[E4]");
    assertStringIncludes(modelInstructions, "[E5]");

    const body = await res.json();
    assert(
      Array.isArray(body.estimate_citations),
      "response should include estimate_citations array",
    );
    assert(
      body.estimate_summary !== undefined && body.estimate_summary !== null,
      "response should include estimate_summary",
    );
    assertEquals(body.estimate_summary.estimated_tax, 18362.45);
    assertEquals(body.estimate_summary.taxable_income, 108856.78);
    assertEquals(body.estimate_summary.effective_rate, 14.9);
    assertEquals(body.estimate_summary.estimated_tax_after_credits, 17000);
  },
);

Deno.test(
  "[BEHAVIORAL] no invokeFunction in deps: estimate context is null and behavior is unchanged",
  async () => {
    const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });

    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        modelCalls.push({ input, init });
        return Promise.resolve(modelResponse());
      },
    });

    assertEquals(res.status, 200);
    const modelInstructions = extractPrompt(modelCalls);
    assert(
      !modelInstructions.includes("[E1]"),
      "no estimate context should appear in prompt when invokeFunction is absent",
    );

    const body = await res.json();
    assertEquals(
      body.estimate_citations,
      undefined,
      "estimate_citations should be absent when no estimate call",
    );
    assertEquals(
      body.estimate_summary,
      undefined,
      "estimate_summary should be absent when no estimate call",
    );
    // Existing behavior: answer is still grounded
    assertEquals(body.answer, "Your persisted W-2 reports wages of $123,456.78. [C1]");
    assertEquals(body.citation_ids, ["C1"]);
  },
);

Deno.test("[BEHAVIORAL] invokeFunction returns error: estimate context is null", async () => {
  const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const { client } = createFakeClient({
    table: tableResolvers({ data: [linkedFact()], error: null }),
  });

  const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
    supabase: client,
    invokeFunction: () => Promise.resolve({ data: null, error: "estimate_unavailable" }),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      modelCalls.push({ input, init });
      return Promise.resolve(modelResponse());
    },
  } as Parameters<typeof productionHandler>[1] & {
    invokeFunction: InvokeFunction;
  });

  assertEquals(res.status, 200);
  const modelInstructions = extractPrompt(modelCalls);
  assert(!modelInstructions.includes("[E1]"), "no estimate context when estimate returns error");
  const body = await res.json();
  assertEquals(body.estimate_citations, undefined);
  assertEquals(body.estimate_summary, undefined);
});

Deno.test(
  "[BEHAVIORAL] invokeFunction returns success with gross_income === 0: estimate context is null",
  async () => {
    const est = estimateResponse({ gross_income: 0 });
    let invokeCalled = false;
    const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });

    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      invokeFunction: () => {
        invokeCalled = true;
        return Promise.resolve({ data: est, error: null });
      },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        modelCalls.push({ input, init });
        return Promise.resolve(modelResponse());
      },
    } as Parameters<typeof productionHandler>[1] & {
      invokeFunction: InvokeFunction;
    });

    assert(invokeCalled, "invokeFunction should still be called");
    assertEquals(res.status, 200);
    const modelInstructions = extractPrompt(modelCalls);
    assert(!modelInstructions.includes("[E1]"), "no estimate context when gross_income is 0");
    const body = await res.json();
    assertEquals(body.estimate_citations, undefined);
    assertEquals(body.estimate_summary, undefined);
  },
);

Deno.test(
  "[BEHAVIORAL] invokeFunction throws: estimate context is null (graceful degradation)",
  async () => {
    const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });

    const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
      supabase: client,
      invokeFunction: () => Promise.reject(new Error("network error")),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        modelCalls.push({ input, init });
        return Promise.resolve(modelResponse());
      },
    } as Parameters<typeof productionHandler>[1] & {
      invokeFunction: InvokeFunction;
    });

    assertEquals(res.status, 200);
    const modelInstructions = extractPrompt(modelCalls);
    assert(!modelInstructions.includes("[E1]"), "no estimate context when invokeFunction throws");
    const body = await res.json();
    assertEquals(body.estimate_citations, undefined);
    assertEquals(body.estimate_summary, undefined);
  },
);

Deno.test(
  "[BEHAVIORAL] [E*] validation: known E-marker passes, unknown E-marker fails, missing E-marker in answer fails",
  async () => {
    const est = estimateResponse();

    const cases: Array<{
      label: string;
      estimateCitationIds: string[];
      answer: string;
      expectedStatus: number;
    }> = [
      {
        label: "known E-marker passes",
        estimateCitationIds: ["E1"],
        answer:
          "Your persisted W-2 reports wages of $123,456.78. [C1] Your estimated taxable income is $108,856.78. [E1]",
        expectedStatus: 200,
      },
      {
        label: "unknown E-marker fails",
        estimateCitationIds: ["E999"],
        answer:
          "Your persisted W-2 reports wages of $123,456.78. [C1] Your estimated refund is $5,000. [E999]",
        expectedStatus: 502,
      },
      {
        label: "missing E-marker in answer fails",
        estimateCitationIds: ["E1"],
        answer: "Your persisted W-2 reports wages of $123,456.78. [C1]",
        expectedStatus: 502,
      },
    ];
    for (const { label, estimateCitationIds, answer, expectedStatus } of cases) {
      const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
      const { client } = createFakeClient({
        table: tableResolvers({ data: [linkedFact()], error: null }),
      });

      const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
        supabase: client,
        invokeFunction: () => Promise.resolve({ data: est, error: null }),
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          modelCalls.push({ input, init });
          return Promise.resolve(modelResponseWithE(answer, ["C1"], estimateCitationIds));
        },
      } as Parameters<typeof productionHandler>[1] & {
        invokeFunction: InvokeFunction;
      });

      assertEquals(
        res.status,
        expectedStatus,
        `${label}: expected status ${expectedStatus} but got ${res.status}`,
      );
      if (expectedStatus === 502) {
        const body = await res.json();
        assertEquals(
          body.error,
          "invalid_grounded_answer",
          `${label}: expected invalid_grounded_answer`,
        );
      }
    }
  },
);

Deno.test("[BEHAVIORAL] estimate citation counts in proof metadata are correct", async () => {
  const est = estimateResponse();
  const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const { client } = createFakeClient({
    table: tableResolvers({ data: [linkedFact()], error: null }),
  });

  const res = await handler(req({ filing_unit_id: "fu-1", question: "What were my wages?" }), {
    supabase: client,
    invokeFunction: () => Promise.resolve({ data: est, error: null }),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      modelCalls.push({ input, init });
      return Promise.resolve(
        modelResponseWithE(
          "Your persisted W-2 reports wages of $123,456.78. [C1] Your estimated taxable income is $108,856.78. [E1]",
          ["C1"],
          ["E1"],
        ),
      );
    },
  } as Parameters<typeof productionHandler>[1] & {
    invokeFunction: InvokeFunction;
  });

  assertEquals(res.status, 200);
  const body = await res.json();
  // Base estimate entries: E1-E5 (taxable_income, estimated_tax, effective_rate, estimated_tax_after_credits, potential_deductions/credits) = 5
  assertEquals(
    body.proof.estimate_retrieval_count,
    5,
    "5 base estimate entries with no recommendations/missed_opportunities/citations",
  );
  assertEquals(body.proof.estimate_citation_count, 1, "model returned 1 estimate citation ID");
});

Deno.test(
  "[BEHAVIORAL] sequential E-numbering: recommendations and missed_opportunities appear as [E*] entries",
  async () => {
    const est = estimateResponse({
      recommendations: [
        {
          type: "ira_contribution",
          title: "IRA Contribution",
          description: "Consider contributing to a traditional IRA to reduce taxable income.",
          estimated_savings: 1000,
          kb_citations: ["KB-1"],
        },
        {
          type: "credit_opportunity",
          title: "Saver's Credit",
          description: "You may qualify for the Saver's Credit on retirement contributions.",
          estimated_savings: 500,
          kb_citations: ["KB-2"],
        },
      ],
      missed_opportunities: [
        {
          category: "deduction",
          description: "Missing documentation for charitable donations.",
          kb_chunk_id: "chunk-1",
        },
      ],
      citations: [
        {
          value_label: "Taxable Income",
          computed_value: 108856.78,
          source_type: "irs_bracket_table",
          source_ref: "2025-1040",
          rule_summary: "Taxable income after standard deduction",
        },
      ],
    });
    const modelCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const { client } = createFakeClient({
      table: tableResolvers({ data: [linkedFact()], error: null }),
    });

    const res = await handler(req({ filing_unit_id: "fu-1", question: "What was my wages?" }), {
      supabase: client,
      invokeFunction: () => Promise.resolve({ data: est, error: null }),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        modelCalls.push({ input, init });
        return Promise.resolve(
          modelResponseWithE(
            "Your persisted W-2 reports wages of $123,456.78. [C1] Your estimated taxable income is $108,856.78. [E1] Consider an IRA contribution. [E6]",
            ["C1"],
            ["E1", "E6"],
          ),
        );
      },
    } as Parameters<typeof productionHandler>[1] & {
      invokeFunction: InvokeFunction;
    });

    assertEquals(res.status, 200);
    const modelInstructions = extractPrompt(modelCalls);

    // Base entries: E1-E5
    assertStringIncludes(modelInstructions, "[E1]");
    assertStringIncludes(modelInstructions, "[E2]");
    assertStringIncludes(modelInstructions, "[E3]");
    assertStringIncludes(modelInstructions, "[E4]");
    assertStringIncludes(modelInstructions, "[E5]");

    // Recommendations: E6, E7
    assertStringIncludes(modelInstructions, "[E6]");
    assertStringIncludes(modelInstructions, "[E7]");

    // Missed opportunity: E8
    assertStringIncludes(modelInstructions, "[E8]");

    // Citation: E9 (Rule)
    assertStringIncludes(modelInstructions, "[E9]");

    const body = await res.json();
    // 5 base + 2 recommendations + 1 missed_opportunity + 1 citation = 9
    assertEquals(
      body.proof.estimate_retrieval_count,
      9,
      "9 total estimate entries: 5 base + 2 recommendations + 1 missed_opportunity + 1 citation",
    );
    assertEquals(body.proof.estimate_citation_count, 2, "model returned 2 estimate citation IDs");
  },
);
