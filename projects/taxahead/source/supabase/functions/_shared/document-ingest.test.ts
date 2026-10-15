// supabase/functions/_shared/document-ingest.test.ts
//
// [BEHAVIORAL] tests for spec.md AC-3f: `document-ingest.ts`'s
// `ingestDocumentBytes` -- dedupe-by-hash BEFORE any upload/insert, and (on a
// miss) the real ordering `create-upload/index.ts` itself uses: insert the
// `documents` row FIRST (to get its generated id), THEN build the storage path
// `{filing_unit_id}/{documentId}/{filename}` using that id, THEN upload bytes,
// THEN update the row's storage_path. `./document-ingest.ts` does not exist yet
// -- this file's import is expected to fail with a "module not found" style
// error until the Coder delivers it.
//
// NOTE: this file also exercises `createFakeClient`'s storage `.upload()`
// wrapper, added directly to `./test-support/fake-client.ts` for this build (it
// only had `.download()`/`.createSignedUploadUrl()`/`.remove()` before --
// document-ingest.ts is the first caller in this repo to need a direct
// server-side byte upload rather than the browser signed-URL flow). The
// addition is purely additive (reuses the exact same generic `call()` dispatch
// every other storage method already used) and does not change any existing
// method's behavior -- flagged here and in the final report per this role's
// "no silent infra changes" discipline.
//
// [ROUND 4/5/8 FIX, D.10, gmail-connector-spec-v14.md]: the dedupe design is
// REWRITTEN, collapsed to one insert-optimistic-with-catch code path --
// confirmed directly against the current (pre-Gmail) `document-ingest.ts`:
// there is a PRE-EMPTIVE `SELECT` before any `INSERT`. D.10's corrected
// design removes that pre-emptive `SELECT` entirely and attempts the
// `INSERT` FIRST:
//   1. INSERT directly (status 'pending', storage_path null).
//   2. On success: upload bytes, then update storage_path (unchanged from
//      today).
//   3. On a unique-violation (SQLSTATE 23505 on the pre-existing partial
//      unique index on (filing_unit_id, dedupe_hash)): catch it, run exactly
//      ONE SELECT to resolve the existing row.
//      - storage_path non-null (genuinely complete duplicate): return
//        { documentId, duplicate: true }.
//      - storage_path IS null (orphaned from a prior failed upload, OR a
//        genuinely-concurrent still-in-flight winner): retry the upload +
//        storage_path update against that SAME row id. Success ->
//        { documentId, duplicate: false }. Failure -> a sanitized
//        `document_ingest_incomplete` condition (D.6), never a bare
//        `duplicate: true`.
// This DIRECTLY CONTRADICTS the previously-passing "dedupe-hit... makes no
// insert calls" test below (which asserted ZERO `documents:insert` calls on a
// hit -- the opposite of what this design requires, since a hit is now only
// detected BY attempting an insert first). Per D.10's Round 5 fix and
// gmail-connector-spec-v14.md Section F, that test is REWRITTEN here (not
// merely extended) -- this is the one Test-writer-authorized rewrite named
// explicitly by the dispatch brief. The other two pre-existing tests
// (dedupe-miss ordering, no-RPC-on-miss) are UNCHANGED below: under the new
// design a genuine dedupe-MISS still inserts directly (no pre-emptive select
// ever ran for a miss even under the OLD design), so their assertions remain
// valid as written.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createFakeClient, tableWriteCalls } from "./test-support/fake-client.ts";
import { ingestDocumentBytes } from "./document-ingest.ts";

const FILING_UNIT_ID = "fu-1";
const SOURCE_ID = "source-1";
const FILENAME = "invoice.pdf";
const MIME_TYPE = "application/pdf";
const DEDUPE_HASH = "sha256-abc123";
const BYTES = new TextEncoder().encode("fake-pdf-bytes");

function uniqueViolationError(constraint = "documents_filing_unit_dedupe_idx") {
  return {
    message: `duplicate key value violates unique constraint "${constraint}"`,
    code: "23505",
  };
}

// ---------------------------------------------------------------------------
// [REWRITTEN -- D.10, Round 5 fix] dedupe-hit under the insert-optimistic
// design: the INSERT is attempted FIRST and fails with a unique-violation;
// exactly one re-SELECT resolves the already-complete existing row.
// ---------------------------------------------------------------------------

