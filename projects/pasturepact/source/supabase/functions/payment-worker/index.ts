import { json, requireMethod } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  cancelTestPaymentIntent,
  captureTestPaymentIntent,
  createTestPaymentIntent,
  refundTestPaymentIntent,
  retrieveBusinessTestPaymentIntent
} from "../_shared/stripe-api.ts";
import { prepareGroupOperation, runGroupRecovery } from "../_shared/group-provider-operation.ts";
import { pinnedStripeLane, stripeEndpoint, stripeLane, type StripeLane } from "../_shared/provider-lane.ts";
import { parseBusinessPaymentSubject, parseBusinessPreparation, parseBusinessDispatch, parseBusinessProviderObservation } from "../_shared/business-payment-contract.ts";
import { traceRecorder, type TraceLine } from "../_shared/trace.ts";

// Per-request, additive trace accumulator. It never decides a claim, a lease, a provider call or a
// verdict; it only records, with an exact source line, what the worker already decided to do.
type Recorder = ReturnType<typeof traceRecorder>;

function isLocalSupabase(): boolean {
  try {
    const host = new URL(Deno.env.get("SUPABASE_URL") ?? "").hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "kong" || host.startsWith("supabase_kong_");
  } catch {
    return false;
  }
}

function equalSecret(supplied: string | null, expected: string | undefined): boolean {
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(expected);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

type OutboxJob = Readonly<{
  id: string;
  dedupe_key: string;
  kind: "CREATE_PAYMENT" | "CAPTURE_PAYMENT" | "CANCEL_PAYMENT" | "REFUND_PAYMENT";
  payload: Record<string, unknown>;
  claim_version: number;
  subject_type?: string;
  subject_id?: string;
  experience_mode?: "DEMO" | "REAL" | null;
  provider_configuration_version_id?: string | null;
}>;

type SellerOrder = Readonly<{
  id: string;
  group_order_id: string | null;
  status: string;
  total_cents: number;
  platform_fee_cents: number;
  currency: string;
  stripe_connected_account_id: string;
  payment_provider: string;
}>;

type PaymentAttempt = Readonly<{
  id: string;
  group_member_id: string | null;
  provider_payment_id: string;
  connected_account_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  capture_before: string | null;
}>;

type GroupMember = Readonly<{
  id: string;
  group_order_id: string;
  assigned_amount_cents: number;
}>;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function uuidPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function safeError(error: unknown): string {
  // Accept an Error, a raw string (e.g. an RPC error's own message) or a PostgREST-style plain
  // object `{message}`; supabase-js returns the latter, which is not an Error instance.
  const message = error instanceof Error ? error.message
    : typeof error === "string" ? error
    : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "unknown_error";
  return message.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 100) || "unknown_error";
}

async function completeJob(client: ReturnType<typeof serviceClient>, job: OutboxJob, workerId: string, succeeded: boolean, rec: Recorder, error?: unknown) {
  rec.mark("complete_job", { jobId: job.id, kind: job.kind, succeeded, code: succeeded ? null : safeError(error) });
  const { error: completionError } = await rpcTrace(rec, "complete_outbox_job_v1", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_claim_version: job.claim_version,
    p_succeeded: succeeded,
    p_error_code: succeeded ? null : safeError(error)
  }, client);
  if (completionError) throw new Error(`outbox_completion_${completionError.code}`);
}

// One traced RPC boundary: records the call, its exact call site and any error code/message, then
// returns `{ data, error }` unchanged so every existing caller and check stays byte-for-byte identical.
async function rpcTrace(rec: Recorder, name: string, args: Record<string, unknown>, client: ReturnType<typeof serviceClient>) {
  const started = Date.now();
  const result = await client.rpc(name, args);
  const error = result.error as { code?: string; message?: string } | null;
  if (error) rec.fail("rpc_error", error, { name, ms: Date.now() - started, code: error.code ?? null });
  else rec.mark("rpc_ok", { name, ms: Date.now() - started });
  return result;
}

async function sellerOrder(client: ReturnType<typeof serviceClient>, id: string): Promise<SellerOrder> {
  const { data, error } = await client.from("seller_orders")
    .select("id,group_order_id,status,total_cents,platform_fee_cents,currency,stripe_connected_account_id,payment_provider")
    .eq("id", id).single();
  if (error || !data) throw new Error(`seller_order_read_${error?.code ?? "missing"}`);
  return data as SellerOrder;
}

async function acceptedGroupMember(
  client: ReturnType<typeof serviceClient>,
  groupMemberId: string,
  sellerOrderId: string
): Promise<GroupMember> {
  const { data, error } = await client.rpc("assert_group_payment_admission_v1", {
    p_group_member_id: groupMemberId,
    p_seller_order_id: sellerOrderId
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`group_payment_admission_${error?.code ?? "missing"}`);
  }
  const admission = data as Record<string, unknown>;
  if (admission.groupMemberId !== groupMemberId
      || typeof admission.groupOrderId !== "string"
      || typeof admission.assignedAmountCents !== "number"
      || !Number.isSafeInteger(admission.assignedAmountCents)
      || admission.assignedAmountCents < 0) {
    throw new Error("group_payment_admission_invalid");
  }
  return {
    id: groupMemberId,
    group_order_id: admission.groupOrderId,
    assigned_amount_cents: admission.assignedAmountCents
  };
}

