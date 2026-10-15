# TaxAhead

[Public site](https://tanstack-start-ts.taxahead.workers.dev/) · [Code sample](kb-reranker.ts)

I worked with TaxAhead's founder. The demo and selected source sample are shared with permission.

TaxAhead is a tax-readiness application built with React, TypeScript, TanStack Start, and Supabase. Its code includes document extraction, evidence organization, readiness scoring, and grounded question answering.

**Current status:** The deployed public site and sign-in page are available. The application workspace requires authentication. This review did not exercise authenticated document workflows or verify all integrations. The product prepares evidence for review; it does not file returns.

## Selected code

The sample reorders retrieved documents by relevance. It calls Cohere through an injected HTTP function, validates result counts and indices, and falls back to keyword-overlap scoring if the provider fails or responds with invalid data.

The provider error path logs a generic failure instead of the provider's response body. Source metadata travels with the ranked results. The fallback combines keyword overlap with the original retrieval score.

The tests use mock responses, explicitly disabled credentials, and fictional documents. They cover a valid response, duplicate indices, an out-of-range index, an HTTP failure, and deterministic fallback ordering.

This is the backend ranking module, not the full retrieval pipeline or an assessment of answer accuracy. Callers remain responsible for valid input and topK values. No live Cohere request was made in these tests.

