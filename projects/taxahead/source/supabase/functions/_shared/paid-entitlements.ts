export const PAID_FEATURES = [
  "dashboard",
  "tax_package",
  "document_processing",
  "advisor",
  "connections",
] as const;

export type PaidFeature = (typeof PAID_FEATURES)[number];
export type BillingMembership =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export type PaidEntitlementSnapshot = {
  membership: BillingMembership;
  payment_state: "unknown" | "paid" | "failed";
  price_id: string;
  livemode: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
};

export type PaidEntitlementConfig = {
  environment: "development" | "preview" | "production";
  priceId: string;
  expectedLivemode: boolean;
  features: Record<PaidFeature, boolean>;
};

export type PaidEntitlementDecision =
  | {
      allowed: true;
      status: 200;
      reason: "entitled";
      feature: PaidFeature;
    }
  | {
      allowed: false;
      status: 403;
      reason: "feature_disabled";
      feature: PaidFeature;
      error: "feature_disabled";
    }
  | {
      allowed: false;
      status: 403;
      reason: "entitlement_required";
      feature: PaidFeature;
      error: "entitlement_required";
      upgrade_url: "/pricing";
    }
  | {
      allowed: false;
      status: 503;
      reason: "entitlements_not_configured" | "entitlement_unavailable";
      feature: PaidFeature;
      error: "entitlements_not_configured" | "entitlement_unavailable";
    };

type RawConfig = Record<string, string | undefined>;
type RpcClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

const MEMBERSHIPS = new Set<BillingMembership>([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
const ENVIRONMENTS = new Set(["development", "preview", "production"]);
const FEATURE_SET = new Set<string>(PAID_FEATURES);
const SNAPSHOT_KEYS = [
  "membership",
  "payment_state",
  "price_id",
  "livemode",
  "current_period_end",
  "cancel_at_period_end",
  "updated_at",
].sort();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function exactIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function readRuntimeConfig(): RawConfig {
  return {
    TAXAHEAD_ENVIRONMENT: Deno.env.get("TAXAHEAD_ENVIRONMENT") ?? undefined,
    TAXAHEAD_PAID_PRICE_ID: Deno.env.get("TAXAHEAD_PAID_PRICE_ID") ?? undefined,
    TAXAHEAD_PAID_EXPECTED_LIVEMODE: Deno.env.get("TAXAHEAD_PAID_EXPECTED_LIVEMODE") ?? undefined,
    TAXAHEAD_PAID_FEATURE_FLAGS: Deno.env.get("TAXAHEAD_PAID_FEATURE_FLAGS") ?? undefined,
  };
}

export function parsePaidEntitlementConfig(raw: RawConfig): PaidEntitlementConfig | null {
  const environment = raw.TAXAHEAD_ENVIRONMENT;
  const priceId = raw.TAXAHEAD_PAID_PRICE_ID;
  const expectedMode = raw.TAXAHEAD_PAID_EXPECTED_LIVEMODE;
  if (
    !environment ||
    !ENVIRONMENTS.has(environment) ||
    !priceId ||
    !/^price_[A-Za-z0-9]+$/.test(priceId) ||
    (expectedMode !== "true" && expectedMode !== "false")
  ) {
    return null;
  }

  let flags: unknown;
  try {
    flags = JSON.parse(raw.TAXAHEAD_PAID_FEATURE_FLAGS ?? "");
  } catch {
    return null;
  }
  if (!isRecord(flags) || !exactKeys(flags, [...PAID_FEATURES].sort())) return null;
  for (const [feature, enabled] of Object.entries(flags)) {
    if (!FEATURE_SET.has(feature) || typeof enabled !== "boolean") return null;
  }

  return {
    environment: environment as PaidEntitlementConfig["environment"],
    priceId,
    expectedLivemode: expectedMode === "true",
    features: flags as Record<PaidFeature, boolean>,
  };
}

function validSnapshot(value: unknown): value is PaidEntitlementSnapshot {
  if (!isRecord(value) || !exactKeys(value, SNAPSHOT_KEYS)) return false;
  return (
    typeof value.membership === "string" &&
    MEMBERSHIPS.has(value.membership as BillingMembership) &&
    (value.payment_state === "unknown" ||
      value.payment_state === "paid" ||
      value.payment_state === "failed") &&
    typeof value.price_id === "string" &&
    /^price_[A-Za-z0-9]+$/.test(value.price_id) &&
    typeof value.livemode === "boolean" &&
    (value.current_period_end === null || exactIso(value.current_period_end)) &&
    typeof value.cancel_at_period_end === "boolean" &&
    exactIso(value.updated_at)
  );
}

export async function readPaidEntitlementSnapshot(
  client: RpcClient,
): Promise<PaidEntitlementSnapshot | null | undefined> {
  try {
    const { data, error } = await client.rpc("get_paid_entitlement_snapshot");
    if (error || !Array.isArray(data) || data.length > 1) return undefined;
    if (data.length === 0) return null;
    return validSnapshot(data[0]) ? data[0] : undefined;
  } catch {
    return undefined;
  }
}

export function evaluatePaidEntitlement(
  feature: PaidFeature,
  snapshot: PaidEntitlementSnapshot | null,
  config: PaidEntitlementConfig,
  now = Date.now(),
): PaidEntitlementDecision {
  if (!config.features[feature]) {
    return {
      allowed: false,
      status: 403,
      reason: "feature_disabled",
      feature,
      error: "feature_disabled",
    };
  }

  const expiresAt = snapshot?.current_period_end ? Date.parse(snapshot.current_period_end) : NaN;
  const active =
    snapshot?.membership === "trialing" ||
    (snapshot?.membership === "active" && snapshot.payment_state === "paid");
  if (
    !snapshot ||
    !active ||
    snapshot.price_id !== config.priceId ||
    snapshot.livemode !== config.expectedLivemode ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    return {
      allowed: false,
      status: 403,
      reason: "entitlement_required",
      feature,
      error: "entitlement_required",
      upgrade_url: "/pricing",
    };
  }

  return { allowed: true, status: 200, reason: "entitled", feature };
}

export async function authorizePaidFeature(
  client: RpcClient,
  feature: PaidFeature,
  options: { rawConfig?: RawConfig; now?: number } = {},
): Promise<PaidEntitlementDecision> {
  const config = parsePaidEntitlementConfig(options.rawConfig ?? readRuntimeConfig());
  if (!config) {
    // Free / no-Stripe mode: when Stripe entitlement configuration is absent
    // (Stripe kept out), there is no paywall — every feature is available.
    return {
      allowed: true,
      status: 200,
      reason: "entitled",
      feature,
    };
  }
  const snapshot = await readPaidEntitlementSnapshot(client);
  if (snapshot === undefined) {
    return {
      allowed: false,
      status: 503,
      reason: "entitlement_unavailable",
      feature,
      error: "entitlement_unavailable",
    };
  }
  return evaluatePaidEntitlement(feature, snapshot, config, options.now);
}

export function paidEntitlementErrorBody(
  decision: Exclude<PaidEntitlementDecision, { allowed: true }>,
) {
  return {
    error: decision.error,
    feature: decision.feature,
    ...(decision.reason === "entitlement_required" ? { upgrade_url: decision.upgrade_url } : {}),
  };
}

export type PaidEntitlementAuthorizer = typeof authorizePaidFeature;