async function processBusinessCreateJob(
  client: ReturnType<typeof serviceClient>, job: OutboxJob, workerId: string, lane: StripeLane, rec: Recorder
): Promise<Record<string, unknown>> {
  rec.mark("business_create", { jobId: job.id });
  const orderId = uuidPayload(job.payload, "business_order_id");
  const attemptId = uuidPayload(job.payload, "payment_attempt_id");
  const endpoint = stripeEndpoint({ webhookSecret: false });
  if (!orderId || !attemptId || job.subject_type !== "BUSINESS_ORDER" || job.subject_id !== orderId
      || Object.keys(job.payload).length !== 2 || lane.target !== "DEMO_TEST" || !endpoint
      || !lane.configurationVersionId || job.provider_configuration_version_id !== lane.configurationVersionId
      || job.experience_mode !== "DEMO") throw new Error("business_payment_subject_mismatch");
  const prepared = await client.rpc("prepare_business_provider_operation_v1", {
    p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version
  });
  if (prepared.error) throw new Error(`business_preparation_${prepared.error.code}`);
  const preparation = parseBusinessPreparation(prepared.data);
  const subject = preparation.subject;
  if (subject.businessOrderId !== orderId || subject.attemptId !== attemptId
      || subject.configurationId !== lane.configurationVersionId || subject.namespaceId !== endpoint.namespaceId
      || subject.endpointId !== endpoint.endpointId) throw new Error("business_payment_subject_mismatch");
  const execution = { p_operation_id: subject.operationId, p_worker_id: workerId,
    p_execution_version: preparation.executionVersion };
  const dispatched = await client.rpc("begin_business_provider_dispatch_v1", execution);
  if (dispatched.error) throw new Error(`business_dispatch_${dispatched.error.code}`);
  const dispatch = parseBusinessDispatch(dispatched.data);
  if (dispatch.mode === "STOP") {
    if (dispatch.state === "PREPARED" || dispatch.state === "DISPATCHED") throw new Error("business_payment_bridge_closed");
    return { state: dispatch.state, providerDispatched: false };
  }
  if (dispatch.executionVersion !== preparation.executionVersion
      || Object.keys(subject).some(key => subject[key as keyof typeof subject] !== dispatch.subject[key as keyof typeof subject])) {
    throw new Error("business_payment_subject_mismatch");
  }
  // Unknown I/O outcomes retain the committed DISPATCHED fence and stable replay key.
  const intent = await createTestPaymentIntent({
    secretKey: lane.secretKey, apiVersion: lane.apiVersion, connectedAccountId: subject.accountId,
    amountCents: subject.amountCents, currency: subject.currency, captureMethod: "manual",
    idempotencyKey: subject.idempotencyKey, subjectType: "BUSINESS_ORDER", businessSubject: subject
  });
  const observation = parseBusinessProviderObservation({ subject, providerId: intent.id,
    livemode: intent.livemode, status: intent.status }, subject);
  // 016 retains late observations even after admission or execution ownership is lost.
  const recorded = await client.rpc("record_business_provider_result_v1", { ...execution, p_observation: observation });
  if (recorded.error) throw new Error(`business_result_${recorded.error.code}`);
  if (!recorded.data || !["ATTACHED", "CANCEL_REQUIRED", "RECONCILE_REQUIRED"].includes(recorded.data.state)) {
    throw new Error("business_result_invalid");
  }
  return { state: recorded.data.state, providerDispatched: true };
}

