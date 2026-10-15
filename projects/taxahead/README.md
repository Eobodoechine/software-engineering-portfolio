# TaxAhead — complete backend modules

[Demo](https://tanstack-start-ts.taxahead.workers.dev/) · [Browse the selected source](source/)

I worked with TaxAhead's founder to build a tax-readiness application. These complete backend modules and their local dependencies are shared with permission. The product remains in development, awaiting founder go-to-market; the application workspace requires sign-in.

## What is included

The [source/](source/) folder contains 16 files: the two complete Edge Function handlers, their shared modules, a fake-client test helper, and two test files. The shared modules cover ingestion, extraction and form coverage, filing requirements, embeddings and reranking, paid entitlements, logging/redaction, tracing, and client types. The application uses React, TypeScript, TanStack Start, and Supabase; this selection focuses on the backend.

The earlier standalone [kb-reranker.ts](kb-reranker.ts) excerpt also remains here. Start with the larger source selection below to see how the modules fit together.

## Read one question through the system

1. [ask-taxahead/index.ts](source/supabase/functions/ask-taxahead/index.ts) is the complete answer handler. Start at `handler`, then inspect `searchKB`, `parseToolInput`, and `validateGroundedAnswer`. It loads the filing unit's evidence, invokes retrieval and a model, validates returned citation identities, and records run outcomes.
2. [search-knowledge/index.ts](source/supabase/functions/search-knowledge/index.ts) shows the search endpoint: validate input, create an embedding, call hybrid search, rerank candidates, and return source metadata with citation keys. Jurisdiction, tax-year, effective-date, and confidence filters are passed to the search RPC.
3. [kb-reranker.ts](source/supabase/functions/_shared/kb-reranker.ts) handles the external ranking response and deterministic fallback. [kb-embeddings.ts](source/supabase/functions/_shared/kb-embeddings.ts) contains the embedding provider integration.
4. [document-ingest.ts](source/supabase/functions/_shared/document-ingest.ts) shows how connector-fetched bytes enter document storage. It relies on a database unique constraint for duplicate detection and distinguishes a completed duplicate from a row whose upload never finished.
5. Read the [answer-handler tests](source/supabase/functions/ask-taxahead/index.test.ts) and [ingestion tests](source/supabase/functions/_shared/document-ingest.test.ts) alongside those files. They use fictional data, fake clients, and injected provider responses.

## Engineering decisions to inspect

- Model output is parsed into an explicit result contract. Citation markers must match known evidence and returned citation IDs.
- Search results retain source and jurisdiction metadata through reranking.
- Duplicate-document handling distinguishes an actual PostgreSQL unique violation from other insert failures.
- Incomplete storage records return a specific failure rather than being mislabeled as successful duplicates.
- Trace and log helpers make failure paths observable while redacting sensitive values.

## Run the included tests

From the portfolio root, with Deno installed:

```sh
npm run test:taxahead
```

The recorded October 15, 2026 run passed **42 tests**: 33 answer-handler tests and 9 ingestion tests. Runtime network access is denied; Deno may first download public module dependencies. Missing tracing credentials produce an expected warning because this test setup has no tracing database. The tests cover these selected paths with fake clients and injected provider responses; they do not exercise the hosted application or prove the search endpoint against a real database.

## Publication scope

These are selected modules, not the private application's full schema, UI, or deployment. The source tests and this portfolio's verification are described in [VERIFICATION.md](../../VERIFICATION.md). Citation validation checks references and formatting; it does not by itself prove factual or tax accuracy. The product prepares evidence for review and does not file returns.
