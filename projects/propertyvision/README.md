# PropertyVision — full application source

**[Full repository](https://github.com/Eobodoechine/propertyvision) · [Live product](https://demo.neoventurez.com/) · [Code tour](https://github.com/Eobodoechine/propertyvision/blob/main/CODE_TOUR.md)**

PropertyVision is my first production system and the published property-analysis product behind NEO Venturez. A user submits an address, follows a background analysis, and receives property facts, comparable sales, and an estimated after-repair value in a saved report.

## Read the full application

The dedicated repository contains the complete application source snapshot: all 80 files in `src/`, 5 public assets, dependencies, configuration, and publication documentation.

| Follow the request | Source |
| --- | --- |
| Submit an address and display results | [Next.js page](https://github.com/Eobodoechine/propertyvision/blob/main/src/app/page.tsx) · [progress hook](https://github.com/Eobodoechine/propertyvision/blob/main/src/hooks/useJobProgress.ts) |
| Validate the request and enqueue analysis | [Analysis API](https://github.com/Eobodoechine/propertyvision/blob/main/src/app/api/analyze/route.ts) |
| Process work outside the web request | [Redis queue](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/utils/jobQueue.ts) · [worker](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/worker.ts) |
| Research the property and select comparables | [V10 orchestration](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/comprehensive-comp-search-v10.ts) · [comparable search](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/step3-find-comparables.ts) |
| Call the model and calculate the estimate | [Vertex integration](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/vertex-details.ts) · [valuation engine](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/arvCalculator.js) |
| Persist reports and expose job status | [Redis cache](https://github.com/Eobodoechine/propertyvision/blob/main/src/server/utils/redisCache.ts) · [status route](https://github.com/Eobodoechine/propertyvision/blob/main/src/app/api/analyze/status/%5BjobId%5D/route.ts) |

**Stack:** Next.js 15, React 19, TypeScript, Node.js, Redis, Vertex AI, and Google Maps geocoding. See the full repository's [setup instructions](https://github.com/Eobodoechine/propertyvision#stack-and-build) and [verification notes](https://github.com/Eobodoechine/propertyvision/blob/main/VERIFICATION.md). Its build and local HTTP checks passed; the inherited lint/type checks are not clean, and a fresh AI analysis was not rerun for publication. The snapshot includes demo auth and older modules, and is not asserted to match the live deployment byte for byte.

## What remains in this portfolio folder

| File | Purpose |
| --- | --- |
| [addressNormalizer.ts](addressNormalizer.ts) | Focused address-normalization utility from the application. |
| [usage-budget.js](usage-budget.js) | Standalone reservation and usage-budget experiment; it is not connected to the application's request path. |
| [SYSTEM.md](SYSTEM.md) | Short orientation linking to the full system and code tour. |

These smaller examples retain their focused tests in [samples.test.mjs](../../tests/samples.test.mjs) and [usage-budget.test.mjs](../../tests/usage-budget.test.mjs). Run `npm test` from the portfolio root to run all 19 original utility tests across the three projects. Source origins and excerpt changes are recorded in [provenance.json](../../provenance.json).

The [earlier public repository](https://github.com/Eobodoechine/PropertyVision1) preserves earlier application history. The [full PropertyVision repository](https://github.com/Eobodoechine/propertyvision) is the current portfolio showcase.