async function processBusinessTerminalJob(
  client: ReturnType<typeof serviceClient>, job: OutboxJob, workerId: string, lane: StripeLane, rec: Recorder
): Promise<Record<string, unknown>> {
  rec.mark("business_terminal", { jobId: job.id, kind: job.kind });
  const orderId = uuidPayload(job.payload, "business_order_id");
  const attemptId = uuidPayload(job.payload, "payment_attempt_id");
  const operationId = uuidPayload(job.payload, "operation_id");
  const endpoint = stripeEndpoint({ webhookSecret: false });
  if (!orderId || !attemptId || !operationId || Object.keys(job.payload).length !== 3
      || job.subject_type !== "BUSINESS_ORDER" || job.subject_id !== orderId
      || job.experience_mode !== "DEMO" || lane.target !== "DEMO_TEST" || !endpoint
      || !lane.configurationVersionId || job.provider_configuration_version_id !== lane.configurationVersionId) {
    throw new Error("business_payment_subject_mismatch");
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(`${name}_${result.error.code}`);
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw new Error("business_result_invalid");
    return result.data;
  };
  const bound = (data: Record<string, unknown>) => {
    const subject = parseBusinessPaymentSubject(data.subject);
    if (subject.businessOrderId !== orderId || subject.attemptId !== attemptId || subject.operationId !== operationId
        || subject.configurationId !== lane.configurationVersionId || subject.namespaceId !== endpoint.namespaceId
        || subject.endpointId !== endpoint.endpointId || typeof data.providerId !== "string"
        || !/^pi_[A-Za-z0-9]+$/.test(data.providerId)) throw new Error("business_payment_subject_mismatch");
    return { secretKey: lane.secretKey, apiVersion: lane.apiVersion, endpointId: subject.endpointId,
      connectedAccountId: subject.accountId, paymentIntentId: data.providerId, businessSubject: subject,
      amountCents: subject.amountCents, currency: subject.currency, idempotencyKey: subject.idempotencyKey };
  };
  const same = (a: ReturnType<typeof bound>, b: ReturnType<typeof bound>) => a.paymentIntentId === b.paymentIntentId
    && Object.keys(a.businessSubject).every(key => a.businessSubject[key as keyof typeof a.businessSubject]
      === b.businessSubject[key as keyof typeof b.businessSubject]);
  const validVersion = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const stopped = (data: Record<string, unknown>) => {
    if (data.reason === "business_payment_bridge_closed") throw new Error("business_payment_bridge_closed");
    return { state: data.state ?? "STOP", providerDispatched: false };
  };
  if (job.kind === "CAPTURE_PAYMENT") {
    const prepared = await rpc("prepare_business_capture_v1", { p_operation_id: operationId, p_worker_id: workerId });
    if (prepared.mode === "STOP") return stopped(prepared);
    if (prepared.mode !== "PREPARED" || !uuidPayload(prepared, "captureId") || !validVersion(prepared.executionVersion)) {
      throw new Error("business_capture_preparation_invalid");
    }
    const execution = { p_capture_id: prepared.captureId, p_worker_id: workerId, p_execution_version: prepared.executionVersion };
    const dispatch = await rpc("begin_business_capture_dispatch_v1", execution);
    if (dispatch.mode === "STOP") return stopped(dispatch);
    const input = bound(dispatch);
    if (dispatch.mode !== "CAPTURE" || dispatch.captureId !== prepared.captureId
        || dispatch.executionVersion !== prepared.executionVersion || dispatch.amountCents !== input.amountCents
        || dispatch.applicationFeeCents !== 0 || dispatch.idempotencyKey !== `pasturepact:business-capture:${prepared.captureId}`) {
      throw new Error("business_capture_dispatch_invalid");
    }
    let observation;
    try {
      await captureTestPaymentIntent({ ...input, idempotencyKey: dispatch.idempotencyKey });
      // Capture does not validate metadata or amount_received; a bound GET does.
      observation = await retrieveBusinessTestPaymentIntent(input);
    } catch (error) {
      await rpc("record_business_capture_result_v1", { ...execution, p_observation: {
        source: "UNKNOWN", subject: input.businessSubject, providerId: input.paymentIntentId
      } });
      throw error;
    }
    const recorded = await rpc("record_business_capture_result_v1", { ...execution, p_observation: observation });
    return { ...recorded, providerDispatched: true };
  }
  const locator = await rpc("get_business_recovery_locator_v1", { p_operation_id: operationId });
  const input = bound(locator);
  if (locator.operationId !== operationId || !Number.isSafeInteger(locator.recoveryVersion) || locator.recoveryVersion < 0) {
    throw new Error("business_recovery_locator_invalid");
  }
  const prepared = await rpc("prepare_business_reconciliation_v1", {
    p_operation_id: operationId, p_worker_id: workerId, p_expected_version: locator.recoveryVersion
  });
  if (prepared.mode === "STOP") return stopped(prepared);
  if (prepared.mode !== "GET" || !validVersion(prepared.recoveryVersion) || !same(bound(prepared), input)) {
    throw new Error("business_recovery_changed");
  }
  const execution = { p_operation_id: operationId, p_worker_id: workerId, p_recovery_version: prepared.recoveryVersion };
  const observation = await retrieveBusinessTestPaymentIntent(input);
  const recorded = await rpc("record_business_reconciliation_v1", { ...execution, p_observation: observation });
  if (recorded.stale !== false || observation.amountReceived !== 0
      || !["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"].includes(observation.status)) {
    return { ...recorded, providerDispatched: false };
  }
  const dispatch = await rpc("begin_business_cancellation_v1", execution);
  if (dispatch.mode === "STOP") return stopped(dispatch);
  if (dispatch.mode === "GET") return { ...recorded, providerDispatched: false };
  if (dispatch.mode !== "CANCEL" || !same(bound(dispatch), input)
      || dispatch.idempotencyKey !== `pasturepact:business-cancel:${operationId}`) throw new Error("business_cancellation_changed");
  await cancelTestPaymentIntent({ ...input, idempotencyKey: dispatch.idempotencyKey });
  const canceled = await retrieveBusinessTestPaymentIntent(input);
  if (canceled.status !== "canceled" || canceled.amountReceived !== 0) throw new Error("business_cancellation_unverified");
  const result = await rpc("record_business_cancellation_v1", { ...execution,
    p_observation: { ...canceled, source: "CANCEL" } });
  return { ...result, providerDispatched: true };
}

