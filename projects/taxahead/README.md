# TaxAhead — complete backend modules

[Demo](https://tanstack-start-ts.taxahead.workers.dev/) · [Browse the selected source](source/)

I worked with TaxAhead's founder to build a tax-readiness application. These complete backend modules and their local dependencies are shared with permission. The product remains in development, awaiting founder go-to-market; the application workspace requires sign-in.

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

These are selected modules, not the private application's full schema, UI, or deployment. The source tests and this portfolio's verification are described in [VERIFICATION.md](../../VERIFICATION.md). Citation validation checks references and formatting; it does not by itself prove factual or tax accuracy. The product prepares evidence for review and does not file returns.
