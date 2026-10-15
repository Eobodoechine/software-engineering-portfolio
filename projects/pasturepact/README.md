# PasturePact

[Public site](https://pasturepact.netlify.app/) · [Fictional listing demo](https://pasturepact.netlify.app/demo) · [Code sample](cart.ts)

I worked with PasturePact's founder. The demo and selected source sample are shared with permission.

PasturePact is a farm-direct marketplace prototype. Its web package uses React, TypeScript, TanStack Start, and Supabase.

**Current status:** Work in progress, awaiting the founder's go-to-market launch. The deployed homepage and fictional listing demo are public. The homepage identifies the environment as test mode and says no real payment is collected.

## Selected code

The browser module stores cart drafts separately for demo and ordinary use. It handles unreadable stored JSON and filters malformed selections. It also retains a checkout command identifier for an identical serialized payload, allowing a caller to reuse that identifier when retrying after a lost response.

The sample includes only the TypeScript declarations needed for the cart. It does not include customer data, payment credentials, production configuration, or the private repository history.

The tests check mode separation, draft clearing, retry identifier reuse, changes in buyer or mode, and corrupted stored values. Test storage is an in-memory substitute.

These are client-side mechanisms. They do not prove server-side order validation, payment deduplication, or completed purchases. Equality uses serialized JSON, so callers must construct equivalent payloads consistently.

