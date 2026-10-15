import { pinnedStripeLane, stripeEndpoint, type StripeLane } from "./provider-lane.ts";
import { GroupProviderUncertainty, groupIntentTransport, type StripePaymentIntent } from "./stripe-api.ts";

type Client = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export type GroupOperation = {
  id: string; seller_order_id: string; group_member_id: string; configuration_id: string;
  namespace_id: string; endpoint_id: string; account_id: string; amount_cents: number; currency: string;
  idempotency_key: string; execution_version: number; state: string; provider_id: string | null;
  first_dispatched_at: string | null; replay_deadline: string | null; mode?: string;
};

async function rpc(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.rpc(name, args);
  if (result.error || result.data === null) throw new Error(`${name}_failed`);
  return result.data;
}

function result(operation: GroupOperation) {
  return { operationId: operation.id, operationState: operation.state, paymentIntentId: operation.provider_id,
    attached: operation.state === "ATTACHED", compensated: operation.state === "CANCELLED",
    browserConfirmationRequired: operation.state === "ATTACHED", confirmedPayment: false,
    reviewRequired: ["RECONCILE_REQUIRED", "ABANDONED"].includes(operation.state) };
}

export async function executeGroupOperation(client: Client, operation: GroupOperation, workerId: string,
  lane: StripeLane, recovery: boolean, fetcher?: typeof fetch): Promise<Record<string, unknown>> {
  if (operation.state === "ABANDONED") return result(operation);
  if (!recovery) {
    operation = await rpc(client, "begin_group_provider_dispatch_v1", {
      p_operation_id: operation.id, p_worker_id: workerId, p_execution_version: operation.execution_version
    }) as GroupOperation;
  }
  if (["ATTACHED", "CANCELLED", "ABANDONED"].includes(operation.state)) return result(operation);
  const endpoint = stripeEndpoint({ webhookSecret: false });
  if (!endpoint || endpoint.namespaceId !== operation.namespace_id || endpoint.endpointId !== operation.endpoint_id
      || lane.configurationVersionId !== operation.configuration_id) throw new Error("group_operation_lane_mismatch");
  const fence = { p_operation_id: operation.id, p_worker_id: workerId, p_execution_version: operation.execution_version };
  let uncertaintyReason: string | undefined;
  const transport = (action: "CREATE" | "READ" | "CANCEL", knownId: string | null = operation.provider_id) => groupIntentTransport({
    operationId: operation.id, sellerOrderId: operation.seller_order_id, groupMemberId: operation.group_member_id,
    connectedAccountId: operation.account_id, amountCents: operation.amount_cents, currency: operation.currency,
    secretKey: lane.secretKey, apiVersion: lane.apiVersion,
    idempotencyKey: action === "CANCEL" ? `${operation.idempotency_key}:cancel` : operation.idempotency_key,
    action, ...(knownId ? { paymentIntentId: knownId } : {}),
    createdFrom: Math.floor(Date.parse(operation.first_dispatched_at ?? "") / 1000) - 300,
    createdThrough: Math.ceil(Date.parse(operation.replay_deadline ?? "") / 1000) + 300,
    ...(fetcher ? { fetcher } : {}),
    assertTransport: async () => {
      const asserted = await rpc(client, "assert_group_provider_transport_v1", { ...fence,
        p_namespace_id: endpoint.namespaceId, p_endpoint_id: endpoint.endpointId,
        p_credential_id: lane.credentialVersionId, p_credential_generation: lane.credentialGeneration, p_action: action
      }) as Record<string, unknown>;
      if (asserted.operationId !== operation.id || asserted.connectedAccountId !== operation.account_id
          || asserted.configurationVersionId !== lane.configurationVersionId || asserted.apiVersion !== lane.apiVersion
          || asserted.namespaceId !== endpoint.namespaceId || asserted.endpointId !== endpoint.endpointId
          || asserted.credentialVersionId !== lane.credentialVersionId || asserted.credentialGeneration !== lane.credentialGeneration) {
        throw new Error("group_operation_transport_mismatch");
      }
    }
  }).catch(async (error: unknown) => {
    if (!(error instanceof GroupProviderUncertainty)) throw error;
    operation = await rpc(client, "record_group_provider_uncertainty_v1", {
      ...fence, p_reason: error.reason
    }) as GroupOperation;
    uncertaintyReason = error.reason;
    return null;
  });
  const unresolved = () => ({ ...result(operation), unresolved: true, reviewRequired: true,
    escalationOwner: "PAYMENT_OPERATIONS_REVIEW", reason: uncertaintyReason });
  const create = !recovery && operation.mode === "CREATE" && operation.provider_id === null
    && Date.parse(operation.replay_deadline ?? "") > Date.now();
  const intent = await transport(create ? "CREATE" : "READ");
  if (!intent) return unresolved();
  const observation = (value: StripePaymentIntent) => ({ ...fence, p_provider_id: value.id,
    p_amount: value.amount, p_currency: value.currency.toUpperCase(), p_account: operation.account_id,
    p_livemode: value.livemode });
  if (create && ["requires_payment_method", "requires_confirmation"].includes(intent.status)) {
    operation = await rpc(client, "record_group_provider_result_v1", observation(intent)) as GroupOperation;
  } else {
    operation = await rpc(client, "record_group_provider_recovery_outcome_v1", {
      ...observation(intent), p_status: intent.status
    }) as GroupOperation;
  }
  if (operation.state === "CANCEL_REQUIRED") {
    const cancelled = await transport("CANCEL", intent.id);
    if (!cancelled) return unresolved();
    operation = await rpc(client, "record_group_provider_recovery_outcome_v1", {
      ...observation(cancelled), p_status: cancelled.status
    }) as GroupOperation;
  }
  return result(operation);
}

export async function prepareGroupOperation(client: Client, job: { id: string; claim_version: number }, workerId: string,
  lane: StripeLane): Promise<Record<string, unknown>> {
  const operation = await rpc(client, "prepare_group_provider_operation_v1", {
    p_job_id: job.id, p_worker_id: workerId, p_claim_version: job.claim_version
  }) as GroupOperation;
  return executeGroupOperation(client, operation, workerId, lane, false);
}

export async function runGroupRecovery(client: Client, workerId: string) {
  const endpoint = stripeEndpoint({ webhookSecret: false });
  if (!endpoint) throw new Error("provider_lane_unavailable");
  const operations = await rpc(client, "claim_group_provider_recovery_v1", { p_worker_id: workerId,
    p_namespace_id: endpoint.namespaceId, p_endpoint_id: endpoint.endpointId, p_limit: 1 }) as GroupOperation[];
  const results = [];
  for (const operation of operations) {
    try {
      if (operation.state === "ABANDONED") {
        results.push({ operationId: operation.id, ok: true, result: result(operation) });
        continue;
      }
      const lane = await pinnedStripeLane(client, { operationId: operation.id, connectedAccountId: operation.account_id }, { secretKey: true });
      results.push({ operationId: operation.id, ok: true,
        result: await executeGroupOperation(client, operation, workerId, lane, true) });
    } catch {
      results.push({ operationId: operation.id, ok: false, unresolved: true, code: "group_recovery_incomplete" });
    }
  }
  return { claimed: operations.length, results };
}