async function processCreateJob(
  client: ReturnType<typeof serviceClient>,
  job: OutboxJob,
  secretKey: string,
  apiVersion: string,
  workerId: string,
  lane: StripeLane,
  rec: Recorder
): Promise<Record<string, unknown>> {
  if (job.subject_type === "BUSINESS_ORDER" || Object.hasOwn(job.payload, "business_order_id")) {
    return processBusinessCreateJob(client, job, workerId, lane, rec);
  }
  const sellerOrderId = uuidPayload(job.payload, "seller_order_id");
  const groupMemberId = uuidPayload(job.payload, "group_member_id");
  const payloadGroupOrderId = uuidPayload(job.payload, "group_order_id");
  if (!sellerOrderId) throw new Error("invalid_create_payment_payload");
  const order = await sellerOrder(client, sellerOrderId);
  if ((order.group_order_id !== null
      && (!groupMemberId || payloadGroupOrderId !== order.group_order_id))
      || (order.group_order_id === null && (groupMemberId || payloadGroupOrderId))) {
    throw new Error("group_payment_payload_mismatch");
  }
  if (groupMemberId) return prepareGroupOperation(client, job, workerId, lane);
  if (order.payment_provider !== "STRIPE" || order.status !== "PENDING_PAYMENT") {
    throw new Error("seller_order_not_ready_for_stripe");
  }
  const captureMethod = "automatic" as const;
  const amountCents = order.total_cents;
  const currency = order.currency;
  const intent = await createTestPaymentIntent({
    secretKey,
    apiVersion,
    connectedAccountId: order.stripe_connected_account_id,
    amountCents,
    currency,
    sellerOrderId: order.id,
    captureMethod,
    applicationFeeCents: order.platform_fee_cents,
    idempotencyKey: `pasturepact:create:${job.dedupe_key}`
  });
  const attach = await client.rpc("attach_payment_attempt_v2", {
      p_seller_order_id: order.id,
      p_provider: "STRIPE",
      p_provider_payment_id: intent.id,
      p_capture_before: null
    });
  if (attach.error) throw new Error(`payment_attachment_${attach.error.code}`);
  return { paymentIntentId: intent.id, providerStatus: intent.status, browserConfirmationRequired: true };
}

async function groupAttempts(client: ReturnType<typeof serviceClient>, groupOrderId: string): Promise<PaymentAttempt[]> {
  const { data: members, error: memberError } = await client.from("group_members")
    .select("id").eq("group_order_id", groupOrderId);
  if (memberError) throw new Error(`group_member_read_${memberError.code}`);
  const memberIds = (members ?? []).map((member) => member.id as string);
  if (memberIds.length === 0) throw new Error("group_has_no_members");
  const { data, error } = await client.from("payment_attempts")
    .select("id,group_member_id,provider_payment_id,connected_account_id,amount_cents,currency,status,capture_before")
    .in("group_member_id", memberIds).eq("provider", "STRIPE");
  if (error) throw new Error(`payment_attempt_read_${error.code}`);
  return (data ?? []) as PaymentAttempt[];
}

async function processCaptureJob(client: ReturnType<typeof serviceClient>, job: OutboxJob, secretKey: string, apiVersion: string, rec: Recorder) {
  const groupOrderId = uuidPayload(job.payload, "group_order_id");
  if (!groupOrderId) throw new Error("invalid_capture_payment_payload");
  rec.mark("capture_lease_begin", { groupOrderId, jobId: job.id });
  const lease = await rpcTrace(rec, "begin_group_payment_execution_v1", {
    p_group_order_id: groupOrderId,
    p_kind: "CAPTURE",
    p_execution_token: job.id,
    p_lease_seconds: 120
  }, client);
  // Keep the RPC's own reason in the job error (column pattern allows [a-z0-9_.-]), so a failed lease names
  // the guard that refused it instead of only the SQLSTATE.
  if (lease.error) { rec.fail("capture_lease_refused", lease.error, { groupOrderId, code: lease.error.code }); throw new Error(`capture_execution_${lease.error.code}_${safeError(lease.error.message)}`); }
  try {
    const attempts = await groupAttempts(client, groupOrderId);
    rec.mark("capture_attempts", { groupOrderId, statuses: attempts.map((attempt) => attempt.status) });
    if (attempts.length === 0 || attempts.some((attempt) => !["AUTHORIZED", "CAPTURED"].includes(attempt.status))) {
      throw new Error("group_not_fully_authorized");
    }
    if (attempts.some((attempt) => attempt.status === "AUTHORIZED" && !attempt.capture_before)) {
      throw new Error("provider_capture_deadline_unavailable");
    }
    if (attempts.some((attempt) => attempt.status === "AUTHORIZED"
        && Date.parse(String(attempt.capture_before)) <= Date.now() + 15 * 60 * 1000)) {
      throw new Error("provider_capture_deadline_too_close");
    }
    const captured = [];
    for (const attempt of attempts) {
      if (attempt.status === "CAPTURED") continue;
      rec.mark("capture_provider_begin", { paymentIntentId: attempt.provider_payment_id, attemptId: attempt.id });
      const intent = await captureTestPaymentIntent({
        secretKey,
        apiVersion,
        connectedAccountId: attempt.connected_account_id,
        paymentIntentId: attempt.provider_payment_id,
        amountCents: attempt.amount_cents,
        currency: attempt.currency,
        idempotencyKey: `pasturepact:capture:${job.dedupe_key}:${attempt.id}`
      });
      captured.push(intent.id);
    }
    const finish = await rpcTrace(rec, "finish_group_payment_execution_v1", {
      p_group_order_id: groupOrderId,
      p_kind: "CAPTURE",
      p_execution_token: job.id,
      p_provider_requests_succeeded: true
    }, client);
    if (finish.error) { rec.fail("capture_finish_refused", finish.error, { groupOrderId, code: finish.error.code }); throw new Error(`capture_execution_finish_${finish.error.code}_${safeError(finish.error.message)}`); }
    return { captured };
  } catch (error) {
    rec.fail("capture_failed", error, { groupOrderId });
    await rpcTrace(rec, "finish_group_payment_execution_v1", {
      p_group_order_id: groupOrderId,
      p_kind: "CAPTURE",
      p_execution_token: job.id,
      p_provider_requests_succeeded: false
    }, client);
    throw error;
  }
}

