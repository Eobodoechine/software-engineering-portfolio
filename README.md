# Nnamdi Obodoechine | Software engineering portfolio

I build full-stack products and AI tools. **PropertyVision is my first production system and a published product people can use.** TaxAhead and PasturePact are founder projects in development, awaiting their go-to-market launches.

I built PropertyVision and TaxAhead with less than $1,000 in combined spend, and built PasturePact in one month. Those are my reported build figures, not monthly operating costs. I have founder permission to share the TaxAhead and PasturePact demos and selected source. More code is available on request.

## Projects and current source

| Project | Product status | Public code |
| --- | --- | --- |
| [PropertyVision](projects/propertyvision/) | Published NEO Venturez product; my first production system. | Full application included here under `projects/propertyvision/`: interface, APIs, queue, worker, AI research, valuation, and persistence. |
| [TaxAhead](projects/taxahead/) | Work in progress, awaiting founder go-to-market. | 16 files under `source/`: complete answer/search handlers, ingestion and shared modules, test support, and 2 test files. |
| [PasturePact](projects/pasturepact/) | Work in progress, awaiting founder go-to-market; public demo uses test mode. | 16 files under `source/`: checkout and payment-worker handlers, shared modules, 2 SQL migrations, and 3 test files. |

Start with PropertyVision's [code tour](projects/propertyvision/CODE_TOUR.md) to follow an entire application. The founder examples below expose complete backend modules and their tests. Each project's README gives a reading order and explains what is included.

## PropertyVision — full application

**[Full PropertyVision code in this repository](projects/propertyvision/) · [Live product](https://demo.neoventurez.com/) · [Read the code end to end](projects/propertyvision/CODE_TOUR.md)**

A property-analysis application that takes an address through AI-backed research, comparable-sales selection, and an estimated after-repair value. The complete application is included directly in [projects/propertyvision/](projects/propertyvision/): all 80 source files, 5 public assets, API routes, Redis queue, background worker, research engine, valuation logic, persistence, dependency lockfile, and application configuration. You can read the whole product without leaving this repository.

| Read this | What it shows |
| --- | --- |
| [Product interface](projects/propertyvision/src/app/page.tsx) | Address submission, asynchronous status, saved reports, and comparable-sales results. |
| [Analysis API](projects/propertyvision/src/app/api/analyze/route.ts) | The boundary between a user request, cached data, and queued work. |
| [Redis job queue](projects/propertyvision/src/server/utils/jobQueue.ts) | Stream consumption, concurrent jobs, retries, cancellation, and result persistence. |
| [Research orchestration](projects/propertyvision/src/server/comprehensive-comp-search-v10.ts) | How subject research, comparable searches, filtering, and valuation fit together. |
| [Vertex AI integration](projects/propertyvision/src/server/vertex-details.ts) | Provider requests, timeouts, parsing, caching, and reconciliation. |
| [Valuation engine](projects/propertyvision/src/server/arvCalculator.js) | The calculation behind the report and its supporting metadata. |

**Stack:** Next.js, React, TypeScript, Node.js, Redis, Vertex AI, and Google Maps. The full source is the same sanitized snapshot published in the standalone PropertyVision repository. [Import provenance](provenance.json) records the pinned revision and every copied file; the application's [source manifest](projects/propertyvision/SOURCE_MANIFEST.json) records the earlier publication changes. It is not a claim of an exact deployed revision.

To build the included application from the portfolio root:

```sh
cd projects/propertyvision
npm ci
PV_LOCAL_DEMO=true npm run build
```

See the [application README](projects/propertyvision/README.md#stack-and-build) for the web server, separate worker, Redis, and provider setup. The inherited build skips type/lint failures; a successful build does not establish a fresh AI analysis.

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

## Run the included checks

From this repository's root, with Node.js 22.18+ and npm installed:

```sh
npm ci
npm run check
```

With Deno installed, also run:

```sh
npm run test:taxahead
```

The recorded October 15, 2026 run passed **131 tests**: 19 original utility tests, 70 PasturePact backend tests, and 42 TaxAhead backend tests. `npm run check` checks the file list and source hashes, then runs the first 89 tests. The Deno command runs the remaining 42 with runtime network access denied; it may download public dependencies before execution. See [VERIFICATION.md](VERIFICATION.md) for the exact scope and expected tracing warning.

These tests use fictional data and controlled service boundaries. They do not prove a live purchase, database migration, or deployed AI workflow. PropertyVision has separate [build and local HTTP checks](projects/propertyvision/VERIFICATION.md).

## Publication scope

[provenance.json](provenance.json) records the full PropertyVision import and the founder examples with source revisions and file hashes. The founder examples preserve complete selected modules and their local imports; the private applications' full UI, schema, and deployment are not included. The earlier address, budget, reranking, and cart examples remain alongside the larger source selections. The standalone budget experiment is not connected to PropertyVision's request path.

No customer records, provider credentials, or private repository history are included. Founder excerpts are shared with permission for portfolio review; this repository does not grant an additional open-source license for them. More code is available on request.