Deno.test(
  "[BEHAVIORAL] ingestDocumentBytes dedupe-hit (insert-optimistic): insert unique-violation -> ONE re-select resolves a complete row -> duplicate:true, no upload, no second insert",
  async () => {
    const { client, calls } = createFakeClient({
      table: {
        "documents:insert": () => ({ data: null, error: uniqueViolationError() }),
        "documents:select": () => ({
          data: [{ id: "doc-existing", storage_path: "fu-1/doc-existing/invoice.pdf" }],
          error: null,
        }),
      },
    });

    const result = await ingestDocumentBytes(client, {
      filingUnitId: FILING_UNIT_ID,
      sourceId: SOURCE_ID,
      bytes: BYTES,
      filename: FILENAME,
      mimeType: MIME_TYPE,
      dedupeHash: DEDUPE_HASH,
    });

    assertEquals(result, { documentId: "doc-existing", duplicate: true });

    const inserts = tableWriteCalls(calls, "documents").filter((c) => c.action === "insert");
    assertEquals(
      inserts.length,
      1,
      "exactly one insert attempt (the initial optimistic one) -- no retry-insert on a complete-duplicate hit",
    );
    const selects = calls.filter(
      (c) => c.kind === "table" && c.table === "documents" && c.action === "select",
    );
    assertEquals(
      selects.length,
      1,
      "the design requires exactly ONE re-select to resolve the conflicting row",
    );
    const storageCalls = calls.filter((c) => c.kind === "storage");
    assertEquals(storageCalls.length, 0, "a genuinely complete duplicate must never re-upload");
    const updates = tableWriteCalls(calls, "documents").filter((c) => c.action === "update");
    assertEquals(
      updates.length,
      0,
      "a genuinely complete duplicate must never re-touch storage_path",
    );
  },
);

// [BEHAVIORAL] the initial insert attempt carries the SAME pending-row shape
// the old pre-emptive-select design used on a miss -- pinning down that the
// insert-optimistic rewrite didn't quietly drop any field.
Deno.test(
  "[BEHAVIORAL] ingestDocumentBytes's initial insert attempt is a real pending-row insert, not a dry-run",
  async () => {
    const { client, calls } = createFakeClient({
      table: {
        "documents:insert": (op) => ({
          data: [{ id: "doc-new", ...(op.payload as Record<string, unknown>) }],
          error: null,
        }),
        "documents:update": () => ({ data: [{ id: "doc-new" }], error: null }),
      },
      storage: {
        documents: (op) =>
          op === "upload"
            ? { data: { path: "uploaded" }, error: null }
            : (() => {
                throw new Error(`unexpected op ${op}`);
              })(),
      },
    });

    await ingestDocumentBytes(client, {
      filingUnitId: FILING_UNIT_ID,
      sourceId: SOURCE_ID,
      bytes: BYTES,
      filename: FILENAME,
      mimeType: MIME_TYPE,
      dedupeHash: DEDUPE_HASH,
    });

    const inserts = tableWriteCalls(calls, "documents").filter((c) => c.action === "insert");
    assertEquals(inserts.length, 1);
    const payload = inserts[0].payload as Record<string, unknown>;
    assertEquals(payload.filing_unit_id, FILING_UNIT_ID);
    assertEquals(payload.source_id, SOURCE_ID);
    assertEquals(payload.status, "pending");
    assertEquals(payload.dedupe_hash, DEDUPE_HASH);
    assert(
      !("storage_path" in payload) || payload.storage_path === null,
      "the initial insert must not set a storage_path yet",
    );
  },
);

// ---------------------------------------------------------------------------
// [UNCHANGED] dedupe-miss ordering and no-RPC-on-miss -- still valid: a
// genuine miss inserts, uploads, then updates storage_path, in that order,
// exactly as before (the old design's pre-emptive select never mattered for
// this scenario's own assertions, which never depended on a select call
// happening at all).
// ---------------------------------------------------------------------------

