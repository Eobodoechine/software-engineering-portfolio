// TEST INFRASTRUCTURE ONLY -- not production code, not a re-implementation of
// any RPC/business logic. Per spec.md AC-7's fake-client-only test
// architecture ("a minimal hand-rolled fake Supabase client object ...
// implementing just the .from()/.select()/.update()/.insert()/.rpc() chains
// each function actually calls -- no real network, no Docker, no live
// Postgres"), this is a small in-memory stand-in for the pieces of the
// supabase-js / PostgREST query builder the edge functions under test
// actually exercise: .from(table).select()/.insert()/.update()/.delete()/
// .upsert(), .eq()/.neq()/.in()/.order()/.limit(), .single()/.maybeSingle(),
// plain-array resolution, .rpc(name, args), .storage.from(bucket).download()/
// .createSignedUploadUrl(), and .auth.getUser().

import type { SupabaseLike } from "../supabase-client-types.ts";
//
// Every response is scripted per test via the `resolvers` config passed to
// `createFakeClient`. Nothing here executes real SQL or talks to a real
// network -- this fakes the JS-boundary contract only, consistent with
// AC-7's disclosed residual gap (SQL-level RPC bodies are NOT exercised by
// this build's test plan; see research_fencing_tokens.md).
//
// Unconfigured calls throw loudly (rather than silently returning `null`) so
// a test that forgets to script a code path it actually exercises fails with
// a clear "no resolver configured" error instead of a confusing downstream
// null-reference -- this is deliberate: it keeps each test's fake surface
// truly minimal (only what that test's scenario needs) while still failing
// loudly on gaps.

export type TableAction = "select" | "insert" | "update" | "upsert" | "delete";
export type Terminal = "array" | "single" | "maybeSingle";
export type Filter = { method: string; args: unknown[] };

export type FakeResult<T = unknown> =
  { data: T; error: null } | { data: null; error: { message: string; code?: string } };

export type TableOp = {
  table: string;
  action: TableAction;
  payload?: unknown;
  filters: Filter[];
};

export type CallRecord =
  | ({ kind: "table" } & TableOp & { terminal: Terminal })
  | { kind: "rpc"; name: string; args: Record<string, unknown> | undefined }
  | { kind: "storage"; bucket: string; op: string; args: unknown[] }
  | { kind: "functions.invoke"; name: string; opts: { body: unknown } }
  | { kind: "auth.getUser" };

export type TableResolver = (op: TableOp) => FakeResult | Promise<FakeResult>;
export type RpcResolver = (
  args: Record<string, unknown> | undefined,
) => FakeResult | Promise<FakeResult>;
export type StorageResolver = (op: string, args: unknown[]) => FakeResult | Promise<FakeResult>;
export type FunctionsResolver = (
  name: string,
  opts: { body: unknown },
) => FakeResult | Promise<FakeResult>;

export interface FakeClientConfig {
  // keyed "<table>:<action>", e.g. "documents:update", "documents:select"
  table?: Partial<Record<string, TableResolver>>;
  // keyed by RPC function name, e.g. "claim_document_for_processing"
  rpc?: Partial<Record<string, RpcResolver>>;
  // keyed by storage bucket name, e.g. "documents"
  storage?: Partial<Record<string, StorageResolver>>;
  // keyed by edge-function name, e.g. "sources" (sync pipelines chain
  // .functions.invoke calls)
  functions?: Partial<Record<string, FunctionsResolver>>;
  auth?: {
    getUser?: () => Promise<{ data: { user: unknown }; error: unknown }>;
  };
}

interface Builder {
  eq(col: string, val: unknown): Builder;
  neq(col: string, val: unknown): Builder;
  is(col: string, val: unknown): Builder;
  gt(col: string, val: unknown): Builder;
  lt(col: string, val: unknown): Builder;
  in(col: string, vals: unknown[]): Builder;
  order(col: string, opts?: unknown): Builder;
  limit(n: number): Builder;
  select(cols?: string): Builder;
  single(): Promise<FakeResult>;
  maybeSingle(): Promise<FakeResult>;
  then(
    onFulfilled?: (v: FakeResult) => unknown,
    onRejected?: (e: unknown) => unknown,
  ): Promise<unknown>;
}

