declare const Deno: { env: { get(name: string): string | undefined } };

export type StripeLane = Readonly<{
  target: "DEMO_TEST" | "REAL_TEST";
  configurationVersionId: string | null;
  credentialVersionId: string | null;
  credentialGeneration: number | null;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  apiVersion: string;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localOrUnitRuntime(): boolean {
  const value = Deno.env.get("SUPABASE_URL")?.trim();
  if (!value) return true;
  try {
    return ["127.0.0.1", "localhost", "kong"].includes(new URL(value).hostname)
      || new URL(value).hostname.startsWith("supabase_kong_");
  } catch {
    return false;
  }
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

export function stripeLane(needs: Partial<Record<"secretKey" | "publishableKey" | "webhookSecret" | "apiVersion", boolean>> = {}): StripeLane {
  const configuredTarget = Deno.env.get("PAYMENT_TARGET")?.trim();
  const local = localOrUnitRuntime();
  if (!local && !configuredTarget) throw new Error("provider_lane_unavailable");
  const target = configuredTarget || (local ? "REAL_TEST" : "");
  if (target !== "DEMO_TEST" && target !== "REAL_TEST") throw new Error("provider_lane_unavailable");
  const configurationVersionId = Deno.env.get("PROVIDER_CONFIGURATION_VERSION_ID")?.trim() || null;
  const credentialVersionId = Deno.env.get("PROVIDER_CREDENTIAL_VERSION_ID")?.trim() || null;
  const credentialGeneration = Number(Deno.env.get("PROVIDER_CREDENTIAL_GENERATION")?.trim() || "0") || null;
  if (!local && (!configurationVersionId || !uuidPattern.test(configurationVersionId)
      || !credentialVersionId || !uuidPattern.test(credentialVersionId)
      || !credentialGeneration || !Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1)) {
    throw new Error("provider_lane_unavailable");
  }
  const prefix = target === "DEMO_TEST" ? "DEMO_" : "";
  const value = (name: string, needed: boolean | undefined, fallback: string) =>
    needed ? required(name) : Deno.env.get(name)?.trim() || fallback;
  const secretKey = value(`${prefix}STRIPE_SECRET_KEY`, needs.secretKey, "sk_test_unused");
  const publishableKey = value(`${prefix}STRIPE_PUBLISHABLE_KEY`, needs.publishableKey, "pk_test_unused");
  const webhookSecret = value(`${prefix}STRIPE_CONNECT_WEBHOOK_SECRET`, needs.webhookSecret, "whsec_unused");
  const apiVersion = value(`${prefix}STRIPE_API_VERSION`, needs.apiVersion, "2025-08-27.basil");
  if ((needs.secretKey && !/^(?:sk|rk)_test_[A-Za-z0-9_]+$/.test(secretKey))
      || (needs.publishableKey && !/^pk_test_[A-Za-z0-9_]+$/.test(publishableKey))
      || (needs.webhookSecret && webhookSecret.length < 8)
      || (needs.apiVersion && !/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(apiVersion))) throw new Error("provider_lane_unavailable");
  return { target, configurationVersionId, credentialVersionId, credentialGeneration,
    secretKey, publishableKey, webhookSecret, apiVersion };
}

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

export function stripeEndpoint(needs: { webhookSecret?: boolean } = { webhookSecret: true }): { endpointId: string; namespaceId: string; signingSecretName: string; webhookSecret: string } | null {
  const namespaceId = Deno.env.get("PROVIDER_NAMESPACE_ID")?.trim();
  if (!namespaceId) return null;
  const endpointId = required("PROVIDER_WEBHOOK_ENDPOINT_ID");
  const signingSecretName = "STRIPE_CONNECT_WEBHOOK_SECRET";
  if (!uuidPattern.test(namespaceId) || !/^we_[A-Za-z0-9]+$/.test(endpointId)
      || Deno.env.get("STRIPE_EXPECTED_LIVEMODE") !== "false") throw new Error("provider_lane_unavailable");
  return { endpointId, namespaceId, signingSecretName, webhookSecret: needs.webhookSecret !== false ? required(signingSecretName) : "" };
}

export async function pinnedStripeLane(client: RpcClient,
  subject: { configurationVersionId: string } | { connectedAccountId: string; paymentIntentId: string } | { operationId: string; connectedAccountId: string },
  needs: { secretKey?: boolean; publishableKey?: boolean } = {}): Promise<StripeLane> {
  const endpoint = stripeEndpoint({ webhookSecret: false });
  if (!endpoint) throw new Error("provider_lane_unavailable");
  const args = { p_endpoint_id: endpoint.endpointId, p_namespace_id: endpoint.namespaceId };
  const result = "operationId" in subject
    ? await client.rpc("resolve_group_provider_recovery_lane_v1", { ...args, p_operation_id: subject.operationId })
    : "configurationVersionId" in subject
    ? await client.rpc("resolve_stripe_configuration_v1", { ...args, p_configuration_id: subject.configurationVersionId })
    : await client.rpc("resolve_stripe_payment_configuration_v1", { ...args,
      p_connected_account_id: subject.connectedAccountId, p_provider_payment_id: subject.paymentIntentId });
  if (result.error || !result.data || typeof result.data !== "object") throw new Error("provider_mapping_unavailable");
  const row = result.data as Record<string, unknown>;
  if ("operationId" in subject && (row.operationId !== subject.operationId
      || row.connectedAccountId !== subject.connectedAccountId || row.namespaceId !== endpoint.namespaceId
      || row.endpointId !== endpoint.endpointId)) throw new Error("provider_lane_mismatch");
  if (!["DEMO_TEST", "REAL_TEST"].includes(String(row.target))
      || !uuidPattern.test(String(row.configurationVersionId)) || !uuidPattern.test(String(row.credentialVersionId))
      || !Number.isSafeInteger(row.credentialGeneration) || Number(row.credentialGeneration) < 1
      || row.signingSecretName !== endpoint.signingSecretName
      || !/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(String(row.apiVersion))) throw new Error("provider_lane_unavailable");
  const read = (name: unknown, kind: "SECRET_KEY" | "PUBLISHABLE_KEY", needed: boolean | undefined): string => {
    if (!needed) return kind === "SECRET_KEY" ? "sk_test_unused" : "pk_test_unused";
    if (typeof name !== "string" || !new RegExp(`^(?:DEMO_)?STRIPE_${kind}(?:_V[0-9]+)?$`).test(name)) {
      throw new Error("provider_lane_unavailable");
    }
    const value = required(name);
    if (!(kind === "SECRET_KEY" ? /^(sk|rk)_test_[A-Za-z0-9_]+$/ : /^pk_test_[A-Za-z0-9_]+$/).test(value)) {
      throw new Error("provider_lane_unavailable");
    }
    return value;
  };
  return { target: row.target as StripeLane["target"], configurationVersionId: String(row.configurationVersionId),
    credentialVersionId: String(row.credentialVersionId), credentialGeneration: Number(row.credentialGeneration),
    secretKey: read(row.secretName, "SECRET_KEY", needs.secretKey),
    publishableKey: read(row.publishableKeyName, "PUBLISHABLE_KEY", needs.publishableKey),
    webhookSecret: endpoint.webhookSecret, apiVersion: String(row.apiVersion) };
}
