# Nnamdi Obodoechine | Software engineering portfolio

I build web applications and tools for AI-assisted development. PropertyVision was my first production system. I worked with the founders of PasturePact and TaxAhead, who have allowed me to share their demos and selected code samples.

## Projects and current status

| Project | Demo | Code | Status as inspected October 15, 2026 |
| --- | --- | --- | --- |
| **PropertyVision** | [Open demo](https://demo.neoventurez.com/) | [Selected sample](projects/propertyvision/) · [Existing public repository](https://github.com/Eobodoechine/PropertyVision1) | My first production system. The public property-analysis page is available without sign-in. A new full valuation was not run for this review. |
| **PasturePact** | [Open site](https://pasturepact.netlify.app/) · [Fictional listing demo](https://pasturepact.netlify.app/demo) | [Selected sample](projects/pasturepact/) | A deployed marketplace prototype in test mode. The homepage says no real payment is collected. |
| **TaxAhead** | [Open site](https://tanstack-start-ts.taxahead.workers.dev/) | [Selected sample](projects/taxahead/) | A deployed tax-readiness application. The public site is accessible; the application workspace requires sign-in. |

The selected code below is public and can be read without access to the private founder repositories.

## Start with the code

- **[PropertyVision: address matching](projects/propertyvision/addressNormalizer.ts)** shows normalization and a heuristic for detecting repeated properties across source formats. [Context and limitations](projects/propertyvision/README.md).
- **[TaxAhead: retrieval ranking](projects/taxahead/kb-reranker.ts)** shows an external AI service integration, response validation, and a deterministic fallback when the service fails. [Context and limitations](projects/taxahead/README.md).
- **[PasturePact: cart and retry state](projects/pasturepact/cart.ts)** shows separation of demo drafts from ordinary drafts and reuse of checkout command identifiers after a lost response. [Context and limitations](projects/pasturepact/README.md).
- **[Tests](tests/samples.test.mjs)** exercise these examples with fictional inputs, malformed provider responses, and corrupted browser state.

These excerpts show specific engineering decisions. They are not full application repositories or evidence that every deployed workflow is complete. The existing PropertyVision repository is a separate source archive; it is not asserted to match the current demo deployment.

## Public tools

| Tool | Repository | What to inspect |
| --- | --- | --- |
| Baton | [Eobodoechine/baton](https://github.com/Eobodoechine/baton) | AI coding-session handoffs, repository-state checks, and receiver acceptance. |
| Voice Gate | [Eobodoechine/voice-gate](https://github.com/Eobodoechine/voice-gate) | Configurable writing checks and hard versus advisory findings. |
| Distressed Homes Finder | [Eobodoechine/distressed-homes-finder](https://github.com/Eobodoechine/distressed-homes-finder) | Property discovery, source enrichment, and verification workflow. |
| Apartment Rental Scraper | [Eobodoechine/apartment-rental-scraper](https://github.com/Eobodoechine/apartment-rental-scraper) | Rental-search tooling and its repository documentation. |
| Resume Tailor | [Eobodoechine/resume-tailor](https://github.com/Eobodoechine/resume-tailor) | Resume-tailoring workflow and its repository files. |
| Loop Engineering | [Eobodoechine/loop-engineering](https://github.com/Eobodoechine/loop-engineering) | Agent workflow framework and independent verification checks. |

These six repositories were confirmed public. Their complete tool workflows were not rerun during this portfolio preparation.

## Run the selected examples

Use Node.js 22.18 or newer. There are no package dependencies to install.

```sh
npm run check
```

The test suite uses only fictional inputs and mock service responses. It makes no live AI requests, connects to no production database, and performs no payment operation. Twelve focused tests passed locally on Node.js 26.9.0.

## Source and permissions

[provenance.json](provenance.json) records the source revisions, file hashes, and excerpt changes. Tests were added for this portfolio. PropertyVision's address sample is a snapshot of a modified working file, with example addresses in comments replaced by fictional addresses. The original working copy was not changed.

PasturePact and TaxAhead samples are shared with founder permission for public portfolio review. Their full repositories and private history remain private. No additional open-source license is granted for those excerpts by this portfolio. The linked tools retain their own repository licenses.

