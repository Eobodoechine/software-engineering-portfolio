// supabase/functions/_shared/tracing.ts
//
// Shared, best-effort durable tracing helper for the Supabase Deno edge
// functions (spec.md AC-2). Every business workflow (bootstrap-filing-unit,
// create-upload, extract-document, compute-scores, get-tax-package,
// ask-taxahead) opens a run at handler entry, logs a workflow_event at each
// meaningfully distinct stage, and finishes the run — succeeded OR failed — at
// every return path, so a stuck/failed workflow is queryable afterward via
// workflow_runs/workflow_events (by request_id / correlation_id).
//
// DESIGN — best-effort by construction (AC-2):
//   * The helper builds its OWN service-role Supabase client internally (from
//     SUPABASE_SERVICE_ROLE_KEY, which every edge function has automatically),
//     INDEPENDENT of the caller's RLS-scoped business-logic client — so a trace
//     write succeeds even before entity ownership is established (e.g. a request
//     that fails auth before any filing_unit_id is known). Callers may inject a
//     client via `supabase` (used by the tests' fake-client architecture); the
//     6 real call sites omit it and get the internal service-role client.
//   * EVERY write here is wrapped in its own try/catch that swallows and
//     console.error()s on failure. A tracing failure must NEVER cause the
//     caller's actual business operation to fail (mirrors ask-taxahead's
//     existing "logging is best-effort" swallow). Even construction of the
//     internal client is inside the try, never at module load.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { RpcResult } from "./supabase-client-types.ts";

// The tracing surface is intentionally tiny and duck-typed so the fake client
// (and the real supabase-js client) satisfy it without importing supabase-js's
// full generated types. Every chain member is PromiseLike so both the real
// PostgrestFilterBuilder and the fake chain qualify.
type TraceCalls = PromiseLike<RpcResult> | Promise<RpcResult>;
type TracingClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => TraceCalls;
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => {
      select: (cols?: string) => { single: () => TraceCalls };
    };
    update: (row: Record<string, unknown>) => {
      eq: (col: string, value: unknown) => TraceCalls;
    };
  };
};

export interface StartRunOptions {
  supabase?: TracingClient;
  workflow_name: string;
  entity_type?: string;
  entity_id?: string;
  request_id?: string;
  correlation_id?: string;
}

export interface LogEventOptions {
  attempt?: number;
  status: "started" | "succeeded" | "failed";
  error_code?: string;
  error_detail?: string;
  latency_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface FinishOptions {
  error_code?: string;
  error_detail?: string;
  external_service?: string;
  metadata?: Record<string, unknown>;
}

export interface Run {
  request_id: string;
  correlation_id: string;
  runId: string | null;
  setEntity(entity_id: string): Promise<void>;
  logEvent(step: string, opts: LogEventOptions): Promise<void>;
  finish(status: "succeeded" | "failed", opts?: FinishOptions): Promise<void>;
}

function buildServiceRoleClient(): TracingClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("tracing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as TracingClient;
}

export async function startRun(opts: StartRunOptions): Promise<Run> {
  const request_id = opts.request_id ?? crypto.randomUUID();
  const correlation_id = opts.correlation_id ?? crypto.randomUUID();
  const startedAtMs = Date.now();

  // Resolve the write client. Construction is inside try so a missing
  // service-role key degrades to a no-op run rather than throwing at the caller.
  let client: TracingClient | null = null;
  let runId: string | null = null;
  try {
    client = opts.supabase ?? buildServiceRoleClient();
    const { data, error } = await client
      .from("workflow_runs")
      .insert({
        request_id,
        correlation_id,
        workflow_name: opts.workflow_name,
        entity_type: opts.entity_type ?? null,
        entity_id: opts.entity_id ?? null,
        status: "started",
        metadata: {},
      })
      .select("id")
      .single();
    if (!error && data) runId = (data as { id?: string }).id ?? null;
  } catch (e) {
    // Best-effort: a trace-write failure must never break the caller.
    console.error("[tracing] startRun failed (swallowed):", e);
    client = null;
  }

  // Set entity_id on the ALREADY-STARTED run once it becomes known (AC-3):
  // create-upload only learns the created document's id AFTER the row is
  // inserted, and extract-document sets it once the request body is parsed.
  // Best-effort like every other write here — a failure is swallowed and never
  // breaks the caller's business operation; a no-op when the run row was never
  // written (missing service-role key / a swallowed startRun insert).
  async function setEntity(entity_id: string): Promise<void> {
    if (!client || !runId) return;
    try {
      await client.from("workflow_runs").update({ entity_id }).eq("id", runId);
    } catch (e) {
      console.error("[tracing] setEntity failed (swallowed):", e);
    }
  }

  async function logEvent(step: string, evtOpts: LogEventOptions): Promise<void> {
    if (!client) return;
    try {
      await client.from("workflow_events").insert({
        workflow_run_id: runId,
        step,
        attempt: evtOpts.attempt ?? 1,
        status: evtOpts.status,
        error_code: evtOpts.error_code ?? null,
        error_detail: evtOpts.error_detail ?? null,
        latency_ms: evtOpts.latency_ms ?? null,
        metadata: evtOpts.metadata ?? {},
      });
    } catch (e) {
      console.error("[tracing] logEvent failed (swallowed):", e);
    }
  }

  async function finish(
    status: "succeeded" | "failed",
    finishOpts: FinishOptions = {},
  ): Promise<void> {
    if (!client || !runId) return;
    try {
      await client
        .from("workflow_runs")
        .update({
          status,
          ended_at: new Date().toISOString(),
          latency_ms: Date.now() - startedAtMs,
          error_code: finishOpts.error_code ?? null,
          error_detail: finishOpts.error_detail ?? null,
          external_service: finishOpts.external_service ?? null,
          metadata: finishOpts.metadata ?? {},
        })
        .eq("id", runId);
    } catch (e) {
      console.error("[tracing] finish failed (swallowed):", e);
    }
  }

  return { request_id, correlation_id, runId, setEntity, logEvent, finish };
}

// --- Structured logging helpers ---

function captureStack(skipFrames = 2): string {
  try {
    const err = new Error();
    const lines = (err.stack ?? "").split("\n");
    const relevant = lines.slice(skipFrames).find((l) => {
      const trimmed = l.trim();
      return trimmed && !trimmed.includes("tracing.ts");
    });
    return (relevant ?? lines[lines.length - 1] ?? "").trim();
  } catch {
    return "unable_to_capture_stack";
  }
}

export interface LogEntry {
  time: string;
  level: "error" | "warn" | "info";
  fn: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

export function logStructured(
  level: "error" | "warn" | "info",
  fn: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  try {
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      fn,
      message,
      stack: captureStack(3),
    };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (k in entry) continue;
        entry[k] = v;
      }
    }
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else console.log(line);
  } catch {
    console.error(`[${fn}] ${level}: ${message}`, extra ?? "");
  }
}

export type StartRunFn = typeof startRun;