async function processCancelJob(client: ReturnType<typeof serviceClient>, job: OutboxJob, secretKey: string, apiVersion: string, rec: Recorder) {
  const groupOrderId = uuidPayload(job.payload, "group_order_id");
  const attemptId = uuidPayload(job.payload, "payment_attempt_id");
  let attempts: PaymentAttempt[];
  let groupLease = false;
  try {
    if (groupOrderId) {
      rec.mark("cancel_lease_begin", { groupOrderId, jobId: job.id });
      const lease = await rpcTrace(rec, "begin_group_payment_execution_v1", {
        p_group_order_id: groupOrderId,
        p_kind: "CANCEL",
        p_execution_token: job.id,
        p_lease_seconds: 120
      }, client);
      if (lease.error) { rec.fail("cancel_lease_refused", lease.error, { groupOrderId, code: lease.error.code }); throw new Error(`cancel_execution_${lease.error.code}`); }
      groupLease = true;
      attempts = await groupAttempts(client, groupOrderId);
      rec.mark("cancel_attempts", { groupOrderId, statuses: attempts.map((attempt) => attempt.status) });
    } else if (attemptId) {
      const { data, error } = await client.from("payment_attempts")
        .select("id,group_member_id,provider_payment_id,connected_account_id,amount_cents,currency,status,capture_before")
        .eq("id", attemptId).eq("provider", "STRIPE").single();
      if (error || !data) { rec.fail("cancel_attempt_read", error ?? new Error("missing"), { attemptId, code: error?.code ?? null }); throw new Error(`payment_attempt_read_${error?.code ?? "missing"}`); }
      attempts = [data as PaymentAttempt];
    } else {
      throw new Error("invalid_cancel_payment_payload");
    }
    const cancelled = [];
    const recoveryRequests = [];
    for (const attempt of attempts) {
      if (["CREATED", "REQUIRES_ACTION", "AUTHORIZED"].includes(attempt.status)) {
        rec.mark("cancel_provider_begin", { paymentIntentId: attempt.provider_payment_id, attemptId: attempt.id, status: attempt.status });
        const intent = await cancelTestPaymentIntent({
          secretKey,
          apiVersion,
          connectedAccountId: attempt.connected_account_id,
          paymentIntentId: attempt.provider_payment_id,
          amountCents: attempt.amount_cents,
          currency: attempt.currency,
          idempotencyKey: `pasturepact:cancel:${job.dedupe_key}:${attempt.id}`
        });
        cancelled.push(intent.id);
      } else if (groupOrderId && ["CAPTURED", "REFUNDED"].includes(attempt.status)) {
        const recovery = await rpcTrace(rec, "ensure_recovery_refund_request_v1", {
          p_payment_attempt_id: attempt.id,
          p_reason_code: "GROUP_FAILURE"
        }, client);
        if (recovery.error) throw new Error(`group_recovery_refund_${recovery.error.code}`);
        recoveryRequests.push(recovery.data);
      }
    }
    if (groupLease && groupOrderId) {
      // A failed/ambiguous finish must not issue a second lease release.
      groupLease = false;
      const finish = await rpcTrace(rec, "finish_group_payment_execution_v1", {
        p_group_order_id: groupOrderId,
        p_kind: "CANCEL",
        p_execution_token: job.id,
        p_provider_requests_succeeded: true
      }, client);
      if (finish.error) { rec.fail("cancel_finish_refused", finish.error, { groupOrderId, code: finish.error.code }); throw new Error(`cancel_execution_finish_${finish.error.code}`); }
    }
    rec.mark("cancel_done", { groupOrderId, cancelled, recoveryRequests: recoveryRequests.length });
    return { cancelled, recoveryRequests, providerRefundSubmitted: false };
  } catch (error) {
    rec.fail("cancel_failed", error, { groupOrderId });
    if (groupLease && groupOrderId) {
      await rpcTrace(rec, "finish_group_payment_execution_v1", {
        p_group_order_id: groupOrderId,
        p_kind: "CANCEL",
        p_execution_token: job.id,
        p_provider_requests_succeeded: false
      }, client);
    }
    throw error;
  }
}

