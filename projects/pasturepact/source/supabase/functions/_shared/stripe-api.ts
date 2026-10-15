import { businessProviderMetadata, parseBusinessPaymentSubject, verifyBusinessProviderMetadata, type BusinessPaymentSubject } from "./business-payment-contract.ts";

export type StripePaymentIntent = Readonly<{
  id: string;
  amount: number;
  currency: string;
  livemode: boolean;
  status: string;
  client_secret?: string | null;
}>;

export type StripeRefund = Readonly<{
  id: string;
  amount: number;
  currency: string;
  payment_intent: string;
  status: string | null;
}>;

type Fetcher = typeof fetch;

type StripeRequest = Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  path: string;
  idempotencyKey: string;
  method?: "GET" | "POST";
  body?: URLSearchParams;
  fetcher?: Fetcher;
  deadlineAt?: number;
}>;

const stripeApiOrigin = "https://api.stripe.com";

function requiredMatch(value: string, expression: RegExp, error: string): string {
  if (!expression.test(value)) throw new Error(error);
  return value;
}

function safeProviderCode(value: unknown): string {
  const code = typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_.-]/g, "_") : "unknown";
  return code.slice(0, 60) || "unknown";
}

function validateCommon(secretKey: string, apiVersion: string, connectedAccountId: string, idempotencyKey: string): void {
  requiredMatch(secretKey, /^(?:sk|rk)_test_[A-Za-z0-9_]+$/, "stripe_test_key_required");
  requiredMatch(apiVersion, /^\d{4}-\d{2}-\d{2}\.[a-z]+$/, "invalid_stripe_api_version");
  requiredMatch(connectedAccountId, /^acct_[A-Za-z0-9]+$/, "invalid_connected_account_id");
  if (idempotencyKey.length < 1 || idempotencyKey.length > 255 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) {
    throw new Error("invalid_stripe_idempotency_key");
  }
}

