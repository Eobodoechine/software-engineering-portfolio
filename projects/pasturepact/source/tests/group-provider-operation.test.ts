import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeGroupOperation, prepareGroupOperation, runGroupRecovery, type GroupOperation } from "../supabase/functions/_shared/group-provider-operation.ts";
import { type StripeLane } from "../supabase/functions/_shared/provider-lane.ts";

// Only database I/O is replaced; handler, resolver and transport run unchanged.
const database = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("../supabase/functions/_shared/supabase.ts", () => ({ serviceClient: () => database }));

const id = "92000000-0000-0000-0000-000000000001";
const namespace = "92000000-0000-0000-0000-000000000002";
const lane: StripeLane = { target: "DEMO_TEST", configurationVersionId: id, credentialVersionId: namespace,
  credentialGeneration: 2, secretKey: "sk_test_fixture", publishableKey: "pk_test_unused", webhookSecret: "whsec_fixture",
  apiVersion: "2026-08-26.dahlia" };
const laneRow = { ...lane, operationId: id, connectedAccountId: "acct_fixture", namespaceId: namespace,
  endpointId: "we_fixture", secretName: "DEMO_STRIPE_SECRET_KEY_V2", signingSecretName: "STRIPE_CONNECT_WEBHOOK_SECRET" };