async function processRefundJob(
  client: ReturnType<typeof serviceClient>,
  job: OutboxJob,
  workerId: string,
  secretKey: string,
  apiVersion: string,
  rec: Recorder
) {
  rec.mark("refund_prepare", { jobId: job.id });
  const prepared = await rpcTrace(rec, "prepare_refund_execution_v1", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_claim_version: job.claim_version
  }, client);
  if (prepared.error || !prepared.data || typeof prepared.data !== "object") {
    throw new Error(`refund_preparation_${prepared.error?.code ?? "missing"}`);
  }
  const payload = prepared.data as Record<string, unknown>;
  if (payload.alreadyCompleted === true) return { alreadyCompleted: true };
  const refundRequestId = String(payload.refundRequestId ?? "");
  const connectedAccountId = String(payload.connectedAccountId ?? "");
  const paymentIntentId = String(payload.paymentIntentId ?? "");
  const amountCents = Number(payload.amountCents);
  const currency = String(payload.currency ?? "");
  const idempotencyKey = String(payload.idempotencyKey ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(refundRequestId)) throw new Error("invalid_refund_request_id");
  const refund = await refundTestPaymentIntent({
    secretKey,
    apiVersion,
    connectedAccountId,
    paymentIntentId,
    amountCents,
    currency,
    idempotencyKey
  });
  const acceptance = await client.rpc("record_refund_provider_acceptance_v1", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_claim_version: job.claim_version,
    p_provider_refund_id: refund.id
  });
  if (acceptance.error) throw new Error(`refund_acceptance_${acceptance.error.code}`);
  return { refundRequestId, providerAccepted: true, confirmedRefund: false };
}

type BusinessExactClaim = Readonly<{ authorizationId: string; orderId: string; kind: string }>;

async function runStripeWorker(client: ReturnType<typeof serviceClient>, workerId: string, configurationVersionId: string | null, requestedTarget: string | null, rec: Recorder, business?: BusinessExactClaim) {
  if (Deno.env.get("STRIPE_EXPECTED_LIVEMODE") !== "false") throw new Error("stripe_test_mode_not_explicit");
  const storedConfiguration = configurationVersionId ?? Deno.env.get("PROVIDER_CONFIGURATION_VERSION_ID")?.trim();
  const endpoint = stripeEndpoint({ webhookSecret: false });
  if ((isLocalSupabase() || configurationVersionId !== null) && !endpoint) throw new Error("provider_lane_unavailable");
  rec.mark("lane_bind", { storedConfiguration: storedConfiguration ?? null, endpoint: endpoint?.endpointId ?? null, requestedTarget });
  const lane = endpoint
    ? await pinnedStripeLane(client, { configurationVersionId: storedConfiguration ?? "" }, { secretKey: true })
    : stripeLane({ secretKey: true, apiVersion: true });
  const configuredTarget = Deno.env.get("PAYMENT_TARGET")?.trim();
  if ((endpoint && (!storedConfiguration || lane.configurationVersionId !== storedConfiguration))
      || (requestedTarget !== null && requestedTarget !== lane.target)
      || (configuredTarget && configuredTarget !== lane.target)) throw new Error("provider_lane_mismatch");
  rec.mark("lane_resolved", { target: lane.target, configurationVersionId: lane.configurationVersionId, credentialGeneration: lane.credentialGeneration });
  const secretKey = lane.secretKey;
  const apiVersion = lane.apiVersion;
  if (lane.configurationVersionId) {
    const credential = await rpcTrace(rec, "assert_provider_credential_v1", {
      p_provider_configuration_version_id: lane.configurationVersionId,
      p_provider_credential_version_id: lane.credentialVersionId,
      p_generation: lane.credentialGeneration,
    }, client);
    if (credential.error || credential.data !== true) throw new Error("provider_credential_unavailable");
  }
  if (business && (!endpoint || !lane.configurationVersionId || lane.target !== "DEMO_TEST")) {
    throw new Error("business_exact_lane_required");
  }
  const claim = business
    ? ["claim_business_exact_launch_job_v1", {
      p_authorization_id: business.authorizationId, p_order_id: business.orderId,
      p_configuration_id: lane.configurationVersionId, p_worker_id: workerId, p_kind: business.kind,
    }] as const
    : lane.configurationVersionId
    ? ["claim_provider_outbox_jobs_v1", {
      p_worker_id: workerId, p_kinds: ["CREATE_PAYMENT", "CAPTURE_PAYMENT", "CANCEL_PAYMENT", "REFUND_PAYMENT"],
      p_payment_target: lane.target, p_provider_configuration_version_id: lane.configurationVersionId,
      p_limit: 5, p_lease_seconds: 300,
    }] as const
    : ["claim_outbox_jobs_v1", {
      p_worker_id: workerId, p_kinds: ["CREATE_PAYMENT", "CAPTURE_PAYMENT", "CANCEL_PAYMENT", "REFUND_PAYMENT"],
      p_limit: 5, p_lease_seconds: 300,
    }] as const;
  const { data, error } = await rpcTrace(rec, claim[0], claim[1], client);
  if (error) throw new Error(`claim_failed_${error.code}`);
  const jobs = (data ?? []) as OutboxJob[];
  rec.mark("claimed", { count: jobs.length, kinds: jobs.map((job) => job.kind) });
  if (business && (jobs.length > 1 || jobs.some(job => job.subject_type !== "BUSINESS_ORDER"
      || job.subject_id !== business.orderId || job.kind !== business.kind
      || job.provider_configuration_version_id !== lane.configurationVersionId))) {
    throw new Error("business_exact_claim_mismatch");
  }
  const results = [];
  for (const job of jobs) {
    rec.mark("job_start", { jobId: job.id, kind: job.kind, subjectType: job.subject_type ?? null, payloadKeys: Object.keys(job.payload ?? {}).sort() });
    try {
      if (lane.configurationVersionId) {
        if (job.provider_configuration_version_id !== lane.configurationVersionId
            || job.experience_mode !== (lane.target === "DEMO_TEST" ? "DEMO" : "REAL")) {
          throw new Error("provider_job_lane_mismatch");
        }
        const admission = await rpcTrace(rec, "assert_provider_job_lane_v1", {
          p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version,
          p_payment_target: lane.target, p_provider_configuration_version_id: lane.configurationVersionId,
        }, client);
        if (admission.error || admission.data !== true) throw new Error("provider_job_lane_mismatch");
      }
      const result = job.kind === "CREATE_PAYMENT"
        ? await processCreateJob(client, job, secretKey, apiVersion, workerId, lane, rec)
        : (job.kind === "CAPTURE_PAYMENT" || job.kind === "CANCEL_PAYMENT")
            && (job.subject_type === "BUSINESS_ORDER" || Object.hasOwn(job.payload, "business_order_id"))
          ? await processBusinessTerminalJob(client, job, workerId, lane, rec)
        : job.kind === "CAPTURE_PAYMENT"
          ? await processCaptureJob(client, job, secretKey, apiVersion, rec)
          : job.kind === "CANCEL_PAYMENT"
            ? await processCancelJob(client, job, secretKey, apiVersion, rec)
            : await processRefundJob(client, job, workerId, secretKey, apiVersion, rec);
      if (job.kind !== "REFUND_PAYMENT") await completeJob(client, job, workerId, true, rec);
      rec.mark("job_ok", { jobId: job.id, kind: job.kind });
      results.push({ jobId: job.id, kind: job.kind, ok: true, result });
    } catch (error) {
      await completeJob(client, job, workerId, false, rec, error);
      rec.fail("job_failed", error, { jobId: job.id, kind: job.kind, code: safeError(error) });
      results.push({ jobId: job.id, kind: job.kind, ok: false, code: safeError(error) });
    }
  }
  return { claimed: jobs.length, results };
}

