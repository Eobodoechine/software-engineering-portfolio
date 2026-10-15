import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

// Replace only external database I/O; exercise the actual handler and lane resolver.
const database = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../supabase/functions/_shared/supabase.ts', () => ({ serviceClient: () => database }));
const environment: Record<string, string> = {};
let handler: (request: Request) => Promise<Response>;
const config = '92000000-0000-0000-0000-000000000001';
const retained = '92000000-0000-0000-0000-000000000003';
const credential = '92000000-0000-0000-0000-000000000002';
const fetcher = vi.fn();
let denied = '';
let rowConfiguration = config;
let jobs: unknown[] = [];
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (name: string) => environment[name] }, serve: (fn: typeof handler) => { handler = fn; } });
  vi.stubGlobal('fetch', fetcher);
  await vi.importActual('../supabase/functions/payment-worker/index.ts');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, { SUPABASE_URL: 'http://127.0.0.1:54321', PAYMENT_WORKER_SECRET: 'worker-secret',
    PAYMENT_TARGET: 'DEMO_TEST', PROVIDER_CONFIGURATION_VERSION_ID: config,
    PROVIDER_NAMESPACE_ID: '92000000-0000-0000-0000-000000000004', PROVIDER_WEBHOOK_ENDPOINT_ID: 'we_fixture',
    STRIPE_EXPECTED_LIVEMODE: 'false', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_fixture',
    DEMO_STRIPE_SECRET_KEY_V2: 'sk_test_fixture' });
  denied = ''; rowConfiguration = config; jobs = []; fetcher.mockReset(); database.rpc.mockReset(); database.from.mockReset();
  database.rpc.mockImplementation(async (name: string) => {
    if (name === denied) return { data: false, error: { code: '42501' } };
    if (name === 'claim_group_provider_recovery_v1') return { data: [], error: null };
    if (name === 'resolve_stripe_configuration_v1') return { data: {
      target: 'DEMO_TEST', configurationVersionId: rowConfiguration,
      credentialVersionId: credential, credentialGeneration: 2,
      signingSecretName: 'STRIPE_CONNECT_WEBHOOK_SECRET',
      secretName: 'DEMO_STRIPE_SECRET_KEY_V2', apiVersion: '2026-08-26.dahlia'
    }, error: null };
    if (name === 'claim_provider_outbox_jobs_v1') return { data: jobs, error: null };
    if (['assert_provider_credential_v1', 'assert_provider_job_lane_v1', 'complete_outbox_job_v1'].includes(name)) return { data: true, error: null };
    throw Error(`unexpected_rpc_${name}`);
  });
});
function request(headers: Record<string, string> = {}) {
  return handler(new Request('http://localhost/functions/v1/payment-worker', { method: 'POST', headers: { 'x-worker-secret': 'worker-secret', ...headers } }));
}
it('uses stored lane and credential generation for local Stripe claims', async () => {
  expect((await request()).status).toBe(200);
  expect(database.rpc).toHaveBeenCalledWith('assert_provider_credential_v1', {
    p_provider_configuration_version_id: config, p_provider_credential_version_id: credential, p_generation: 2 });
  expect(database.rpc).toHaveBeenCalledWith('claim_provider_outbox_jobs_v1', expect.objectContaining({
    p_payment_target: 'DEMO_TEST', p_provider_configuration_version_id: config, p_lease_seconds: 300 }));
});
it('allows explicit retained configuration rather than forcing the current admission version', async () => {
  rowConfiguration = retained;
  expect((await request({ 'x-provider-configuration-version': retained })).status).toBe(200);
  expect(database.rpc).toHaveBeenCalledWith('resolve_stripe_configuration_v1', expect.objectContaining({ p_configuration_id: retained }));
});
it.each(['PROVIDER_NAMESPACE_ID', 'PROVIDER_WEBHOOK_ENDPOINT_ID', 'DEMO_STRIPE_SECRET_KEY_V2'])('fails closed without %s', async name => {
  delete environment[name]; expect((await request()).status).toBe(503);
  expect(database.rpc.mock.calls.some(([name]) => String(name).startsWith('claim_') && name !== 'claim_group_provider_recovery_v1')).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['LOCAL_FAKE_PAYMENT_TARGET', 'LOCAL_FAKE_CONFIGURATION_ID'])('rejects contradictory fake selector %s', async name => {
  environment[name] = 'fixture'; expect((await request()).status).toBe(503); expect(database.rpc).not.toHaveBeenCalled();
});
it('rejects a contradictory target before normal outbox claiming', async () => {
  expect((await request({ 'x-provider-target': 'REAL_TEST' })).status).toBe(503);
  expect(database.rpc.mock.calls.some(([name]) => String(name).startsWith('claim_') && name !== 'claim_group_provider_recovery_v1')).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects a mismatched resolved configuration', async () => {
  rowConfiguration = retained; expect((await request()).status).toBe(503);
  expect(database.rpc.mock.calls.some(([name]) => String(name).startsWith('claim_') && name !== 'claim_group_provider_recovery_v1')).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects revoked credentials before normal outbox claiming', async () => {
  denied = 'assert_provider_credential_v1'; expect((await request()).status).toBe(503);
  expect(database.rpc.mock.calls.some(([name]) => String(name).startsWith('claim_') && name !== 'claim_group_provider_recovery_v1')).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['stale', 'foreign'])('fences %s claims before any provider effect', async reason => {
  jobs = [{ id: credential, kind: 'CREATE_PAYMENT', claim_version: 3, experience_mode: 'DEMO',
    provider_configuration_version_id: reason === 'foreign' ? retained : config, payload: {} }];
  if (reason === 'stale') denied = 'assert_provider_job_lane_v1';
  const response = await request(); expect(response.status).toBe(200);
  expect((await response.json()).results[0].ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled(); expect(database.from).not.toHaveBeenCalled();
});
it('checks worker authorization before resolving credentials', async () => {
  expect((await request({ 'x-worker-secret': 'wrong' })).status).toBe(401);
  expect(database.rpc).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('creates exact cents on the stored account/API and attaches the same intent', async () => {
  const orderId = '92000000-0000-0000-0000-000000000005';
  jobs = [{ id: credential, kind: 'CREATE_PAYMENT', claim_version: 3, experience_mode: 'DEMO',
    provider_configuration_version_id: config, dedupe_key: 'stored-household', payload: { seller_order_id: orderId } }];
  database.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ error: null, data: {
    id: orderId, group_order_id: null, status: 'PENDING_PAYMENT', total_cents: 1650, platform_fee_cents: 0,
    currency: 'USD', stripe_connected_account_id: 'acct_fixture', payment_provider: 'STRIPE'
  } }) }) }) });
  const original = database.rpc.getMockImplementation()!;
  database.rpc.mockImplementation((name, args) => name === 'attach_payment_attempt_v2'
    ? Promise.resolve({ data: true, error: null }) : original(name, args));
  fetcher.mockResolvedValue(new Response(JSON.stringify({ id: 'pi_fixture', status: 'requires_payment_method',
    livemode: false, amount: 1650, currency: 'usd' }), { status: 200 }));
  const response = await request();
  expect((await response.json()).results[0].ok).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://api.stripe.com/v1/payment_intents');
  const headers = new Headers(init.headers);
  expect(headers.get('stripe-account')).toBe('acct_fixture');
  expect(headers.get('stripe-version')).toBe('2026-08-26.dahlia');
  expect(headers.get('authorization')).toBe('Bearer sk_test_fixture');
  expect(headers.get('idempotency-key')).toBe('pasturepact:create:stored-household');
  expect(new URLSearchParams(init.body).get('amount')).toBe('1650');
  expect(database.rpc).toHaveBeenCalledWith('attach_payment_attempt_v2', {
    p_seller_order_id: orderId, p_provider: 'STRIPE', p_provider_payment_id: 'pi_fixture', p_capture_before: null });
});

