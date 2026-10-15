# PasturePact — transactional checkout and payment work

[Demo](https://pasturepact.netlify.app/demo) · [Browse the selected source](source/)

I built PasturePact in one month while working with its founder. This farm-direct marketplace remains in development, awaiting founder go-to-market. The public demo is in test mode and collects no real payment. These selected complete source files are shared with permission.

## What is included

The [source/](source/) folder contains 16 files: two Edge Function handlers, nine shared modules, two SQL migrations, and three test files. Together they expose checkout submission, database transaction logic, background payment work, provider recovery, signature validation, and the supporting request/configuration helpers. The backend uses TypeScript, Supabase/PostgreSQL, and Stripe integrations.

The earlier [cart.ts](cart.ts) and [types.ts](types.ts) excerpts remain here for browser-cart state and its contracts. The backend reading order below follows the larger source selection.

## Read a checkout through the backend

1. [create-checkout/index.ts](source/supabase/functions/create-checkout/index.ts) takes a user-scoped request, maps the cart contract, requires an idempotency key, and invokes the checkout transaction.
2. [quote checkout binding](source/supabase/migrations/20260926000700_quote_checkout_binding.sql) contains the transaction wrapper. It locks a command, returns an existing receipt for a replay, checks the accepted quote against current data, locks offerings in a fixed order, validates totals, and records the response. The [earlier buyer-checkout migration](source/supabase/migrations/20260917000500_buyer_checkout_v2.sql) shows terms acceptance, inventory holds, order persistence, and outbox work.
3. [payment-worker/index.ts](source/supabase/functions/payment-worker/index.ts) processes the outbox. Read how stored configuration and credential generation are resolved before jobs are claimed and provider operations admitted.
4. [group-provider-operation.ts](source/supabase/functions/_shared/group-provider-operation.ts) and [stripe-api.ts](source/supabase/functions/_shared/stripe-api.ts) show how uncertain outcomes are recovered and provider identity is checked before completing an operation.
5. [stripe-signature.ts](source/supabase/functions/_shared/stripe-signature.ts) validates the original body, signature, and timestamp. [Its tests](source/tests/stripe-signature.test.ts) include altered bodies, wrong keys, malformed timestamps, rotation, and expired signatures.
6. [Worker configuration tests](source/tests/payment-worker-stored-config.test.ts) and [operation recovery tests](source/tests/group-provider-operation.test.ts) run actual modules against fake database/provider boundaries.

## Why these choices matter

An idempotency key identifies a repeated command so a retry can receive its earlier result. Database locks and quote-version checks keep the accepted price tied to the order. The outbox separates transactional order creation from provider calls. Recovery code treats an uncertain provider response as something to reconcile, rather than permission to create another payment.

## Run the included tests

From the portfolio root, with Node.js 22.18+ and npm installed:

```sh
npm ci
npm run test:backend
```

The recorded October 15, 2026 run passed **70 tests across three files**, covering signature validation, stored payment-worker configuration, and group-operation recovery. The tests import the actual selected modules and replace database/provider I/O with controlled fakes. `npm run check` also runs the source-hash checks and the 19 original utility tests across the portfolio, including the cart examples.

## Publication scope

The SQL files are selected migrations with dependencies on the private schema; they are not a standalone database installation. Code and mock tests do not prove a completed live purchase. Test commands and results are in [VERIFICATION.md](../../VERIFICATION.md).