Deno.serve(async (request) => {
  const methodError = requireMethod(request, "POST");
  if (methodError) return methodError;
  if (!equalSecret(request.headers.get("x-worker-secret"), Deno.env.get("PAYMENT_WORKER_SECRET"))) {
    return json({ error: "unauthorized" }, 401);
  }
  const client = serviceClient();
  const workerId = `${isLocalSupabase() ? "local" : "stripe-test"}-worker-${crypto.randomUUID()}`;
  // Per-request exact-line trace; returned to the caller so the harness can persist it verbatim.
  const rec = traceRecorder();
  rec.mark("request", { workerId, recoveryMode: request.headers.get("x-payment-worker-mode") ?? null,
    configurationVersionId: request.headers.get("x-provider-configuration-version") ?? null });
  // The trace is returned only on opt-in so the response contract for every existing caller is unchanged.
  const wantTrace = request.headers.get("x-w08-trace") === "1";
  const traceField = (): { trace?: TraceLine[] } => (wantTrace ? { trace: rec.lines } : {});
  const recoveryMode = request.headers.get("x-payment-worker-mode");
  if (recoveryMode === "business-exact-launch") {
    const authorizationId = request.headers.get("x-business-authorization-id") ?? "";
    const orderId = request.headers.get("x-business-order-id") ?? "";
    const kind = request.headers.get("x-business-job-kind") ?? "";
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(authorizationId) || !uuid.test(orderId)
        || !["CREATE_PAYMENT", "CAPTURE_PAYMENT", "CANCEL_PAYMENT"].includes(kind)
        || Deno.env.get("LOCAL_FAKE_PAYMENT_TARGET") || Deno.env.get("LOCAL_FAKE_CONFIGURATION_ID")) {
      return json({ error: "invalid_business_exact_claim" }, 503);
    }
    try {
      const work = await runStripeWorker(client, workerId,
        request.headers.get("x-provider-configuration-version"), request.headers.get("x-provider-target"), rec,
        { authorizationId, orderId, kind });
      return json({ ...work, ...traceField() }, 200);
    } catch (error) {
      rec.fail("handler_error", error, { mode: "business-exact-launch" });
      return json({ error: safeError(error), ...traceField() }, 503);
    }
  }
  if (["x-business-authorization-id", "x-business-order-id", "x-business-job-kind"].some(key => request.headers.has(key))) {
    return json({ error: "business_exact_mode_required" }, 503);
  }
  if (recoveryMode !== null) {
    if (recoveryMode !== "group-recovery" || Deno.env.get("LOCAL_FAKE_PAYMENT_TARGET")
        || Deno.env.get("LOCAL_FAKE_CONFIGURATION_ID")) return json({ error: "invalid_recovery_mode" }, 503);
    rec.mark("group_recovery_begin", {});
    try {
      const recovered = await runGroupRecovery(client, workerId);
      rec.mark("group_recovery_done", {});
      return json({ ...(typeof recovered === "object" && recovered !== null ? recovered : { recovered }), ...traceField() }, 200);
    } catch (error) {
      rec.fail("group_recovery_failed", error, {});
      return json({ error: "group_recovery_unavailable", ...traceField() }, 503);
    }
  }
  const configurationVersionId = request.headers.get("x-provider-configuration-version");
  const requestedTarget = request.headers.get("x-provider-target");
  const storedDispatch = configurationVersionId !== null || requestedTarget !== null
    || Boolean(Deno.env.get("PROVIDER_NAMESPACE_ID") || Deno.env.get("PROVIDER_WEBHOOK_ENDPOINT_ID")
      || Deno.env.get("PROVIDER_CONFIGURATION_VERSION_ID") || Deno.env.get("PAYMENT_TARGET"));
  if (!isLocalSupabase() || storedDispatch) {
    if (Deno.env.get("LOCAL_FAKE_PAYMENT_TARGET") || Deno.env.get("LOCAL_FAKE_CONFIGURATION_ID")) {
      return json({ error: "contradictory_payment_selectors" }, 503);
    }
    let recovery: Awaited<ReturnType<typeof runGroupRecovery>> | { error: string };
    rec.mark("group_recovery_begin", {});
    try {
      recovery = await runGroupRecovery(client, workerId);
      rec.mark("group_recovery_done", {});
    } catch (error) {
      rec.fail("group_recovery_failed", error, {});
      recovery = { error: "group_recovery_unavailable" };
    }
    try {
      const work = await runStripeWorker(client, workerId, configurationVersionId, requestedTarget, rec);
      return json({ ...work, recovery, ...traceField() }, "error" in recovery ? 503 : 200);
    } catch (error) {
      rec.fail("handler_error", error, { mode: "stored-dispatch" });
      return json({ error: safeError(error), recovery, ...traceField() }, 503);
    }
  }
  const target = Deno.env.get("LOCAL_FAKE_PAYMENT_TARGET");
  const configuration = Deno.env.get("LOCAL_FAKE_CONFIGURATION_ID");
  if (target || configuration) {
    if (!["DEMO_TEST", "REAL_TEST"].includes(target ?? "") || !configuration) {
      return json({ error: "invalid_local_fake_lane" }, 503);
    }
    const lane = { p_payment_target: target, p_provider_configuration_version_id: configuration };
    const claim = await client.rpc("claim_local_fake_household_jobs_v1", {
      ...lane, p_worker_id: workerId, p_limit: 20, p_lease_seconds: 60,
    });
    if (claim.error) return json({ error: "local_fake_claim_failed", code: claim.error.code }, 503);
    const results = [];
    for (const job of claim.data ?? []) {
      const result = await client.rpc("process_local_fake_household_job_v1", {
        ...lane, p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version,
      });
      results.push(result.error
        ? { jobId: job.id, ok: false, code: result.error.code }
        : { jobId: job.id, ok: true, result: result.data });
    }
    return json({ claimed: claim.data?.length ?? 0, results }, 200);
  }
  const { data: jobs, error: claimError } = await client.rpc("claim_outbox_jobs_v1", {
    p_worker_id: workerId, p_kinds: ["CREATE_PAYMENT", "CAPTURE_PAYMENT", "CANCEL_PAYMENT", "REFUND_PAYMENT"], p_limit: 20, p_lease_seconds: 60
  });
  if (claimError) return json({ error: "claim_failed", code: claimError.code }, 500);
  const results = [];
  for (const job of jobs ?? []) {
    if (job.kind === "REFUND_PAYMENT") {
      const { data, error } = await client.rpc("process_fake_refund_job_v1", {
        p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version
      });
      if (error) {
        await client.rpc("complete_outbox_job_v1", {
          p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version,
          p_succeeded: false, p_error_code: safeError(error.message)
        });
      }
      results.push(error ? { jobId: job.id, ok: false, code: error.code } : { jobId: job.id, ok: true, result: data });
      continue;
    }
    let groupJob = Boolean(job.payload?.group_order_id || job.payload?.group_member_id);
    if (job.kind === "CREATE_PAYMENT") {
      try {
        const groupMemberId = uuidPayload(job.payload, "group_member_id");
        const sellerOrderId = uuidPayload(job.payload, "seller_order_id");
        const payloadGroupOrderId = uuidPayload(job.payload, "group_order_id");
        if (!sellerOrderId) throw new Error("invalid_create_payment_payload");
        const order = await sellerOrder(client, sellerOrderId);
        groupJob = order.group_order_id !== null;
        if ((groupJob && (!groupMemberId || payloadGroupOrderId !== order.group_order_id))
            || (!groupJob && (groupMemberId || payloadGroupOrderId))) {
          throw new Error("group_payment_payload_mismatch");
        }
        if (groupJob && groupMemberId) await acceptedGroupMember(client, groupMemberId, sellerOrderId);
      } catch (error) {
        await client.rpc("complete_outbox_job_v1", {
          p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version,
          p_succeeded: false, p_error_code: safeError(error)
        });
        results.push({ jobId: job.id, ok: false, code: safeError(error) });
        continue;
      }
    }
    const { data, error } = await client.rpc(groupJob ? "process_admitted_fake_group_payment_job_v1" : "process_fake_payment_job_v1", {
      p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version
    });
    if (error) {
      await client.rpc("complete_outbox_job_v1", {
        p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version,
        p_succeeded: false, p_error_code: safeError(error.message)
      });
    }
    results.push(error ? { jobId: job.id, ok: false, code: error.code } : { jobId: job.id, ok: true, result: data });
  }
  return json({ claimed: jobs?.length ?? 0, results }, 200);
});