Deno.test(
  "ingestDocumentBytes dedupe-miss: inserts, uploads, then updates storage_path, in that exact order",
  async () => {
    const { client, calls } = createFakeClient({
      table: {
        "documents:select": () => ({ data: null, error: null }),
        "documents:insert": () => ({ data: [{ id: "doc-new" }], error: null }),
        "documents:update": () => ({ data: [{ id: "doc-new" }], error: null }),
      },
      storage: {
        documents: (op) => {
          if (op === "upload") return { data: { path: "uploaded" }, error: null };
          throw new Error(`unexpected storage op in this test: ${op}`);
        },
      },
    });

    const result = await ingestDocumentBytes(client, {
      filingUnitId: FILING_UNIT_ID,
      sourceId: SOURCE_ID,
      bytes: BYTES,
      filename: FILENAME,
      mimeType: MIME_TYPE,
      dedupeHash: DEDUPE_HASH,
    });

    assertEquals(result, { documentId: "doc-new", duplicate: false });

    const insertIdx = calls.findIndex(
      (c) => c.kind === "table" && c.table === "documents" && c.action === "insert",
    );
    const uploadIdx = calls.findIndex(
      (c) => c.kind === "storage" && c.bucket === "documents" && c.op === "upload",
    );
    const updateIdx = calls.findIndex(
      (c) => c.kind === "table" && c.table === "documents" && c.action === "update",
    );

    assert(insertIdx !== -1, "expected a documents insert call");
    assert(uploadIdx !== -1, "expected a storage upload call");
    assert(updateIdx !== -1, "expected a documents update call");
    assert(
      insertIdx < uploadIdx,
      `insert (idx ${insertIdx}) must happen before upload (idx ${uploadIdx})`,
    );
    assert(
      uploadIdx < updateIdx,
      `upload (idx ${uploadIdx}) must happen before the storage_path update (idx ${updateIdx})`,
    );

    const insertPayload = (calls[insertIdx] as { payload: unknown }).payload as Record<
      string,
      unknown
    >;
    assertEquals(insertPayload.filing_unit_id, FILING_UNIT_ID);
    assertEquals(insertPayload.source_id, SOURCE_ID);
    assertEquals(insertPayload.filename, FILENAME);
    assertEquals(insertPayload.mime_type, MIME_TYPE);
    assertEquals(insertPayload.status, "pending");
    assertEquals(insertPayload.dedupe_hash, DEDUPE_HASH);

    const expectedPath = `${FILING_UNIT_ID}/doc-new/${FILENAME}`;
    const uploadArgs = (calls[uploadIdx] as { args: unknown[] }).args;
    assertEquals(uploadArgs[0], expectedPath);
    assertEquals(uploadArgs[1], BYTES);
    assertEquals((uploadArgs[2] as { contentType?: string })?.contentType, MIME_TYPE);

    const updatePayload = (
      calls[updateIdx] as { payload: unknown; filters: Array<{ method: string; args: unknown[] }> }
    ).payload as Record<string, unknown>;
    assertEquals(updatePayload.storage_path, expectedPath);
    const updateCall = calls[updateIdx] as { filters: Array<{ method: string; args: unknown[] }> };
    assert(
      updateCall.filters.some(
        (f) => f.method === "eq" && f.args[0] === "id" && f.args[1] === "doc-new",
      ),
    );
  },
);

Deno.test(
  "ingestDocumentBytes dedupe-miss does not call any RPC (extract-document is not triggered from here)",
  async () => {
    const { client, calls } = createFakeClient({
      table: {
        "documents:select": () => ({ data: null, error: null }),
        "documents:insert": () => ({ data: [{ id: "doc-new" }], error: null }),
        "documents:update": () => ({ data: [{ id: "doc-new" }], error: null }),
      },
      storage: {
        documents: (op) => {
          if (op === "upload") return { data: { path: "uploaded" }, error: null };
          throw new Error(`unexpected storage op in this test: ${op}`);
        },
      },
    });

    await ingestDocumentBytes(client, {
      filingUnitId: FILING_UNIT_ID,
      sourceId: SOURCE_ID,
      bytes: BYTES,
      filename: FILENAME,
      mimeType: MIME_TYPE,
      dedupeHash: DEDUPE_HASH,
    });

    const rpcCallsMade = calls.filter((c) => c.kind === "rpc");
    assertEquals(rpcCallsMade.length, 0);
  },
);

// ---------------------------------------------------------------------------
// [NEW -- D.10 Round 4/9 fix, AC10] genuinely-racing callers on the same
// dedupe_hash: exactly one succeeds as a fresh insert, the other resolves via
// the catch-based re-select to the SAME row -- both branches of the "insert,
// catch a unique-violation" mechanism exercised together, through TWO real
// sequential calls to ingestDocumentBytes sharing an in-memory simulated row.
// ---------------------------------------------------------------------------