export function createFakeClient(config: FakeClientConfig) {
  const calls: CallRecord[] = [];

  function makeFromBuilder(table: string, action: TableAction, payload?: unknown): Builder {
    const filters: Filter[] = [];
    let resolvedP: Promise<FakeResult> | undefined;

    function baseResolve(): Promise<FakeResult> {
      if (!resolvedP) {
        const key = `${table}:${action}`;
        const resolver = config.table?.[key];
        if (!resolver) {
          throw new Error(
            `fake-client: no table resolver configured for "${key}" -- this test's scenario ` +
              `exercised a call it did not script. filters=${JSON.stringify(filters)}`,
          );
        }
        resolvedP = Promise.resolve(resolver({ table, action, payload, filters: [...filters] }));
        calls.push({
          kind: "table",
          table,
          action,
          payload,
          filters: [...filters],
          terminal: "array",
        });
      }
      return resolvedP;
    }

    const builder: Builder = {
      eq(col: string, val: unknown) {
        filters.push({ method: "eq", args: [col, val] });
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push({ method: "neq", args: [col, val] });
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push({ method: "is", args: [col, val] });
        return builder;
      },
      gt(col: string, val: unknown) {
        filters.push({ method: "gt", args: [col, val] });
        return builder;
      },
      // Added for the Gmail-connector slice's crash-reaper (D.15 addition #1,
      // gmail-connector-spec-v14.md): `startSyncJob`'s reap-stale-running-rows
      // step filters `started_at < now() - interval '15 minutes'`. Purely
      // additive -- mirrors `eq`/`neq` exactly, changes nothing about any
      // existing filter method.
      lt(col: string, val: unknown) {
        filters.push({ method: "lt", args: [col, val] });
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ method: "in", args: [col, vals] });
        return builder;
      },
      order(col: string, opts?: unknown) {
        filters.push({ method: "order", args: [col, opts] });
        return builder;
      },
      limit(n: number) {
        filters.push({ method: "limit", args: [n] });
        return builder;
      },
      select(cols?: string) {
        filters.push({ method: "select", args: [cols] });
        return builder;
      },
      single() {
        return baseResolve().then((r) => {
          if (r.error) return r;
          const rows = Array.isArray(r.data) ? r.data : r.data === null ? [] : [r.data];
          if (rows.length !== 1) {
            return {
              data: null,
              error: { message: "JSON object requested, multiple (or no) rows returned" },
            } as FakeResult;
          }
          return { data: rows[0], error: null } as FakeResult;
        });
      },
      maybeSingle() {
        return baseResolve().then((r) => {
          if (r.error) return r;
          const rows = Array.isArray(r.data) ? r.data : r.data === null ? [] : [r.data];
          if (rows.length === 0) return { data: null, error: null } as FakeResult;
          return { data: rows[0], error: null } as FakeResult;
        });
      },
      then(onFulfilled?: (v: FakeResult) => unknown, onRejected?: (e: unknown) => unknown) {
        return baseResolve().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select(cols?: string) {
          return makeFromBuilder(table, "select").select(cols);
        },
        insert(payload: unknown) {
          return makeFromBuilder(table, "insert", payload);
        },
        update(payload: unknown) {
          return makeFromBuilder(table, "update", payload);
        },
        upsert(payload: unknown, opts?: unknown) {
          return makeFromBuilder(table, "upsert", { payload, opts });
        },
        delete() {
          return makeFromBuilder(table, "delete");
        },
      };
    },
    rpc(name: string, args?: Record<string, unknown>) {
      calls.push({ kind: "rpc", name, args });
      const resolver = config.rpc?.[name];
      if (!resolver) {
        throw new Error(
          `fake-client: no rpc resolver configured for "${name}" -- this test's scenario called ` +
            `an RPC it did not script. args=${JSON.stringify(args)}`,
        );
      }
      return Promise.resolve(resolver(args));
    },
    storage: {
      from(bucket: string) {
        function call(op: string, args: unknown[]) {
          calls.push({ kind: "storage", bucket, op, args });
          const resolver = config.storage?.[bucket];
          if (!resolver) {
            throw new Error(`fake-client: no storage resolver configured for bucket "${bucket}"`);
          }
          return Promise.resolve(resolver(op, args));
        }
        return {
          download(path: string) {
            return call("download", [path]);
          },
          createSignedUploadUrl(path: string) {
            return call("createSignedUploadUrl", [path]);
          },
          // Added for connector-core-runtime's document-ingest.ts (spec.md §4h),
          // which does a direct server-side byte upload -- not the signed-URL flow
          // create-upload/index.ts uses for browser clients. Purely additive: reuses
          // the same generic `call()` dispatch every other storage method already
          // uses, so it changes nothing about the 3 pre-existing methods above.
          upload(path: string, body: unknown, opts?: unknown) {
            return call("upload", [path, body, opts]);
          },
          remove(paths: string[]) {
            return call("remove", [paths]);
          },
        };
      },
    },
    auth: {
      getUser() {
        calls.push({ kind: "auth.getUser" });
        if (!config.auth?.getUser) {
          throw new Error("fake-client: no auth.getUser resolver configured");
        }
        return config.auth.getUser();
      },
    },
    functions: {
      invoke(name: string, opts: { body: unknown }) {
        calls.push({ kind: "functions.invoke", name, opts });
        const resolver = config.functions?.[name];
        if (!resolver) {
          throw new Error(
            `fake-client: no functions resolver configured for "${name}" -- this test's ` +
              `scenario called an edge function it did not script.`,
          );
        }
        return Promise.resolve(resolver(name, opts));
      },
    },
  };

  return {
    client: client as unknown as SupabaseLike,
    calls,
  };
}

/** Convenience: all recorded table-level write calls (insert/update/upsert/delete), optionally filtered by table. */
export function tableWriteCalls(
  calls: CallRecord[],
  table?: string,
): Extract<CallRecord, { kind: "table" }>[] {
  return calls.filter(
    (c): c is Extract<CallRecord, { kind: "table" }> =>
      c.kind === "table" && c.action !== "select" && (table === undefined || c.table === table),
  );
}

/** Convenience: all recorded rpc calls, optionally filtered by name. */
export function rpcCalls(
  calls: CallRecord[],
  name?: string,
): Extract<CallRecord, { kind: "rpc" }>[] {
  return calls.filter(
    (c): c is Extract<CallRecord, { kind: "rpc" }> =>
      c.kind === "rpc" && (name === undefined || c.name === name),
  );
}