it('routes recovery before retired active configuration resolution', async () => {
  denied = 'resolve_stripe_configuration_v1';
  const response = await request({ 'x-payment-worker-mode': 'group-recovery' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ claimed: 0, results: [] });
  expect(database.rpc).toHaveBeenCalledWith('claim_group_provider_recovery_v1', expect.objectContaining({ p_limit: 1 }));
  expect(database.rpc).not.toHaveBeenCalledWith('resolve_stripe_configuration_v1', expect.anything());
  expect(database.rpc).not.toHaveBeenCalledWith('claim_provider_outbox_jobs_v1', expect.anything());
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects unknown recovery mode before any RPC', async () => {
  expect((await request({ 'x-payment-worker-mode': 'create-retired' })).status).toBe(503);
  expect(database.rpc).not.toHaveBeenCalled();
});

it.each([false, true])('runs recovery before normal configuration resolution (denied: %s)', async deniedResolution => {
  if (deniedResolution) denied = 'resolve_stripe_configuration_v1';
  const response = await request();
  expect(response.status).toBe(deniedResolution ? 503 : 200);
  expect(await response.json()).toEqual(deniedResolution
    ? { error: 'provider_mapping_unavailable', recovery: { claimed: 0, results: [] } }
    : { claimed: 0, results: [], recovery: { claimed: 0, results: [] } });
  expect(database.rpc).toHaveBeenNthCalledWith(1, 'claim_group_provider_recovery_v1', {
    p_worker_id: expect.stringMatching(/^local-worker-/),
    p_namespace_id: environment.PROVIDER_NAMESPACE_ID, p_endpoint_id: 'we_fixture', p_limit: 1 });
  expect(database.rpc).toHaveBeenNthCalledWith(2, 'resolve_stripe_configuration_v1', {
    p_configuration_id: config, p_namespace_id: environment.PROVIDER_NAMESPACE_ID, p_endpoint_id: 'we_fixture' });
  if (deniedResolution) expect(database.rpc).not.toHaveBeenCalledWith('claim_provider_outbox_jobs_v1', expect.anything());
  expect(fetcher).not.toHaveBeenCalled();
});

it('reports recovery failure instead of masking it with successful normal dispatch', async () => {
  denied = 'claim_group_provider_recovery_v1';
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ claimed: 0, results: [], recovery: { error: 'group_recovery_unavailable' } });
  expect(database.rpc).toHaveBeenNthCalledWith(1, 'claim_group_provider_recovery_v1', expect.objectContaining({ p_limit: 1 }));
  expect(database.rpc).toHaveBeenNthCalledWith(2, 'resolve_stripe_configuration_v1', expect.objectContaining({ p_configuration_id: config }));
  expect(fetcher).not.toHaveBeenCalled();
});

it('runs stored worker admission without webhook or publishable credentials', async () => {
  delete environment.STRIPE_CONNECT_WEBHOOK_SECRET;
  const response = await request();
  expect(response.status).toBe(200);
  expect(database.rpc).toHaveBeenCalledWith('resolve_stripe_configuration_v1', expect.any(Object));
  expect(database.rpc).toHaveBeenCalledWith('claim_provider_outbox_jobs_v1', expect.any(Object));
  expect(fetcher).not.toHaveBeenCalled();
});
it('still requires a signing secret for callback endpoint admission', async () => {
  delete environment.STRIPE_CONNECT_WEBHOOK_SECRET;
  const { stripeEndpoint } = await import('../supabase/functions/_shared/provider-lane.ts');
  expect(() => stripeEndpoint()).toThrow('missing_stripe_connect_webhook_secret');
});