Deno.test(
  "[BEHAVIORAL] two genuinely racing callers on the same dedupe_hash: winner inserts fresh, loser resolves via the catch-based re-select to the SAME row, never duplicating storage/insert work",
  async () => {
    let insertAttempts = 0;
    const row = { id: "doc-race-1", storage_path: null as string | null };
    const { client, calls } = createFakeClient({
      table: {
        "documents:insert": () => {
          insertAttempts++;
          if (insertAttempts === 1) return { data: [{ id: row.id }], error: null };
          return { data: null, error: uniqueViolationError() };
        },
        "documents:select": () => ({
          data: [{ id: row.id, storage_path: row.storage_path }],
          error: null,
        }),
        "documents:update": (op) => {
          row.storage_path =
            ((op.payload as Record<string, unknown>).storage_path as string) ?? row.storage_path;
          return { data: [{ id: row.id }], error: null };
        },
      },
      storage: {
        documents: (op) =>
          op === "upload"
            ? { data: { path: "uploaded" }, error: null }
            : (() => {
                throw new Error(`unexpected op ${op}`);
              })(),
      },
    });

    const args = {
      filingUnitId: FILING_UNIT_ID,
      sourceId: SOURCE_ID,
      bytes: BYTES,
      filename: FILENAME,
      mimeType: MIME_TYPE,
      dedupeHash: DEDUPE_HASH,
    };

    // Winner: its insert succeeds outright.
    const winner = await ingestDocumentBytes(client, args);
    assertEquals(winner, { documentId: "doc-race-1", duplicate: false });

    // Loser: hits the unique-violation; by now the winner's storage_path is
    // already set, so the single re-select resolves a COMPLETE row.
    const loser = await ingestDocumentBytes(client, args);
    assertEquals(loser, { documentId: "doc-race-1", duplicate: true });

    assertEquals(
      insertAttempts,
      2,
      "both racing callers attempt the insert -- that IS the optimistic-insert design (D.10)",
    );
    const uploadCalls = calls.filter((c) => c.kind === "storage" && c.op === "upload");
    assertEquals(
      uploadCalls.length,
      1,
      "only the winner uploads bytes; the loser must not re-upload a complete row",
    );
  },
);

// ---------------------------------------------------------------------------
// [NEW -- D.10 Round 4 fix, AC10] plain SEQUENTIAL retry (no concurrency) on
// a row orphaned by an earlier failed upload -- storage_path is still null,
// so the retry must complete the upload against that SAME row id, not
// re-insert a second row and not return a bare duplicate:true for an
// incomplete row. This is the SAME code path the "still-in-flight racing
// winner" case (D.10 item 3's second sub-case) also resolves through.
// ---------------------------------------------------------------------------

Deno.test(
  "[BEHAVIORAL] ingestDocumentBytes sequential retry against an orphaned row (storage_path null): completes the upload against the SAME row id -> duplicate:false, no second insert",
  async () => {
    const { client, calls } = createFakeClient({
      table: {
        "documents:insert": () => ({ data: null, error: uniqueViolationError() }),
        "documents:select": () => ({
          data: [{ id: "doc-orphan-1", storage_path: null }],
          error: null,
        }),
        "documents:update": () => ({ data: [{ id: "doc-orphan-1" }], error: null }),
      },
      storage: {
        documents: (op) =>
          op === "upload"
            ? { data: { path: "uploaded" }, error: null }
            : (() => {
                throw new Error(`unexpected op ${op}`);
              })(),
      },
    });

    const result = await ingestDocumentBytes(client, {
      filingUnitId: FILING_UNIT_ID,
      sourceId: SOURCE_ID,
      bytes: BYTES,
      filename: FILENAME,
      mimeType: MIME_TYPE,
      dedupeHash: DEDUPE_HASH,
    });

    assertEquals(result, { documentId: "doc-orphan-1", duplicate: false });

    const inserts = tableWriteCalls(calls, "documents").filter((c) => c.action === "insert");
    assertEquals(
      inserts.length,
      1,
      "no second insert -- the retry targets the EXISTING orphaned row id",
    );
    const uploadCalls = calls.filter((c) => c.kind === "storage" && c.op === "upload");
    assertEquals(uploadCalls.length, 1);
    const uploadArgs = (uploadCalls[0] as { args: unknown[] }).args;
    assertEquals(
      uploadArgs[0],
      `${FILING_UNIT_ID}/doc-orphan-1/${FILENAME}`,
      "the retry uploads to the orphaned row's OWN id-derived path",
    );

    const updates = tableWriteCalls(calls, "documents").filter((c) => c.action === "update");
    assertEquals(updates.length, 1);
    const updateCall = updates[0] as {
      payload: unknown;
      filters: Array<{ method: string; args: unknown[] }>;
    };
    assertEquals(
      (updateCall.payload as Record<string, unknown>).storage_path,
      `${FILING_UNIT_ID}/doc-orphan-1/${FILENAME}`,
    );
    assert(
      updateCall.filters.some(
        (f) => f.method === "eq" && f.args[0] === "id" && f.args[1] === "doc-orphan-1",
      ),
    );
  },
);

