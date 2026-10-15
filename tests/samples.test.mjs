import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { normalizeAddress, isSamePropertyAddress } from '../projects/propertyvision/addressNormalizer.ts';
import { rerankResults, keywordOverlapRerank } from '../projects/taxahead/kb-reranker.ts';
import { saveSelection, readCart, clearCart, checkoutCommandId } from '../projects/pasturepact/cart.ts';

// All data is fictional. Network access fails if a test accidentally attempts it.
globalThis.fetch = async () => { throw new Error('Live network is disabled in portfolio tests'); };

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
});

test('PropertyVision: normalization is stable across case and spacing', () => {
  const normalized = normalizeAddress('  123   EXAMPLE Rd.,, Sampleville  ');
  assert.equal(normalized, '123 example rd, sampleville');
  assert.equal(normalizeAddress(normalized), normalized);
});

test('PropertyVision: aliases match but different numbers, street types, units, and ZIPs do not', () => {
  assert.equal(isSamePropertyAddress('123 Example Road, Sampleville 00000', '123 Example Rd, Sampleville 00000'), true);
  for (const other of ['124 Example Rd, Sampleville 00000', '123 Example Ct, Sampleville 00000', '123 Example Rd, Sampleville 99999']) {
    assert.equal(isSamePropertyAddress('123 Example Rd, Sampleville 00000', other), false);
  }
  assert.equal(isSamePropertyAddress('123 Example Rd Unit A', '123 Example Rd Unit B'), false);
  assert.equal(isSamePropertyAddress('', '123 Example Rd'), false);
});

test('PropertyVision: document the intentionally permissive directional and missing-unit heuristic', () => {
  assert.equal(isSamePropertyAddress('123 Example Rd NE', '123 Example Rd NW'), true);
  assert.equal(isSamePropertyAddress('123 Example Rd Unit A', '123 Example Rd'), true);
});

const results = [
  { id: 'unrelated', content: 'Garden plants and flowers', combined_score: 0.9 },
  { id: 'relevant', content: 'Document evidence search', combined_score: 0.3 },
];

test('TaxAhead: keyword fallback ranks relevant evidence first and respects topK', async () => {
  let requests = 0;
  const ranked = await rerankResults('document evidence', results, {
    apiKey: null, topK: 1, fetchImpl: async () => { requests++; throw new Error('Unexpected request'); },
  });
  assert.equal(requests, 0);
  assert.deepEqual(ranked.map(x => x.id), ['relevant']);
});

test('TaxAhead: valid provider results retain the source records and ranking', async () => {
  const ranked = await rerankResults('document evidence', results, {
    apiKey: 'fictional-test-value', topK: 2,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.top_n, 2);
      assert.deepEqual(body.documents, results.map(x => x.content));
      return Response.json({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.8 }] });
    },
  });
  assert.deepEqual(ranked.map(x => x.id), ['relevant', 'unrelated']);
  assert.equal(ranked[0].content, results[1].content);
});

test('TaxAhead: duplicate or out-of-range provider indices trigger fallback', async () => {
  for (const providerResults of [
    [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }],
    [{ index: 99, relevance_score: 0.9 }, { index: 1, relevance_score: 0.8 }],
  ]) {
    const ranked = await rerankResults('document evidence', results, {
      apiKey: 'fictional-test-value', topK: 2,
      fetchImpl: async () => Response.json({ results: providerResults }),
    });
    assert.deepEqual(ranked, keywordOverlapRerank('document evidence', results, 2));
  }
});

test('TaxAhead: a provider error returns fallback without logging its response body', async () => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    const ranked = await rerankResults('document evidence', results, {
      apiKey: 'fictional-test-value', topK: 2,
      fetchImpl: async () => new Response('fictional-private-response-marker', { status: 503 }),
    });
    assert.equal(ranked[0].id, 'relevant');
    assert.equal(messages.length, 1);
    assert.equal(messages.join('').includes('fictional-private-response-marker'), false);
  } finally { console.error = original; }
});

test('TaxAhead: stopword-only input uses retrieval scores in descending order', () => {
  const ranked = keywordOverlapRerank('the and of', [...results].reverse(), 2);
  assert.deepEqual(ranked.map(x => x.id), ['unrelated', 'relevant']);
});

const selection = {
  offeringId: 'fictional-offer', title: 'Fictional share', farmId: 'fictional-farm',
  farmName: 'Example Farm', unitPriceCents: 1000, currency: 'USD', version: 1,
  termsVersion: 'example-v1', units: 1, fulfillmentRoute: 'PROCESSOR_DIRECT',
};

test('PasturePact: demo and ordinary drafts remain separate when saved or cleared', () => {
  saveSelection(selection, true);
  assert.deepEqual(readCart(false), []);
  saveSelection({ ...selection, title: 'Separate draft' }, false);
  clearCart(true);
  assert.deepEqual(readCart(true), []);
  assert.equal(readCart(false)[0].title, 'Separate draft');
});

test('PasturePact: retrying identical checkout input reuses its command ID', () => {
  const payload = { items: [{ offeringId: 'fictional-offer', units: 1 }], buyerId: 'fictional-buyer', demo: true };
  const first = checkoutCommandId(payload);
  assert.equal(checkoutCommandId(payload), first);
  assert.notEqual(checkoutCommandId({ ...payload, demo: false }), first);
  assert.notEqual(checkoutCommandId({ ...payload, buyerId: 'another-fictional-buyer' }), first);
});

test('PasturePact: corrupted persisted JSON does not become a usable draft', () => {
  localStorage.setItem('pasturepact.cart.v1', '{broken');
  assert.deepEqual(readCart(), []);
  localStorage.setItem('pasturepact.cart.v1', JSON.stringify([{ ...selection, units: 3 }]));
  assert.deepEqual(readCart(), []);
});

test('PasturePact: malformed command state is replaced with a reusable identifier', () => {
  localStorage.setItem('pasturepact.checkout-command.v1', '{broken');
  const id = checkoutCommandId({ demo: true });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(checkoutCommandId({ demo: true }), id);
});