async function stripeRequest<T>(request: StripeRequest): Promise<T> {
  validateCommon(request.secretKey, request.apiVersion, request.connectedAccountId, request.idempotencyKey);
  const remainingMilliseconds = request.deadlineAt === undefined ? 20_000 : Math.floor(request.deadlineAt - Date.now());
  if (remainingMilliseconds <= 0) throw new Error("stripe_reconciliation_deadline_exceeded");
  const fetcher = request.fetcher ?? fetch;
  const response = await fetcher(`${stripeApiOrigin}${request.path}`, {
    method: request.method ?? "POST",
    headers: {
      authorization: `Bearer ${request.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": request.idempotencyKey,
      "stripe-account": request.connectedAccountId,
      "stripe-version": request.apiVersion
    },
    ...(request.method === "GET" ? {} : { body: request.body?.toString() ?? "" }),
    signal: AbortSignal.timeout(Math.min(20_000, remainingMilliseconds))
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (request.deadlineAt !== undefined && Date.now() >= request.deadlineAt) {
    throw new Error("stripe_reconciliation_deadline_exceeded");
  }
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(`stripe_${response.status}_${safeProviderCode(error?.code ?? error?.type)}`);
  }
  return payload as T;
}

function validateMoney(amountCents: number, currency: string): void {
  if (!Number.isSafeInteger(amountCents) || amountCents < 50 || amountCents > 99_999_999) {
    throw new Error("invalid_stripe_amount");
  }
  requiredMatch(currency, /^[A-Z]{3}$/, "invalid_stripe_currency");
}

function validateIntent(intent: StripePaymentIntent, amountCents: number, currency: string): StripePaymentIntent {
  requiredMatch(intent.id, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  if (intent.livemode) throw new Error("stripe_live_mode_blocked");
  if (intent.amount !== amountCents || intent.currency !== currency.toLowerCase()) {
    throw new Error("stripe_payment_intent_mismatch");
  }
  return intent;
}

function validateBoundIntent(
  intent: StripePaymentIntent,
  paymentIntentId: string,
  amountCents: number,
  currency: string
): StripePaymentIntent {
  validateIntent(intent, amountCents, currency);
  if (intent.id !== paymentIntentId) throw new Error("stripe_payment_intent_mismatch");
  return intent;
}

export async function createTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  amountCents: number;
  currency: string;
  captureMethod: "automatic" | "manual";
  applicationFeeCents?: number;
  idempotencyKey: string;
  fetcher?: Fetcher;
} & ({ subjectType?: "SELLER_ORDER"; sellerOrderId: string; groupMemberId?: string; businessSubject?: never }
  | { subjectType: "BUSINESS_ORDER"; businessSubject: BusinessPaymentSubject; sellerOrderId?: never; groupMemberId?: never })>): Promise<StripePaymentIntent> {
  validateMoney(input.amountCents, input.currency);
  const business = input.subjectType === "BUSINESS_ORDER" ? parseBusinessPaymentSubject(input.businessSubject) : null;
  if (business) {
    if (input.sellerOrderId !== undefined || input.groupMemberId !== undefined
        || input.captureMethod !== "manual" || (input.applicationFeeCents ?? 0) !== 0
        || input.amountCents !== business.amountCents || input.currency !== business.currency
        || input.connectedAccountId !== business.accountId || input.idempotencyKey !== business.idempotencyKey) {
      throw new Error("business_payment_contract_invalid");
    }
  } else {
    requiredMatch(input.sellerOrderId ?? "", /^[0-9a-f-]{36}$/i, "invalid_seller_order_id");
  }
  if (input.groupMemberId) requiredMatch(input.groupMemberId, /^[0-9a-f-]{36}$/i, "invalid_group_member_id");
  if (input.applicationFeeCents !== undefined
      && (!Number.isSafeInteger(input.applicationFeeCents) || input.applicationFeeCents < 0
        || input.applicationFeeCents > input.amountCents)) {
    throw new Error("invalid_application_fee");
  }
  const body = new URLSearchParams({
    amount: String(input.amountCents),
    currency: input.currency.toLowerCase(),
    capture_method: input.captureMethod,
    "payment_method_types[]": "card"
  });
  if (business) {
    for (const [key, value] of Object.entries(businessProviderMetadata(business))) body.set(`metadata[${key}]`, value);
  } else {
    body.set("metadata[pasture_pact_seller_order_id]", input.sellerOrderId!);
  }
  if (input.groupMemberId) body.set("metadata[pasture_pact_group_member_id]", input.groupMemberId);
  if ((input.applicationFeeCents ?? 0) > 0) body.set("application_fee_amount", String(input.applicationFeeCents));
  const intent = await stripeRequest<StripePaymentIntent>({
    ...input,
    path: "/v1/payment_intents",
    body
  });
  if (business && intent.livemode !== false) throw new Error("stripe_live_mode_blocked");
  return validateIntent(intent, input.amountCents, input.currency);
}

export async function confirmTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  captureMethod: "automatic" | "manual";
  idempotencyKey: string;
  fetcher?: Fetcher;
}>): Promise<StripePaymentIntent> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  requiredMatch(input.paymentMethodId, /^pm_[A-Za-z0-9_]+$/, "invalid_stripe_payment_method");
  validateMoney(input.amountCents, input.currency);
  const intent = await stripeRequest<StripePaymentIntent>({
    ...input,
    path: `/v1/payment_intents/${input.paymentIntentId}/confirm`,
    body: new URLSearchParams({
      payment_method: input.paymentMethodId,
      error_on_requires_action: "true"
    })
  });
  validateBoundIntent(intent, input.paymentIntentId, input.amountCents, input.currency);
  const expected = input.captureMethod === "manual" ? "requires_capture" : "succeeded";
  if (intent.status !== expected) throw new Error(`stripe_unexpected_status_${safeProviderCode(intent.status)}`);
  return intent;
}

export async function captureTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
}>): Promise<StripePaymentIntent> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  validateMoney(input.amountCents, input.currency);
  const intent = await stripeRequest<StripePaymentIntent>({
    ...input,
    path: `/v1/payment_intents/${input.paymentIntentId}/capture`,
    body: new URLSearchParams({ amount_to_capture: String(input.amountCents) })
  });
  validateBoundIntent(intent, input.paymentIntentId, input.amountCents, input.currency);
  if (intent.status !== "succeeded") throw new Error(`stripe_unexpected_status_${safeProviderCode(intent.status)}`);
  return intent;
}

export async function cancelTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
}>): Promise<StripePaymentIntent> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  validateMoney(input.amountCents, input.currency);
  let intent: StripePaymentIntent;
  try {
    intent = await stripeRequest<StripePaymentIntent>({
      ...input,
      path: `/v1/payment_intents/${input.paymentIntentId}/cancel`,
      body: new URLSearchParams({ cancellation_reason: "abandoned" })
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "stripe_400_payment_intent_unexpected_state") throw error;
    // Competing cancellation jobs have distinct keys; only a bound GET proves cancellation.
    intent = await stripeRequest<StripePaymentIntent>({
      ...input,
      method: "GET",
      path: `/v1/payment_intents/${input.paymentIntentId}`
    });
  }
  if (intent.livemode !== false) throw new Error("stripe_live_mode_blocked");
  validateBoundIntent(intent, input.paymentIntentId, input.amountCents, input.currency);
  if (intent.status !== "canceled") throw new Error(`stripe_unexpected_status_${safeProviderCode(intent.status)}`);
  return intent;
}

export async function refundTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
}>): Promise<StripeRefund> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  validateMoney(input.amountCents, input.currency);
  const refund = await stripeRequest<StripeRefund>({
    ...input,
    path: "/v1/refunds",
    body: new URLSearchParams({
      payment_intent: input.paymentIntentId,
      amount: String(input.amountCents),
      reason: "requested_by_customer"
    })
  });
  requiredMatch(refund.id, /^re_[A-Za-z0-9]+$/, "invalid_stripe_refund");
  if (refund.payment_intent !== input.paymentIntentId || refund.amount !== input.amountCents
      || refund.currency !== input.currency.toLowerCase() || !["pending", "succeeded"].includes(refund.status ?? "")) {
    throw new Error("stripe_refund_mismatch");
  }
  return refund;
}

export async function retrieveTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
}>): Promise<StripePaymentIntent & { client_secret: string }> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  validateMoney(input.amountCents, input.currency);
  const intent = await stripeRequest<StripePaymentIntent>({
    ...input,
    method: "GET",
    path: `/v1/payment_intents/${input.paymentIntentId}`
  });
  validateBoundIntent(intent, input.paymentIntentId, input.amountCents, input.currency);
  const clientSecret = intent.client_secret;
  if (typeof clientSecret !== "string"
      || !clientSecret.startsWith(`${input.paymentIntentId}_secret_`)
      || clientSecret.length > 255) {
    throw new Error("stripe_client_secret_unavailable");
  }
  if (!["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture"].includes(intent.status)) {
    throw new Error(`stripe_payment_session_unavailable_${safeProviderCode(intent.status)}`);
  }
  return { ...intent, client_secret: clientSecret };
}

type StripeIntentWithCharge = StripePaymentIntent & Readonly<{
  latest_charge?: string | Readonly<{
    payment_method_details?: Readonly<{
      card?: Readonly<{ capture_before?: number | null }>;
    }>;
  }> | null;
}>;

type StripeFeeDetail = Readonly<{
  amount: number;
  currency: string;
  type: string;
}>;

type StripeBalanceTransaction = Readonly<{
  id: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  created: number;
  source: string | null;
  type: string;
  fee_details: readonly StripeFeeDetail[];
  exchange_rate?: number | null;
}>;

type StripeReconciliationCharge = Readonly<{
  id: string;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  livemode: boolean;
  payment_intent: string;
  balance_transaction: string | StripeBalanceTransaction | null;
}>;

type StripeReconciliationIntent = StripePaymentIntent & Readonly<{
  amount_received?: number;
  latest_charge?: string | StripeReconciliationCharge | null;
}>;

type StripeReconciliationRefund = Readonly<{
  id: string;
  amount: number;
  currency: string;
  payment_intent: string;
  status: string | null;
  balance_transaction: string | StripeBalanceTransaction | null;
}>;

type StripeReconciliationDispute = Readonly<{
  id: string;
  amount: number;
  currency: string;
  payment_intent: string | null;
  charge: string;
  livemode: boolean;
  status: string;
  balance_transactions: readonly StripeBalanceTransaction[];
}>;

type StripeList<T> = Readonly<{
  data: readonly T[];
  has_more: boolean;
}>;

export type StripePaymentReconciliation = Readonly<{
  providerPaymentId: string;
  providerBalanceTransactionId: string;
  chargedCents: number;
  refundedCents: number;
  disputedCents: number;
  processingFeeCents: number;
  refundFeeCents: number;
  disputeFeeCents: number;
  otherProviderFeeCents: number;
  providerNetCents: number;
  currency: string;
  sourcePayloadSha256: string;
  observedAt: string;
}>;

function safeInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(error);
  return Number(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Limits bound a single payment's read work. Reaching a limit fails the whole
// read; the worker may retry, but must never record a partial financial total.
const reconciliationPageLimit = 100;
const reconciliationReadBudgetMilliseconds = 60_000;

async function retrieveReconciliationList<T extends Readonly<{ id: string }>>(
  request: StripeRequest,
  idPattern: RegExp,
  invalidListCode: string
): Promise<StripeList<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < reconciliationPageLimit; page += 1) {
    const value = await stripeRequest<StripeList<T>>({
      ...request,
      method: "GET",
      // Never follow a provider-supplied URL. Preserve the same payment,
      // account, expansion and API version for every page.
      path: `${request.path}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`
    });
    if (!value || typeof value !== "object" || !Array.isArray(value.data)
        || value.data.length > 100 || typeof value.has_more !== "boolean") {
      throw new Error(invalidListCode);
    }
    for (const row of value.data) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !idPattern.test(row.id)) {
        throw new Error(invalidListCode);
      }
      if (seen.has(row.id)) throw new Error("stripe_reconciliation_duplicate_object");
      seen.add(row.id);
      rows.push(row);
    }
    if (!value.has_more) {
      // Page boundaries and provider ordering are not financial facts. A
      // restarted read of the same objects must retain its dedupe identity.
      rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return { data: rows, has_more: false };
    }
    if (value.data.length === 0) throw new Error("stripe_reconciliation_pagination_stalled");
    cursor = value.data[value.data.length - 1]!.id;
  }
  throw new Error("stripe_reconciliation_page_limit_exceeded");
}

function validateBalanceTransaction(
  transaction: StripeBalanceTransaction,
  expectedSource: string,
  currency: string
): Readonly<{ providerFeeCents: number; applicationFeeCents: number }> {
  requiredMatch(transaction.id, /^txn_[A-Za-z0-9]+$/, "invalid_stripe_balance_transaction");
  if (transaction.source !== expectedSource || transaction.currency !== currency || transaction.exchange_rate != null) {
    throw new Error("stripe_balance_transaction_mismatch");
  }
  const amount = safeInteger(transaction.amount, "invalid_stripe_balance_transaction");
  const fee = safeInteger(transaction.fee, "invalid_stripe_balance_transaction");
  const net = safeInteger(transaction.net, "invalid_stripe_balance_transaction");
  safeInteger(transaction.created, "invalid_stripe_balance_transaction");
  if (fee < 0 || net !== amount - fee || !Array.isArray(transaction.fee_details)) {
    throw new Error("invalid_stripe_balance_transaction");
  }
  let applicationFeeCents = 0;
  let providerFeeCents = 0;
  for (const detail of transaction.fee_details) {
    const detailAmount = safeInteger(detail.amount, "invalid_stripe_fee_detail");
    if (detailAmount < 0 || detail.currency !== currency || typeof detail.type !== "string") {
      throw new Error("invalid_stripe_fee_detail");
    }
    if (detail.type === "application_fee") applicationFeeCents += detailAmount;
    else providerFeeCents += detailAmount;
  }
  if (applicationFeeCents + providerFeeCents !== fee) throw new Error("stripe_fee_detail_mismatch");
  return { providerFeeCents, applicationFeeCents };
}

function expandedBalanceTransaction(
  value: string | StripeBalanceTransaction | null,
  expectedSource: string,
  currency: string
): Readonly<{ transaction: StripeBalanceTransaction; providerFeeCents: number; applicationFeeCents: number }> {
  if (!value || typeof value !== "object") throw new Error("stripe_balance_transaction_unavailable");
  return { transaction: value, ...validateBalanceTransaction(value, expectedSource, currency) };
}

export async function retrieveTestCaptureDeadline(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
}>): Promise<string> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  validateMoney(input.amountCents, input.currency);
  const intent = await stripeRequest<StripeIntentWithCharge>({
    ...input,
    method: "GET",
    path: `/v1/payment_intents/${input.paymentIntentId}?expand[]=latest_charge`
  });
  validateBoundIntent(intent, input.paymentIntentId, input.amountCents, input.currency);
  const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const captureBefore = charge?.payment_method_details?.card?.capture_before;
  if (!Number.isSafeInteger(captureBefore) || Number(captureBefore) <= Math.floor(Date.now() / 1000)) {
    throw new Error("stripe_capture_deadline_unavailable");
  }
  return new Date(Number(captureBefore) * 1000).toISOString();
}

export async function retrieveTestPaymentReconciliation(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  connectedAccountId: string;
  paymentIntentId: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
  deadlineAt?: number;
}>): Promise<StripePaymentReconciliation> {
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  const now = Date.now();
  if (input.deadlineAt !== undefined && (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= now)) {
    throw new Error("stripe_reconciliation_deadline_exceeded");
  }

  const request = {
    secretKey: input.secretKey,
    apiVersion: input.apiVersion,
    connectedAccountId: input.connectedAccountId,
    idempotencyKey: input.idempotencyKey,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    deadlineAt: Math.min(now + reconciliationReadBudgetMilliseconds, input.deadlineAt ?? Infinity),
    method: "GET" as const
  };
  const intent = await stripeRequest<StripeReconciliationIntent>({
    ...request,
    path: `/v1/payment_intents/${input.paymentIntentId}?expand[]=latest_charge.balance_transaction`
  });
  requiredMatch(intent.id, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  if (intent.id !== input.paymentIntentId) throw new Error("stripe_payment_intent_mismatch");
  if (intent.livemode) throw new Error("stripe_live_mode_blocked");
  if (intent.status !== "succeeded") throw new Error(`stripe_reconciliation_unavailable_${safeProviderCode(intent.status)}`);
  const currency = requiredMatch(intent.currency, /^[a-z]{3}$/, "invalid_stripe_currency");
  const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  if (!charge) throw new Error("stripe_reconciliation_charge_unavailable");
  requiredMatch(charge.id, /^ch_[A-Za-z0-9]+$/, "invalid_stripe_charge");
  if (charge.livemode || charge.payment_intent !== intent.id || charge.currency !== currency) {
    throw new Error("stripe_reconciliation_charge_mismatch");
  }
  const chargedCents = safeInteger(charge.amount_captured, "invalid_stripe_charge");
  const chargeAmount = safeInteger(charge.amount, "invalid_stripe_charge");
  const chargeRefundedCents = safeInteger(charge.amount_refunded, "invalid_stripe_charge");
  const intentAmount = safeInteger(intent.amount, "invalid_stripe_payment_intent");
  const amountReceived = safeInteger(intent.amount_received, "invalid_stripe_payment_intent");
  if (chargedCents <= 0 || chargeAmount !== intentAmount || amountReceived !== chargedCents
      || chargeRefundedCents < 0 || chargeRefundedCents > chargedCents) {
    throw new Error("stripe_reconciliation_charge_mismatch");
  }
  const chargeBalance = expandedBalanceTransaction(charge.balance_transaction, charge.id, currency);
  if (chargeBalance.transaction.amount !== chargedCents) throw new Error("stripe_reconciliation_charge_mismatch");

  const refunds = await retrieveReconciliationList<StripeReconciliationRefund>({
    ...request,
    path: `/v1/refunds?payment_intent=${encodeURIComponent(input.paymentIntentId)}&limit=100&expand[]=data.balance_transaction`
  }, /^re_[A-Za-z0-9]+$/, "invalid_stripe_refund_list");
  let refundedCents = 0;
  let refundFeeCents = 0;
  let refundApplicationFeeCents = 0;
  const refundTransactions: StripeBalanceTransaction[] = [];
  for (const refund of refunds.data) {
    requiredMatch(refund.id, /^re_[A-Za-z0-9]+$/, "invalid_stripe_refund");
    if (refund.payment_intent !== intent.id || refund.currency !== currency) throw new Error("stripe_refund_mismatch");
    const amount = safeInteger(refund.amount, "invalid_stripe_refund");
    if (amount <= 0 || amount > chargedCents) throw new Error("invalid_stripe_refund");
    if (["pending", "requires_action"].includes(refund.status ?? "")) {
      throw new Error("stripe_reconciliation_unsettled_refund");
    }
    if (["failed", "canceled"].includes(refund.status ?? "")) continue;
    if (refund.status !== "succeeded") throw new Error("invalid_stripe_refund");
    const balance = expandedBalanceTransaction(refund.balance_transaction, refund.id, currency);
    if (balance.transaction.amount !== -amount) throw new Error("stripe_refund_balance_mismatch");
    refundedCents += amount;
    refundFeeCents += balance.providerFeeCents;
    refundApplicationFeeCents += balance.applicationFeeCents;
    refundTransactions.push(balance.transaction);
  }
  if (refundedCents !== chargeRefundedCents || refundedCents > chargedCents) {
    throw new Error("stripe_refund_total_mismatch");
  }

  const disputes = await retrieveReconciliationList<StripeReconciliationDispute>({
    ...request,
    path: `/v1/disputes?payment_intent=${encodeURIComponent(input.paymentIntentId)}&limit=100&expand[]=data.balance_transactions`
  }, /^du_[A-Za-z0-9]+$/, "invalid_stripe_dispute_list");
  let disputeGrossCents = 0;
  let disputeFeeCents = 0;
  let disputeApplicationFeeCents = 0;
  const disputeTransactions: StripeBalanceTransaction[] = [];
  for (const dispute of disputes.data) {
    requiredMatch(dispute.id, /^du_[A-Za-z0-9]+$/, "invalid_stripe_dispute");
    if (dispute.livemode || dispute.payment_intent !== intent.id || dispute.charge !== charge.id
        || dispute.currency !== currency || !Array.isArray(dispute.balance_transactions)) {
      throw new Error("stripe_dispute_mismatch");
    }
    const amount = safeInteger(dispute.amount, "invalid_stripe_dispute");
    if (amount <= 0 || amount > chargedCents) throw new Error("invalid_stripe_dispute");
    for (const transaction of dispute.balance_transactions) {
      const fees = validateBalanceTransaction(transaction, dispute.id, currency);
      disputeGrossCents += transaction.amount;
      disputeFeeCents += fees.providerFeeCents;
      disputeApplicationFeeCents += fees.applicationFeeCents;
      disputeTransactions.push(transaction);
    }
  }
  const disputedCents = -disputeGrossCents;
  if (!Number.isSafeInteger(disputedCents) || disputedCents < 0
      || refundedCents + disputedCents > chargedCents) {
    throw new Error("stripe_dispute_total_mismatch");
  }

  const allTransactions = [chargeBalance.transaction, ...refundTransactions, ...disputeTransactions];
  const allIds = allTransactions.map((transaction) => transaction.id);
  if (new Set(allIds).size !== allIds.length) throw new Error("stripe_duplicate_balance_transaction");
  const processingFeeCents = chargeBalance.providerFeeCents;
  const applicationFeeCents = chargeBalance.applicationFeeCents
    + refundApplicationFeeCents + disputeApplicationFeeCents;
  const providerFeeCents = processingFeeCents + refundFeeCents + disputeFeeCents;
  const providerNetCents = allTransactions.reduce((sum, transaction) => sum + transaction.net, 0)
    + applicationFeeCents;
  const expectedProviderNetCents = chargedCents - refundedCents - disputedCents - providerFeeCents;
  if (!Number.isSafeInteger(providerNetCents) || providerNetCents !== expectedProviderNetCents) {
    throw new Error("stripe_reconciliation_net_mismatch");
  }
  const observedAtSeconds = Math.max(...allTransactions.map((transaction) => transaction.created));
  if (!Number.isSafeInteger(observedAtSeconds) || observedAtSeconds <= 0) {
    throw new Error("invalid_stripe_reconciliation_timestamp");
  }
  const sourcePayloadSha256 = await sha256({ intent, refunds, disputes });
  if (Date.now() >= request.deadlineAt) throw new Error("stripe_reconciliation_deadline_exceeded");

  return {
    providerPaymentId: intent.id,
    providerBalanceTransactionId: chargeBalance.transaction.id,
    chargedCents,
    refundedCents,
    disputedCents,
    processingFeeCents,
    refundFeeCents,
    disputeFeeCents,
    otherProviderFeeCents: 0,
    providerNetCents,
    currency: currency.toUpperCase(),
    sourcePayloadSha256,
    observedAt: new Date(observedAtSeconds * 1000).toISOString()
  };
}

export type GroupIntentBinding = Readonly<{
  operationId: string;
  sellerOrderId: string;
  groupMemberId: string;
  connectedAccountId: string;
  amountCents: number;
  currency: string;
}>;

type GroupIntent = StripePaymentIntent & {
  object: "payment_intent";
  capture_method: "manual";
  amount_received: number;
  amount_capturable: number;
  metadata: Record<string, string>;
};

function groupMetadata(binding: GroupIntentBinding): Record<string, string> {
  return {
    pasture_pact_operation_id: binding.operationId,
    pasture_pact_seller_order_id: binding.sellerOrderId,
    pasture_pact_group_member_id: binding.groupMemberId,
    pasture_pact_account_id: binding.connectedAccountId
  };
}

export function validateGroupIntent(value: unknown, binding: GroupIntentBinding, knownId?: string): GroupIntent {
  if (!value || typeof value !== "object") throw new Error("group_provider_object_mismatch");
  const intent = value as GroupIntent;
  if (intent.object !== "payment_intent" || intent.livemode !== false || intent.capture_method !== "manual"
      || !/^pi_[A-Za-z0-9]+$/.test(intent.id) || (knownId !== undefined && intent.id !== knownId)
      || intent.amount !== binding.amountCents || intent.currency !== binding.currency.toLowerCase()
      || !Number.isSafeInteger(intent.amount_received) || intent.amount_received < 0
      || !Number.isSafeInteger(intent.amount_capturable) || intent.amount_capturable < 0
      || (["requires_payment_method", "requires_confirmation"].includes(intent.status)
        && (intent.amount_received !== 0 || intent.amount_capturable !== 0))
      || !["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture",
        "processing", "succeeded", "canceled"].includes(intent.status)
      || Object.entries(groupMetadata(binding)).some(([key, value]) => intent.metadata?.[key] !== value)) {
    throw new Error("group_provider_object_mismatch");
  }
  return intent;
}

export class GroupProviderUncertainty extends Error {
  constructor(readonly reason: "discovery_zero" | "discovery_multiple" | "discovery_incomplete" | "invalid_provider_response") {
    super(reason);
    this.name = "GroupProviderUncertainty";
  }
}

function observedGroupIntent(value: unknown, binding: GroupIntentBinding, knownId?: string): GroupIntent {
  try {
    return validateGroupIntent(value, binding, knownId);
  } catch {
    throw new GroupProviderUncertainty("invalid_provider_response");
  }
}

export async function groupIntentTransport(input: GroupIntentBinding & Readonly<{
  secretKey: string;
  apiVersion: string;
  idempotencyKey: string;
  action: "CREATE" | "READ" | "CANCEL";
  paymentIntentId?: string;
  createdFrom?: number;
  createdThrough?: number;
  assertTransport: () => Promise<void>;
  fetcher?: Fetcher;
}>): Promise<GroupIntent> {
  validateMoney(input.amountCents, input.currency);
  for (const id of [input.operationId, input.sellerOrderId, input.groupMemberId]) {
    requiredMatch(id, /^[0-9a-f-]{36}$/i, "invalid_group_operation_binding");
  }
  const deadlineAt = Date.now() + 40_000;
  const request = async (path: string, method: "GET" | "POST", body?: URLSearchParams): Promise<unknown> => {
    validateCommon(input.secretKey, input.apiVersion, input.connectedAccountId, input.idempotencyKey);
    await input.assertTransport();
    try {
      return await stripeRequest({ ...input, path, method, deadlineAt, ...(body ? { body } : {}) });
    } catch {
      // A failed request may have reached the provider; it is not evidence of absence.
      throw new GroupProviderUncertainty("discovery_incomplete");
    }
  };
  if (input.action === "CREATE") {
    if (input.paymentIntentId) throw new Error("group_known_operation_no_create");
    const body = new URLSearchParams({ amount: String(input.amountCents), currency: input.currency.toLowerCase(),
      capture_method: "manual", "payment_method_types[]": "card" });
    for (const [key, value] of Object.entries(groupMetadata(input))) body.set(`metadata[${key}]`, value);
    return observedGroupIntent(await request("/v1/payment_intents", "POST", body), input);
  }
  if (input.paymentIntentId) {
    requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
    const cancel = input.action === "CANCEL";
    const intent = observedGroupIntent(await request(`/v1/payment_intents/${input.paymentIntentId}${cancel ? "/cancel" : ""}`,
      cancel ? "POST" : "GET"), input, input.paymentIntentId);
    if (cancel && intent.status !== "canceled") throw new GroupProviderUncertainty("invalid_provider_response");
    return intent;
  }
  if (input.action !== "READ" || !Number.isSafeInteger(input.createdFrom) || !Number.isSafeInteger(input.createdThrough)
      || input.createdFrom! <= 0 || input.createdThrough! < input.createdFrom!) throw new Error("invalid_group_discovery_bounds");
  const query = new URLSearchParams({ limit: "100", "created[gte]": String(input.createdFrom),
    "created[lte]": String(input.createdThrough) });
  const matches: unknown[] = [];
  const seen = new Set<string>();
  // A capped or malformed traversal is never evidence of absence or uniqueness.
  for (let page = 0; page < 5; page++) {
    const list = await request(`/v1/payment_intents?${query}`, "GET") as {
      object?: unknown; data?: Array<{ id: string; created: number; metadata?: Record<string, string> }>; has_more?: unknown;
    };
    if (!list || list.object !== "list" || !Array.isArray(list.data) || typeof list.has_more !== "boolean"
        || list.data.length > 100 || (list.has_more && list.data.length === 0)) throw new GroupProviderUncertainty("invalid_provider_response");
    for (const item of list.data) {
      if (!item || !/^pi_[A-Za-z0-9]+$/.test(item.id) || seen.has(item.id)
          || !Number.isSafeInteger(item.created) || item.created < input.createdFrom!
          || item.created > input.createdThrough!) throw new GroupProviderUncertainty("invalid_provider_response");
      seen.add(item.id);
      if (item.metadata?.pasture_pact_operation_id === input.operationId) matches.push(item);
    }
    if (!list.has_more) {
      if (matches.length !== 1) throw new GroupProviderUncertainty(matches.length === 0 ? "discovery_zero" : "discovery_multiple");
      return observedGroupIntent(matches[0], input);
    }
    query.set("starting_after", list.data.at(-1)!.id);
  }
  throw new GroupProviderUncertainty("discovery_incomplete");
}

export async function retrieveBusinessTestPaymentIntent(input: Readonly<{
  secretKey: string;
  apiVersion: string;
  endpointId: string;
  connectedAccountId: string;
  paymentIntentId: string;
  businessSubject: BusinessPaymentSubject;
  idempotencyKey: string;
  fetcher?: Fetcher;
}>) {
  const subject = parseBusinessPaymentSubject(input.businessSubject);
  if (input.connectedAccountId !== subject.accountId || input.endpointId !== subject.endpointId) {
    throw new Error("business_payment_contract_invalid");
  }
  requiredMatch(input.paymentIntentId, /^pi_[A-Za-z0-9]+$/, "invalid_stripe_payment_intent");
  const intent = await stripeRequest<StripePaymentIntent & { amount_received: number; metadata: unknown }>({
    ...input, method: "GET", path: `/v1/payment_intents/${input.paymentIntentId}`
  });
  if (!intent || intent.livemode !== false) throw new Error("stripe_live_mode_blocked");
  validateBoundIntent(intent, input.paymentIntentId, subject.amountCents, subject.currency);
  verifyBusinessProviderMetadata(intent.metadata, subject);
  if (!Number.isSafeInteger(intent.amount_received) || intent.amount_received < 0
      || intent.amount_received > subject.amountCents
      || !["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture",
        "processing", "canceled", "succeeded"].includes(intent.status)) {
    throw new Error("business_payment_observation_invalid");
  }
  return { subject, providerId: intent.id, livemode: false as const, amount: intent.amount,
    currency: subject.currency, amountReceived: intent.amount_received, status: intent.status, source: "GET" as const };
}
