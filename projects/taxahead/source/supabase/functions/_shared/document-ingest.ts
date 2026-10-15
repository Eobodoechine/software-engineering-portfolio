// supabase/functions/_shared/document-ingest.ts
// Ingests server-fetched provider bytes into the same `documents` pipeline a
// browser upload uses (spec.md §4h). On a fresh row, mirrors
// create-upload/index.ts's real ordering: insert the `documents` row FIRST
// (status 'pending') to obtain its generated id, THEN build the storage path
// `{filing_unit_id}/{documentId}/{filename}` using that id, THEN upload bytes
// directly (no browser/signed-URL involved here), THEN record storage_path on
// the row. Never calls extract-document -- triggering extraction for
// sync-ingested documents is each adapter's own concern (out of scope here).
//
// Dedupe design (D.10, gmail-connector-spec-v14.md -- "insert-optimistic with
// catch", collapsed to ONE code path): there is no pre-emptive SELECT by
// (filing_unit_id, dedupe_hash) before inserting. The INSERT is attempted
// FIRST; the pre-existing partial unique index on (filing_unit_id,
// dedupe_hash) is the actual dedupe enforcement point, surfaced to us as a
// Postgres unique-violation (SQLSTATE 23505) on the insert. Only on that
// specific violation do we run exactly ONE re-SELECT to resolve the row that
// already holds this hash:
//   - storage_path non-null -> genuinely complete duplicate: return
//     duplicate:true, no upload, no re-touch of storage_path.
//   - storage_path IS null -> either a row orphaned by an earlier failed
//     upload, or a genuinely-concurrent still-in-flight winner: retry the
//     upload + storage_path update against that SAME row id (never a second
//     insert). If that retry also fails, raise a sanitized
//     `document_ingest_incomplete` condition (D.6) rather than a bare
//     duplicate:true for a row that still has no bytes.
// A non-unique-violation insert error is a genuine failure and must never be
// mistaken for a dedupe hit.

const STORAGE_BUCKET = "documents";
const MAX_FILENAME_LEN = 200;
const UNIQUE_VIOLATION = "23505";

// keep storage keys safe: strip path separators and control chars, matching
// create-upload/index.ts's own sanitizeFilename convention.
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/[/\\]/g, "_").replace(new RegExp("[\\x00-\\x1f]", "g"), "").trim();
  return (base || "upload").slice(0, MAX_FILENAME_LEN);
}

type SupabaseLike = import("./supabase-client-types.ts").SupabaseLike;

type IngestArgs = {
  filingUnitId: string;
  sourceId: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  dedupeHash: string; // caller (adapter) computes this, e.g. sha256 of bytes
};

// Uploads bytes to `storagePath` and records it on the `documentId` row.
// Raw (unsanitized) errors propagate to the caller -- callers on the
// orphan/race-retry path are responsible for wrapping a failure here into
// the sanitized `document_ingest_incomplete` condition; the fresh-insert
// path surfaces these as-is, exactly as it always has.
async function uploadAndRecordStoragePath(
  supabase: SupabaseLike,
  args: Pick<IngestArgs, "bytes" | "mimeType">,
  storagePath: string,
  documentId: string,
): Promise<void> {
  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, args.bytes, { contentType: args.mimeType });
  if (uploadErr) throw new Error(uploadErr.message ?? "document_upload_failed");

  const { error: pathErr } = await supabase
    .from("documents")
    .update({ storage_path: storagePath })
    .eq("id", documentId);
  if (pathErr) throw new Error(pathErr.message ?? "document_storage_path_update_failed");
}

export async function ingestDocumentBytes(
  supabase: SupabaseLike,
  args: IngestArgs,
): Promise<{ documentId: string; duplicate: boolean }> {
  const filename = sanitizeFilename(args.filename);

  // 1. Insert-optimistic: attempt the INSERT directly, as the FIRST step --
  // no pre-emptive SELECT. status 'pending', storage_path left unset.
  const { data: rawInserted, error: insertErr } = await supabase
    .from("documents")
    .insert({
      filing_unit_id: args.filingUnitId,
      source_id: args.sourceId,
      filename,
      mime_type: args.mimeType,
      status: "pending",
      dedupe_hash: args.dedupeHash,
    })
    .select("id")
    .single();
  const inserted = rawInserted as { id: string } | null;

  if (insertErr) {
    // A non-unique-violation insert error is a genuine failure -- never
    // mistake it for a dedupe hit.
    if (insertErr.code !== UNIQUE_VIOLATION) {
      throw new Error(insertErr.message ?? "document_insert_failed");
    }

    // 3. Unique-violation on (filing_unit_id, dedupe_hash): resolve the
    // existing row with exactly ONE re-select.
    const { data: rawExisting, error: selectErr } = await supabase
      .from("documents")
      .select("id, storage_path")
      .eq("filing_unit_id", args.filingUnitId)
      .eq("dedupe_hash", args.dedupeHash)
      .single();
    const existing = rawExisting as { id: string; storage_path: string | null } | null;
    if (selectErr || !existing) {
      throw new Error(selectErr?.message ?? "document_dedupe_resolve_failed");
    }

    if (existing.storage_path) {
      // Genuinely complete duplicate: no re-upload, no re-touch of storage_path.
      return { documentId: existing.id, duplicate: true };
    }

    // Orphaned row (a prior failed upload) or a still-in-flight racing
    // winner: retry the upload + storage_path update against this SAME row
    // id -- never a second insert.
    const storagePath = `${args.filingUnitId}/${existing.id}/${filename}`;
    try {
      await uploadAndRecordStoragePath(supabase, args, storagePath, existing.id);
    } catch (_retryErr) {
      throw new Error("document_ingest_incomplete");
    }
    return { documentId: existing.id, duplicate: false };
  }

  if (!inserted) throw new Error("document_insert_failed");

  // 2. Fresh row: build the storage path using the new id -- NOT a random
  // UUID -- then upload bytes directly and record storage_path, exactly as
  // today.
  const storagePath = `${args.filingUnitId}/${inserted.id}/${filename}`;
  await uploadAndRecordStoragePath(supabase, args, storagePath, inserted.id);

  return { documentId: inserted.id, duplicate: false };
}