// [BEHAVIORAL] if the orphan-retry's own upload ALSO fails, the function must
// surface a sanitized document_ingest_incomplete condition (D.6) -- never a
// bare duplicate:true for a row that still has no bytes.
Deno.test(
  "[BEHAVIORAL] ingestDocumentBytes orphan-retry whose upload ALSO fails raises document_ingest_incomplete, never a bare duplicate:true",
  async () => {
    const { client } = createFakeClient({
      table: {
        "documents:insert": () => ({ data: null, error: uniqueViolationError() }),
        "documents:select": () => ({
          data: [{ id: "doc-orphan-2", storage_path: null }],
          error: null,
        }),
      },
      storage: {
        documents: (op) => {
          if (op === "upload") return { data: null, error: { message: "storage_unavailable" } };
          throw new Error(`unexpected op ${op}`);
        },
      },
    });

    await assertRejects(
      () =>
        ingestDocumentBytes(client, {
          filingUnitId: FILING_UNIT_ID,
          sourceId: SOURCE_ID,
          bytes: BYTES,
          filename: FILENAME,
          mimeType: MIME_TYPE,
          dedupeHash: DEDUPE_HASH,
        }),
      Error,
      "document_ingest_incomplete",
    );
  },
);

// [BEHAVIORAL] the same failure-to-surface requirement when the upload itself
// succeeds but the FOLLOW-UP storage_path update fails -- the row is STILL
// incomplete (no persisted storage_path), so this must not be reported as a
// bare duplicate:true either.
Deno.test(
  "[BEHAVIORAL] ingestDocumentBytes orphan-retry whose storage_path UPDATE (after a successful upload) fails ALSO raises document_ingest_incomplete",
  async () => {
    const { client } = createFakeClient({
      table: {
        "documents:insert": () => ({ data: null, error: uniqueViolationError() }),
        "documents:select": () => ({
          data: [{ id: "doc-orphan-3", storage_path: null }],
          error: null,
        }),
        "documents:update": () => ({ data: null, error: { message: "row_locked" } }),
      },
      storage: {
        documents: (op) =>
          op === "upload"
            ? { data: { path: "uploaded" }, error: null }
            : (() => {
                throw new Error(`unexpected op ${op}`);
              })(),
      },
    });

    await assertRejects(
      () =>
        ingestDocumentBytes(client, {
          filingUnitId: FILING_UNIT_ID,
          sourceId: SOURCE_ID,
          bytes: BYTES,
          filename: FILENAME,
          mimeType: MIME_TYPE,
          dedupeHash: DEDUPE_HASH,
        }),
      Error,
      "document_ingest_incomplete",
    );
  },
);

// [BEHAVIORAL] a NON-unique-violation insert error (a genuine, unrelated DB
// failure) must propagate as a real error -- it must NOT be silently
// swallowed/misinterpreted as a dedupe hit just because SOME insert error
// occurred. Guards against an over-broad catch that treats any insert
// failure as "someone else already has this row."
Deno.test(
  "[BEHAVIORAL] ingestDocumentBytes attempts the INSERT as the FIRST step (no pre-emptive SELECT at all), and propagates a genuine (non-unique-violation) insert error, never mistaking it for a dedupe hit",
  async () => {
    const { client, calls } = createFakeClient({
      table: {
        // a "documents:select" resolver IS configured (returning "nothing
        // exists yet") specifically so this test can positively distinguish
        // the two designs: the OLD pre-emptive-SELECT code would call this
        // FIRST regardless of the eventual insert outcome; D.10's corrected
        // design must never call it before attempting the insert at all.
        "documents:select": () => ({ data: null, error: null }),
        "documents:insert": () => ({ data: null, error: { message: "connection_reset" } }), // no `code: "23505"`
      },
    });

    await assertRejects(() =>
      ingestDocumentBytes(client, {
        filingUnitId: FILING_UNIT_ID,
        sourceId: SOURCE_ID,
        bytes: BYTES,
        filename: FILENAME,
        mimeType: MIME_TYPE,
        dedupeHash: DEDUPE_HASH,
      }),
    );

    const selects = calls.filter(
      (c) => c.kind === "table" && c.table === "documents" && c.action === "select",
    );
    assertEquals(
      selects.length,
      0,
      "the corrected design must never call the pre-emptive SELECT at all -- INSERT is always the FIRST step (D.10)",
    );
  },
);