let operation: GroupOperation;
let events: string[];
let denied: string;
let attachmentState: string;
// Inject only RPC/fetch boundaries: database and provider calls are not authorized.
const rpc = vi.fn();
const fetcher = vi.fn<typeof fetch>();
function intent(status = "requires_payment_method", overrides: Record<string, unknown> = {}) {
  return { object: "payment_intent", id: "pi_fixture", amount: 1000, currency: "usd", livemode: false,
    created: Math.floor(Date.now() / 1000),
    capture_method: "manual", amount_received: 0, amount_capturable: 0, status, metadata: { pasture_pact_operation_id: id, pasture_pact_seller_order_id: id,
      pasture_pact_group_member_id: id, pasture_pact_account_id: "acct_fixture" }, ...overrides };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const run = (recovery = false) => executeGroupOperation({ rpc }, operation, "worker", lane, recovery, fetcher);
beforeEach(() => {
  operation = { id, seller_order_id: id, group_member_id: id, configuration_id: id, namespace_id: namespace,
    endpoint_id: "we_fixture", account_id: "acct_fixture", amount_cents: 1000, currency: "USD",
    idempotency_key: `pasturepact:group-operation:${id}`, execution_version: 1, state: "DISPATCHED", provider_id: null,
    first_dispatched_at: new Date(Date.now() - 10000).toISOString(), replay_deadline: new Date(Date.now() + 23 * 3600000).toISOString(), mode: "CREATE" };
  events = []; denied = ""; attachmentState = "ATTACHED";
  vi.stubGlobal("Deno", { env: { get: (name: string) => ({ PROVIDER_NAMESPACE_ID: namespace,
    PROVIDER_WEBHOOK_ENDPOINT_ID: "we_fixture", STRIPE_EXPECTED_LIVEMODE: "false",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_fixture", DEMO_STRIPE_SECRET_KEY_V2: "sk_test_fixture" })[name] } });
  rpc.mockReset(); fetcher.mockReset();
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    events.push(name === "assert_group_provider_transport_v1" ? `assert:${args.p_action}` : name);
    if (name === denied) return { data: null, error: { code: "42501" } };
    if (name === "assert_group_provider_transport_v1" || name === "resolve_group_provider_recovery_lane_v1") return { data: laneRow, error: null };
    if (name === "claim_group_provider_recovery_v1") return { data: [operation], error: null };
    if (name === "record_group_provider_uncertainty_v1") operation = { ...operation, state: "RECONCILE_REQUIRED", mode: "RECONCILE" };
    if (name === "record_group_provider_result_v1") operation = { ...operation, state: attachmentState, provider_id: "pi_fixture" };
    if (name === "record_group_provider_recovery_outcome_v1") operation = { ...operation, provider_id: "pi_fixture",
      state: args.p_status === "canceled" ? "CANCELLED" : ["processing", "succeeded"].includes(String(args.p_status)) ? "RECONCILE_REQUIRED" : "CANCEL_REQUIRED" };
    return { data: { ...operation }, error: null };
  });
  fetcher.mockImplementation(async (_url, init) => { events.push(`fetch:${init?.method}`); return response(intent()); });
});
afterEach(() => vi.unstubAllGlobals());

it("commits prepare and begin before assertion and real transport, never confirms payment", async () => {
  vi.stubGlobal("fetch", fetcher);
  expect(await prepareGroupOperation({ rpc }, { id, claim_version: 3 }, "worker", lane)).toMatchObject({ attached: true, confirmedPayment: false });
  expect(events).toEqual(["prepare_group_provider_operation_v1", "begin_group_provider_dispatch_v1", "assert:CREATE", "fetch:POST", "record_group_provider_result_v1"]);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.stripe.com/v1/payment_intents");
  expect(new Headers(init?.headers).get("stripe-account")).toBe("acct_fixture");
  expect(new URLSearchParams(String(init?.body)).get("metadata[pasture_pact_operation_id]")).toBe(id);
});

it("persists lost response as incomplete without credentials or another create", async () => {
  fetcher.mockRejectedValueOnce(new Error("sk_test_fixture whsec_fixture timeout"));
  const result = await run();
  expect(result).toMatchObject({ unresolved: true, reason: "discovery_incomplete", operationId: id });
  expect(JSON.stringify(result)).not.toMatch(/sk_test_|whsec_/);
  fetcher.mockResolvedValue(response({ object: "list", data: [], has_more: false }));
  expect(await run()).toMatchObject({ reason: "discovery_zero" });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
});

it("retries after observation crash but never recreates after durable attachment", async () => {
  denied = "record_group_provider_result_v1";
  await expect(run()).rejects.toThrow("record_group_provider_result_v1_failed");
  denied = ""; await run(); await run();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(["begin_group_provider_dispatch_v1", "assert_group_provider_transport_v1"])("stale lease or revoked credential at %s causes no fetch", async name => {
  denied = name; await expect(run()).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});

it("immediately compensates refused attachment and never cancels twice", async () => {
  attachmentState = "CANCEL_REQUIRED";
  fetcher.mockImplementation(async url => response(intent(String(url).endsWith("/cancel") ? "canceled" : "requires_payment_method")));
  expect(await run()).toMatchObject({ attached: false, compensated: true, browserConfirmationRequired: false, confirmedPayment: false });
  await run(true);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://api.stripe.com/v1/payment_intents", "https://api.stripe.com/v1/payment_intents/pi_fixture/cancel"
  ]);
});

it.each(["requires_capture", "requires_action", "processing", "succeeded", "canceled"])("never attaches CREATE response status %s", async status => {
  fetcher.mockImplementation(async url => response(intent(String(url).endsWith("/cancel") ? "canceled" : status)));
  await run();
  expect(rpc.mock.calls.some(([name]) => name === "record_group_provider_result_v1")).toBe(false);
  if (["processing", "succeeded"].includes(status)) expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([{ livemode: true }, { livemode: undefined }, { amount: 999 }, { currency: "eur" }, { capture_method: "automatic" },
  { metadata: {} }, { object: "charge" }, { id: "ch_fixture" }, { status: "unknown" }])("rejects full object mismatch %j before observation", async patch => {
  fetcher.mockResolvedValue(response(intent("requires_payment_method", patch)));
  expect(await run()).toMatchObject({ unresolved: true, reason: "invalid_provider_response", operationId: id });
  expect(rpc.mock.calls.filter(([name]) => name.startsWith("record_")).map(([name]) => name))
    .toEqual(["record_group_provider_uncertainty_v1"]);
});

it("known orphan retrieves, persists cancellation requirement, asserts cancel, then durably cancels", async () => {
  operation.provider_id = "pi_fixture";
  fetcher.mockImplementation(async (url, init) => { events.push(`fetch:${init?.method}`); return response(intent(String(url).endsWith("/cancel") ? "canceled" : "requires_capture")); });
  expect(await run(true)).toMatchObject({ compensated: true, confirmedPayment: false });
  expect(events).toEqual(["assert:READ", "fetch:GET", "record_group_provider_recovery_outcome_v1", "assert:CANCEL", "fetch:POST", "record_group_provider_recovery_outcome_v1"]);
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("idempotency-key")).toBe(`${operation.idempotency_key}:cancel`);
});

it("persists mismatched cancellation as uncertainty", async () => {
  operation.provider_id = "pi_fixture";
  fetcher.mockImplementation(async url => response(intent("requires_capture", String(url).endsWith("/cancel") ? { id: "pi_other" } : {})));
  expect(await run(true)).toMatchObject({ unresolved: true, reason: "invalid_provider_response" });
  expect(operation.state).toBe("RECONCILE_REQUIRED");
});

it("retired recovery uses recovery-only resolver and READ/CANCEL", async () => {
  operation.provider_id = "pi_fixture";
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async url => response(intent(String(url).endsWith("/cancel") ? "canceled" : "requires_payment_method")));
  expect((await runGroupRecovery({ rpc }, "worker")).results[0]).toMatchObject({ ok: true, result: { compensated: true } });
  expect(rpc.mock.calls.some(([name]) => name === "resolve_stripe_configuration_v1" || name === "begin_group_provider_dispatch_v1")).toBe(false);
});

it("revoked recovery credentials produce no fetch", async () => {
  denied = "resolve_group_provider_recovery_lane_v1"; vi.stubGlobal("fetch", fetcher);
  expect((await runGroupRecovery({ rpc }, "worker")).results[0]).toMatchObject({ ok: false, unresolved: true });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["zero", "multiple", "partial", "cap"])("unknown beyond horizon %s discovery never creates", async kind => {
  operation.replay_deadline = new Date(Date.now() - 1000).toISOString(); operation.mode = "RECONCILE"; operation.state = "RECONCILE_REQUIRED";
  let page = 0;
  fetcher.mockImplementation(async () => { page++;
    return response({ object: "list", data: kind === "zero" ? [] : kind === "partial" ? [] : kind === "multiple" ? [intent(), intent("requires_payment_method", { id: "pi_second" })] : [intent("requires_payment_method", { id: `pi_page${page}` })], has_more: ["cap", "partial"].includes(kind) });
  });
  const reason = { zero: "discovery_zero", multiple: "discovery_multiple", partial: "invalid_provider_response", cap: "discovery_incomplete" }[kind];
  expect(await run()).toMatchObject({ unresolved: true, reviewRequired: true, operationState: "RECONCILE_REQUIRED", reason });
  expect(rpc).toHaveBeenLastCalledWith("record_group_provider_uncertainty_v1", {
    p_operation_id: id, p_worker_id: "worker", p_execution_version: 1, p_reason: reason
  });
  expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(kind === "cap" ? 5 : 1);
});

it("discovery traverses all pages before validating and compensating singleton", async () => {
  let page = 0;
  fetcher.mockImplementation(async (url) => {
    if (String(url).endsWith("/cancel")) return response(intent("canceled"));
    page++; return response({ object: "list", has_more: page === 1, data: page === 1 ? [intent()] : [] });
  });
  expect(await run(true)).toMatchObject({ compensated: true });
  expect(String(fetcher.mock.calls[1]![0])).toContain("starting_after=pi_fixture");
  expect(String(fetcher.mock.calls[0]![0])).toContain("created%5Bgte%5D=");
  expect(events.filter(e => e === "assert:READ")).toHaveLength(2);
});

it.each([null, {}, { object: "list", data: [], has_more: "false" }])("persists invalid discovery %j before unresolved and never creates", async body => {
  fetcher.mockResolvedValue(response(body));
  expect(await run(true)).toMatchObject({ unresolved: true, reason: "invalid_provider_response" });
  expect(rpc).toHaveBeenLastCalledWith("record_group_provider_uncertainty_v1", {
    p_operation_id: id, p_worker_id: "worker", p_execution_version: 1, p_reason: "invalid_provider_response"
  });
  expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);

});

it("awaits uncertainty persistence before returning success", async () => {
  fetcher.mockResolvedValue(response(null));
  const original = rpc.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  rpc.mockImplementation(async (name, args) => {
    if (name === "record_group_provider_uncertainty_v1") await gate;
    return original(name, args);
  });
  let completed = false;
  const pending = run(true).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(rpc.mock.calls.some(([name]) => name === "record_group_provider_uncertainty_v1")).toBe(true));
  expect(completed).toBe(false);
  release();
  expect(await pending).toMatchObject({ unresolved: true, operationState: "RECONCILE_REQUIRED" });
});

it("failed persistence errors without leaking credentials", async () => {
  denied = "record_group_provider_uncertainty_v1";
  fetcher.mockRejectedValue(new Error("sk_test_fixture whsec_fixture"));
  await expect(run(true)).rejects.toThrow(/^record_group_provider_uncertainty_v1_failed$/);
  vi.stubGlobal("fetch", fetcher);
  const result = await runGroupRecovery({ rpc }, "worker");
  expect(result.results[0]).toMatchObject({ ok: false, unresolved: true });
  expect(JSON.stringify(result)).not.toMatch(/sk_test_|whsec_/);
});

it("abandoned execute and prepare skip endpoint lookup and transport", async () => {
  operation.state = "ABANDONED"; operation.mode = "ABANDONED";
  vi.stubGlobal("Deno", { env: { get: () => { throw new Error("endpoint_lookup_forbidden"); } } });
  expect(await run()).toMatchObject({ reviewRequired: true, browserConfirmationRequired: false, confirmedPayment: false });
  expect(rpc).not.toHaveBeenCalled();
  expect(await prepareGroupOperation({ rpc }, { id, claim_version: 1 }, "worker", lane)).toMatchObject({ reviewRequired: true });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(["prepare_group_provider_operation_v1"]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("abandoned recovery skips lane resolution and fetch after claim", async () => {
  operation.state = "ABANDONED"; operation.mode = "ABANDONED";
  vi.stubGlobal("fetch", fetcher);
  expect((await runGroupRecovery({ rpc }, "worker")).results[0]).toMatchObject({ ok: true,
    result: { reviewRequired: true, browserConfirmationRequired: false, confirmedPayment: false } });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(["claim_group_provider_recovery_v1"]);
  expect(fetcher).not.toHaveBeenCalled();
});

async function normalWorker(activeDenied = false, recoveryDenied = false, createJob = false) {
  const env = { SUPABASE_URL: "http://127.0.0.1:54321", PAYMENT_WORKER_SECRET: "worker-secret",
    PROVIDER_NAMESPACE_ID: namespace, PROVIDER_WEBHOOK_ENDPOINT_ID: "we_fixture",
    STRIPE_EXPECTED_LIVEMODE: "false", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_fixture",
    DEMO_STRIPE_SECRET_KEY_V2: "sk_test_fixture", PROVIDER_CONFIGURATION_VERSION_ID: id, PAYMENT_TARGET: "DEMO_TEST" };
  let handler!: (request: Request) => Promise<Response>;
  vi.stubGlobal("Deno", { env: { get: (name: keyof typeof env) => env[name] }, serve: (fn: typeof handler) => { handler = fn; } });
  vi.stubGlobal("fetch", fetcher);
  const original = rpc.getMockImplementation()!;
  database.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "resolve_stripe_configuration_v1") {
      events.push(name);
      return activeDenied ? { data: null, error: { code: "42501" } } : { data: laneRow, error: null };
    }
    if (name === "claim_group_provider_recovery_v1" && (createJob || recoveryDenied)) {
      events.push(name);
      return { data: createJob ? [] : null, error: recoveryDenied ? { code: "42501" } : null };
    }
    if (name === "claim_provider_outbox_jobs_v1") return { data: createJob ? [{ id, kind: "CREATE_PAYMENT", claim_version: 1,
      provider_configuration_version_id: id, experience_mode: "DEMO", payload: { seller_order_id: id, group_member_id: id, group_order_id: id } }] : [], error: null };
    if (["assert_provider_credential_v1", "assert_provider_job_lane_v1", "complete_outbox_job_v1"].includes(name)) return { data: true, error: null };
    return original(name, args);
  });
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { id, group_order_id: id }, error: null }) };
  database.from.mockReturnValue(query);
  vi.resetModules();
  const workerModule = "../supabase/functions/payment-worker/index.ts";
  await import(workerModule);
  return handler(new Request("http://localhost/payment-worker", { method: "POST", headers: { "x-worker-secret": "worker-secret" } }));
}

