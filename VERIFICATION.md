# Verification of the public examples

Prepared October 15, 2026. The tests below exercise the published files with fictional data and controlled service boundaries.

| Check | Result | What it establishes |
| --- | --- | --- |
| Original utility examples | 19 tests passed | Address matching, budget experiment, reranking, and browser cart state. |
| PasturePact backend examples | 70 tests passed across 3 files | Actual signature verifier, payment-worker configuration paths, and group-operation recovery with mocked database/provider I/O. |
| TaxAhead backend examples | 42 tests passed across 2 files | Actual answer-handler and document-ingestion paths with fake clients and injected model responses; runtime network denied. |
| Source provenance | File hashes checked | Published founder files match the selected source snapshots; earlier excerpt changes remain listed in the manifest. |

## Run locally

Node.js 22.18+ and npm are required. Deno is required for the TaxAhead source tests.

```sh
npm ci
npm run check
npm run test:taxahead
```

`npm run check` runs the file/hash checks, 19 original tests, and 70 PasturePact tests. `npm run test:taxahead` runs 42 TaxAhead tests. Deno may download public module dependencies before the test run; runtime network access is denied by the command. TaxAhead's tracing helper reports unavailable tracing credentials and swallows that failure during tests. That is expected here; no tracing database is configured.

The test suite includes rejected tampered signatures, invalid provider responses, denied configuration, failed upload recovery, and other negative paths. It does not run a purchase, call a paid model, migrate a database, or verify the deployed applications. SQL files are supplied for reading and depend on the private schema.

The complete PropertyVision application is included in [projects/propertyvision/](projects/propertyvision/), with its own [verification notes](projects/propertyvision/VERIFICATION.md). The older standalone budget sample here is not connected to that application's requests.

## Complete PropertyVision import

The portfolio includes all 102 tracked files from `Eobodoechine/propertyvision` at `9bc3852039e6a807f5e7513bf7ce239b02c1e81c`. The import preserves application code, assets, dependency manifests, configuration, code tour, and original verification notes. Only the application README was adapted for this repository. `provenance.json` records the source and imported SHA-256 hashes for every file. `npm run check` verifies those hashes as well as the founder excerpts.

The original local HTTP evidence remains evidence for the original publication. After the import, a clean `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` and `NEXT_TELEMETRY_DISABLED=1 PV_LOCAL_DEMO=true npm run build` completed from `projects/propertyvision/`. The nested build emitted a multiple-lockfiles workspace-root warning and the existing instrumentation/Redis warnings. It still skips lint/type failures under the inherited configuration; no new live analysis was run. No provider requests, deployment changes, database migrations, or real payments are part of this import.

After the import, `npm run check` passed the file/source-hash checks, 19 utility tests, and 70 PasturePact backend tests. The unchanged TaxAhead files retain the earlier 42-test result; those Deno tests were not rerun for this import.
