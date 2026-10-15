# Publication verification

Prepared October 15, 2026.

- A clean `npm ci --ignore-scripts --no-audit --no-fund` installed the locked dependencies.
- The first clean build exposed an undeclared `bottleneck` import. The publication package now declares `bottleneck@2.19.5` and `google-auth-library@9.15.1` directly, using versions already present in the original environment or dependency tree.
- `NEXT_TELEMETRY_DISABLED=1 PV_LOCAL_DEMO=true npm run build` then completed and generated the page and API route bundles.
- The built app served its local homepage with HTTP 200. A nonexistent route and the disabled debug endpoint returned HTTP 404. No analysis was submitted.
- The source manifest records hashes for the complete copied `src/` tree, public assets, and configuration. Example addresses and operator defaults were replaced for publication. The Dockerfile, environment example, and review documentation were prepared for this source package.

The independent review found that the inherited cache diagnostic route could expose cached addresses outside demo mode. This publication replaces that route with an unconditional 404. The manifest records the change; the original working source and live deployment were not altered.

## Limits of the check

The inherited Next.js configuration skips type and lint failures during builds. It also produces a warning for the older `instrumentationHook` option. A successful build therefore establishes compilation/bundling, not clean static analysis. The build reported unavailable local Redis connections; no Redis data or live provider calls were needed to finish it. The Dockerfile is provided but has not been built as an image during this review. Archived/legacy modules retain their original stale relative imports; the active Next.js application build completed.

A fresh AI analysis, distributed worker behavior, current provider costs, and valuation accuracy were not retested for this publication. The live product is linked separately from this source snapshot. The demo auth adapter and time-based progress indicator remain visible in the source. The standalone usage-reservation functions are not wired into the request path.

The earlier utility tests in the [portfolio repository](https://github.com/Eobodoechine/software-engineering-portfolio) are focused tests of those modules, not a complete PropertyVision acceptance suite.
