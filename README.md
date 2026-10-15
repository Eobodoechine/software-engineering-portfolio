# Nnamdi Obodoechine | Software engineering portfolio

I build full-stack products and AI tools. **PropertyVision is my first production system and a published product people can use.** TaxAhead and PasturePact are founder projects in development, awaiting their go-to-market launches.

I built PropertyVision and TaxAhead with less than $1,000 in combined spend, and built PasturePact in one month. Those are my reported build figures, not monthly operating costs. I have founder permission to share the TaxAhead and PasturePact demos and selected source. More code is available on request.

## PropertyVision — full application

**[Full PropertyVision repository](https://github.com/Eobodoechine/propertyvision) · [Live product](https://demo.neoventurez.com/) · [Read the code end to end](https://github.com/Eobodoechine/propertyvision/blob/main/CODE_TOUR.md)**

A property-analysis application that takes an address through AI-backed research, comparable-sales selection, and an estimated after-repair value. The repository includes the interface, API, queue, worker, research engine, valuation logic, persistence, and configuration.

| Read this | What it shows |
| --- | --- |
| [Product interface](https://github.com/Eobodoechine/propertyvision/blob/main/src/app/page.tsx) | Address submission, asynchronous status, saved reports, and comparable-sales results. |
| [Analysis API](https://github.com/Eobodoechine/propertyvision/blob/main/src/app/api/analyze/route.ts) | The boundary between a user request, cached data, and queued work. |
| [Redis job queue](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/utils/jobQueue.ts) | Stream consumption, concurrent jobs, retries, cancellation, and result persistence. |
| [Research orchestration](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/comprehensive-comp-search-v10.ts) | How subject research, comparable searches, filtering, and valuation fit together. |
| [Vertex AI integration](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/vertex-details.ts) | Provider requests, timeouts, parsing, caching, and reconciliation. |
| [Valuation engine](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/arvCalculator.js) | The calculation behind the report and its supporting metadata. |

**Stack:** Next.js, React, TypeScript, Node.js, Redis, Vertex AI, and Google Maps. The public repository is a sanitized working-source snapshot; its manifest records the publication changes. It is not a claim of an exact deployed revision.

## TaxAhead — grounded AI and document ingestion

**[Source and reading guide](projects/taxahead/) · [Demo](https://tanstack-start-ts.taxahead.workers.dev/)**

Tax-readiness software built with React, TypeScript, TanStack Start, and Supabase. The selected backend source shows how a question becomes an answer grounded in retrieved evidence, with explicit citation validation and provider-failure handling.

- [Complete answer handler](projects/taxahead/source/supabase/functions/ask-taxahead/index.ts): authenticated context, retrieval, model response validation, citation checks, and run tracing.
- [Complete search handler](projects/taxahead/source/supabase/functions/search-knowledge/index.ts): query embeddings, hybrid-search RPC, jurisdiction/year filters, reranking, and source metadata.
- [Document ingestion](projects/taxahead/source/supabase/functions/_shared/document-ingest.ts): database-enforced duplicate detection, storage upload, and recovery of incomplete records.
- [Handler tests](projects/taxahead/source/supabase/functions/ask-taxahead/index.test.ts) and [ingestion tests](projects/taxahead/source/supabase/functions/_shared/document-ingest.test.ts): fictional inputs and injected service boundaries.

**Status:** Work in progress, awaiting founder go-to-market. The application workspace requires sign-in.

## PasturePact — checkout, transactions, and payment orchestration

**[Source and reading guide](projects/pasturepact/) · [Demo](https://pasturepact.netlify.app/demo)**

A farm-direct marketplace built in one month. The selected backend source shows the difficult parts of checkout: binding accepted prices, preventing duplicate commands, coordinating background payment work, and handling uncertain provider outcomes.

- [Checkout API](projects/pasturepact/source/supabase/functions/create-checkout/index.ts) → [transaction and quote binding](projects/pasturepact/source/supabase/migrations/20260926000700_quote_checkout_binding.sql): request identity, database locks, version checks, accepted totals, and replayable results.
- [Payment worker](projects/pasturepact/source/supabase/functions/payment-worker/index.ts): leased jobs, stored provider configuration, operation admission, completion, and recovery.
- [Group-operation recovery](projects/pasturepact/source/supabase/functions/_shared/group-provider-operation.ts): provider identity checks and recovery after uncertain responses.
- [Signature verification](projects/pasturepact/source/supabase/functions/_shared/stripe-signature.ts) and [negative tests](projects/pasturepact/source/tests/stripe-signature.test.ts): tampered bodies, wrong keys, replay windows, and signing-key rotation.
- [Worker tests](projects/pasturepact/source/tests/payment-worker-stored-config.test.ts) and [recovery tests](projects/pasturepact/source/tests/group-provider-operation.test.ts) exercise actual modules with mocked database/provider I/O.

**Status:** Work in progress, awaiting founder go-to-market. The public demo is in test mode and collects no real payment.

## Public tools

| Tool | Source | Focus |
| --- | --- | --- |
| Baton | [Repository](https://github.com/Eobodoechine/baton) | AI coding-session handoffs, repository-state checks, and receiver acceptance. |
| Voice Gate | [Repository](https://github.com/Eobodoechine/voice-gate) | Configurable writing checks and hard versus advisory findings. |
| Distressed Homes Finder | [Repository](https://github.com/Eobodoechine/distressed-homes-finder) | Property discovery, enrichment, and verification. |
| Apartment Rental Scraper | [Repository](https://github.com/Eobodoechine/apartment-rental-scraper) | Rental-search tooling. |
| Resume Tailor | [Repository](https://github.com/Eobodoechine/resume-tailor) | Evidence-based resume preparation. |
| Loop Engineering | [Repository](https://github.com/Eobodoechine/loop-engineering) | Agent workflows and independent verification. |

## Run and inspect

See [VERIFICATION.md](VERIFICATION.md) for test commands, results, and their scope. [provenance.json](provenance.json) records exact source revisions and file hashes. New founder examples contain complete source modules with their local imports preserved; they are selected slices rather than complete deployable founder repositories. No customer records, provider credentials, or private repository history are included. Founder excerpts are shared for portfolio review; this repository does not grant an additional open-source license for them.
