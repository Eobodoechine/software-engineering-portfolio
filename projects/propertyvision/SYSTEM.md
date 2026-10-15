# PropertyVision end to end

**[Full application source](src/) · [Code tour](CODE_TOUR.md) · [Setup](README.md#stack-and-build) · [Live product](https://demo.neoventurez.com/)**

The complete application is included directly in this portfolio under `projects/propertyvision/`. Start with [the page](src/app/page.tsx), follow its [analysis API](src/app/api/analyze/route.ts) into the [Redis queue](src/server/utils/jobQueue.ts) and [worker](src/server/worker.ts), then inspect the [research orchestration](src/server/comprehensive-comp-search-v10.ts), [provider integration](src/server/vertex-details.ts), [valuation engine](src/server/arvCalculator.js), and [stored results](src/server/utils/redisCache.ts).

PropertyVision is my first production system. The public demo allows viewing a saved report and submitting an address for analysis. The portfolio preparation observed a saved report; it did not rerun a paid valuation or independently assess valuation accuracy. [Verification notes](VERIFICATION.md) distinguish the source, local checks, and live product.
