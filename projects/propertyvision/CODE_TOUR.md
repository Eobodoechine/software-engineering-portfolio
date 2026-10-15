# Follow one PropertyVision analysis through the code

Start with the [live product](https://demo.neoventurez.com/), then follow these modules in order. These are complete application files.

1. **User interaction:** [src/app/page.tsx](src/app/page.tsx) owns the address input and result view. [useJobProgress.ts](src/hooks/useJobProgress.ts) polls the status endpoint, stops on terminal states, and exposes failures to the interface.
2. **Request handling:** [api/analyze/route.ts](src/app/api/analyze/route.ts) accepts the address, checks its input and the demo request allowance, checks the saved-result cache, and calls `enqueueJob` when work is needed. [status/[jobId]/route.ts](src/app/api/analyze/status/%5BjobId%5D/route.ts) returns the job state and result.
3. **Queue and worker:** [jobQueue.ts](src/server/utils/jobQueue.ts) contains `enqueueJob`, `processJobs`, `processJob`, and `handleJobFailure`. Read the Redis stream consumption, job-slot acquisition, retry delay, acknowledgment, and result-write paths together. [worker.ts](src/server/worker.ts) starts this processing separately from web requests and handles shutdown.
4. **Research orchestration:** [comprehensive-comp-search-v10.ts](src/server/comprehensive-comp-search-v10.ts) connects subject research, progressive searches, comparable selection, and the valuation calculator. [step3-find-comparables.ts](src/server/step3-find-comparables.ts) contains the grounded search, parsing, filtering, and verification work. [parallelSearchOrchestrator.ts](src/server/utils/parallelSearchOrchestrator.ts) shows how parallel searches are coordinated.
5. **Provider boundary:** [vertex-details.ts](src/server/vertex-details.ts) handles authenticated Vertex requests, subject-data caching, JSON parsing, and reconciliation. [vertex-limiter.ts](src/server/vertex-limiter.ts) controls request concurrency and pacing. [googleMapsGeocoder.ts](src/server/utils/googleMapsGeocoder.ts) supplies coordinates used for distance filtering.
6. **Valuation and presentation:** [arvCalculator.js](src/server/arvCalculator.js) calculates the estimate from selected comparables. Follow its output back through `processJob` to Redis and the page's result components. This is an estimate; the source does not establish independent valuation accuracy.

## Engineering tradeoffs I can discuss

- Moving long-running AI research out of the HTTP request into a separately running worker.
- Combining model-produced property data with explicit distance, age, size, and duplicate filters.
- Limiting provider concurrency and retrying failures without tying up the page request.
- Caching subject details and completed reports to avoid unnecessary repeat research.
- Making failure states inspectable while keeping the anonymous demo usable.

The implementation includes earlier modules and experiments. The reading order above identifies the active request flow in this snapshot. Publication-specific limits and validation are recorded once in [VERIFICATION.md](VERIFICATION.md).
