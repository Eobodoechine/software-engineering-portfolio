# Nnamdi Obodoechine | Software engineering portfolio

I build integrated web products and tools for AI-assisted development. PropertyVision, the product behind demo.neoventurez.com, was my first production system. It is my fully integrated, published product available for people to use. PasturePact and TaxAhead are works in progress, awaiting their founders' go-to-market launches. I have permission to share their demos and public code samples.

I built PropertyVision and TaxAhead with less than $1,000 in spend, and built PasturePact in one month. These are my reported build figures, not monthly operating costs. More of the codebases is available on request.

**Start with [PropertyVision's live product](https://demo.neoventurez.com/) and [end-to-end walkthrough](projects/propertyvision/SYSTEM.md).**

## Projects and current status

| Project | Demo | Code | Status as inspected October 15, 2026 |
| --- | --- | --- | --- |
| **PropertyVision / NEO Venturez** | [Use the product](https://demo.neoventurez.com/) | [Selected sample](projects/propertyvision/) · [Existing public repository](https://github.com/Eobodoechine/PropertyVision1) | Live, fully integrated product; my first production system. The analysis page is available without sign-in. |
| **PasturePact** | [Open site](https://pasturepact.netlify.app/) · [Fictional listing demo](https://pasturepact.netlify.app/demo) | [Selected sample](projects/pasturepact/) | Work in progress, awaiting the founder's go-to-market launch. The deployed demo is in test mode and collects no real payment. |
| **TaxAhead** | [Open site](https://tanstack-start-ts.taxahead.workers.dev/) | [Selected sample](projects/taxahead/) | Work in progress, awaiting the founder's go-to-market launch. The existing application workspace requires sign-in. |

The lifecycle descriptions above are my account as the builder. This portfolio's checks cover public page access and the supplied code tests; they do not independently certify every live product workflow or valuation result.

The selected code below is public and can be read without access to the private founder repositories.

## Start with the code

- **[PropertyVision: address matching](projects/propertyvision/addressNormalizer.ts)** shows normalization and a heuristic for detecting repeated properties across source formats. [Context and limitations](projects/propertyvision/README.md).
- **[PropertyVision: usage budgets](projects/propertyvision/usage-budget.js)** shows estimated-cost reservations, usage limits, and refusal when accounting state is unavailable. [System walkthrough](projects/propertyvision/SYSTEM.md).
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

The test suite uses only fictional inputs, temporary usage ledgers, and mock service responses. It makes no live AI requests, connects to no production database, and performs no payment operation. Nineteen focused tests cover the supplied examples.

## Source and permissions

[provenance.json](provenance.json) records the source revisions, file hashes, and excerpt changes. Tests were added for this portfolio. PropertyVision's address sample is a snapshot of a modified working file, with example addresses in comments replaced by fictional addresses. Its usage-budget sample is an unchanged snapshot of an untracked source file. The original working copies were not changed.

PasturePact and TaxAhead samples are shared with founder permission for public portfolio review. Their full repositories and private history remain private. No additional open-source license is granted for those excerpts by this portfolio. The linked tools retain their own repository licenses.

