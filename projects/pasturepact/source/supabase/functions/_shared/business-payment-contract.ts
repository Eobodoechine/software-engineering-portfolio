export type BusinessPaymentSubject = Readonly<{
  subjectType: "BUSINESS_ORDER";
  businessOrderId: string;
  purchaseId: string;
  revisionHash: string;
  termsHash: string;
  amountCents: number;
  currency: "USD";
  configurationId: string;
  namespaceId: string;
  accountId: string;
  endpointId: string;
  experienceMode: "DEMO";
  paymentTarget: "DEMO_TEST";
  operationId: string;
  attemptId: string;
  idempotencyKey: string;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const subjectKeys = ["subjectType", "businessOrderId", "purchaseId", "revisionHash", "termsHash", "amountCents",
  "currency", "configurationId", "namespaceId", "accountId", "endpointId", "experienceMode", "paymentTarget",
  "operationId", "attemptId", "idempotencyKey"] as const;

function fail(): never { throw new Error("business_payment_contract_invalid"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return fail();
  return result;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function version(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseBusinessPaymentSubject(value: unknown): BusinessPaymentSubject {
  const s = object(value, subjectKeys);
  if (s.subjectType !== "BUSINESS_ORDER" || s.currency !== "USD" || s.experienceMode !== "DEMO" || s.paymentTarget !== "DEMO_TEST"
    || ![s.businessOrderId, s.purchaseId, s.configurationId, s.namespaceId, s.operationId, s.attemptId].every(v => matches(v, uuid))
    || !matches(s.revisionHash, hash) || !matches(s.termsHash, hash)
    || !version(s.amountCents) || s.amountCents < 50 || s.amountCents > 99999999
    || !matches(s.accountId, /^acct_[A-Za-z0-9]+$/) || !matches(s.endpointId, /^[A-Za-z0-9_-]{1,255}$/)
    || s.idempotencyKey !== `pasturepact:business-operation:${s.operationId}`) return fail();
  return Object.freeze({ ...s }) as BusinessPaymentSubject;
}

const states = ["PREPARED", "DISPATCHED", "ATTACHED", "ABANDONED", "CANCEL_REQUIRED", "RECONCILE_REQUIRED"] as const;
export type BusinessOperationState = typeof states[number];
function state(value: unknown): BusinessOperationState {
  if (!states.some(s => s === value)) return fail();
  return value as BusinessOperationState;
}
export function parseBusinessPreparation(value: unknown) {
  const p = object(value, ["subject", "executionVersion", "state"]);
  if (!version(p.executionVersion)) return fail();
  return { subject: parseBusinessPaymentSubject(p.subject), executionVersion: p.executionVersion, state: state(p.state) };
}
export type BusinessDispatch =
  | { mode: "STOP"; state: BusinessOperationState }
  | { mode: "CREATE"; state: "DISPATCHED"; executionVersion: number; subject: BusinessPaymentSubject };
export function parseBusinessDispatch(value: unknown): BusinessDispatch {
  if (value && typeof value === "object" && "mode" in value && value.mode === "STOP") {
    const p = object(value, ["mode", "state"]);
    return { mode: "STOP", state: state(p.state) };
  }
  const p = object(value, ["mode", "state", "executionVersion", "subject"]);
  if (p.mode !== "CREATE" || p.state !== "DISPATCHED" || !version(p.executionVersion)) return fail();
  return { mode: "CREATE", state: "DISPATCHED", executionVersion: p.executionVersion, subject: parseBusinessPaymentSubject(p.subject) };
}

export function businessProviderMetadata(subject: BusinessPaymentSubject): Record<string, string> {
  const parsed = parseBusinessPaymentSubject(subject);
  return Object.fromEntries(subjectKeys.map(key => [key, String(parsed[key])]));
}

export function parseBusinessProviderObservation(value: unknown, expected: BusinessPaymentSubject) {
  const p = object(value, ["subject", "providerId", "livemode", "status"]);
  const subject = parseBusinessPaymentSubject(p.subject);
  const canonical = parseBusinessPaymentSubject(expected);
  if (subjectKeys.some(key => subject[key] !== canonical[key]) || p.livemode !== false
    || !matches(p.providerId, /^pi_[A-Za-z0-9]+$/)
    || typeof p.status !== "string"
    || !["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "succeeded", "canceled"].includes(p.status)) return fail();
  return { subject, providerId: p.providerId, livemode: false as const, status: p.status };
}

// Metadata is checked against the stored subject, never used to invent local authority.
export function verifyBusinessProviderMetadata(value: unknown, expected: BusinessPaymentSubject): void {
  const metadata = object(value, subjectKeys);
  const canonical = businessProviderMetadata(expected);
  if (subjectKeys.some(key => metadata[key] !== canonical[key])) fail();
}
