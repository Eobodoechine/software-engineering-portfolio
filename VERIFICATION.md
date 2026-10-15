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

The full PropertyVision repository has its own [verification notes](https://github.com/Eobodoechine/propertyvision/blob/main/VERIFICATION.md). The older standalone budget sample here is not connected to that application's requests.