it("normal worker recovers retired orphan before failing active configuration resolution", async () => {
  operation.provider_id = "pi_fixture";
  fetcher.mockImplementation(async url => response(intent(String(url).endsWith("/cancel") ? "canceled" : "requires_payment_method")));
  const workerResponse = await normalWorker(true);
  expect(workerResponse.status).toBe(503);
  expect(await workerResponse.json()).toMatchObject({ error: "provider_mapping_unavailable", recovery: { claimed: 1,
    results: [{ ok: true, result: { compensated: true } }] } });
  expect(events.indexOf("record_group_provider_recovery_outcome_v1")).toBeLessThan(events.indexOf("resolve_stripe_configuration_v1"));
  expect(database.rpc).toHaveBeenCalledWith("claim_group_provider_recovery_v1", expect.objectContaining({ p_limit: 1 }));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(1);
});

it("normal worker reports recovery claim failure separately without hiding normal results", async () => {
  const workerResponse = await normalWorker(false, true);
  expect(workerResponse.status).toBe(503);
  expect(await workerResponse.json()).toMatchObject({ claimed: 0, results: [], recovery: { error: "group_recovery_unavailable" } });
});

it("normal worker CREATE refusal dispatches immediate cancellation before successful completion", async () => {
  attachmentState = "CANCEL_REQUIRED";
  fetcher.mockImplementation(async url => response(intent(String(url).endsWith("/cancel") ? "canceled" : "requires_payment_method")));
  const workerResponse = await normalWorker(false, false, true);
  expect(workerResponse.status).toBe(200);
  expect(await workerResponse.json()).toMatchObject({ recovery: { claimed: 0 }, results: [{ ok: true, result: { compensated: true, attached: false } }] });
  expect(operation.state).toBe("CANCELLED");
  await run(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
