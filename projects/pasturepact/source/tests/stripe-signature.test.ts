import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../supabase/functions/_shared/stripe-signature";

const secret = "whsec_fictional_wave_a_only";
const payload = JSON.stringify({ id: "evt_FictionalWaveA", livemode: false });
const sign = (timestamp: number, body = payload, key = secret) =>
  createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

describe("deployed Stripe signature verifier (real crypto, no provider or database)", () => {
  it("accepts the current signature and signing-key rotation", async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(verifyStripeSignature(payload, `t=${t},v1=${sign(t)}`, secret)).resolves.toBeUndefined();
    await expect(verifyStripeSignature(payload,
      `t=${t},v1=${sign(t, payload, "old-key")},v1=${sign(t)}`, secret)).resolves.toBeUndefined();
  });

  it("rejects body tampering, wrong key, and missing signature", async () => {
    const t = Math.floor(Date.now() / 1000);
    const header = `t=${t},v1=${sign(t)}`;
    await expect(verifyStripeSignature(`${payload} `, header, secret)).rejects.toThrow("invalid_stripe_signature");
    await expect(verifyStripeSignature(payload, header, "wrong-key")).rejects.toThrow("invalid_stripe_signature");
    await expect(verifyStripeSignature(payload, `t=${t}`, secret)).rejects.toThrow("invalid_stripe_signature_header");
  });

  it("rejects leading-zero timestamp tampering", async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(verifyStripeSignature(payload, `t=0${t},v1=${sign(t)}`, secret))
      .rejects.toThrow("invalid_stripe_signature");
  });

  it.each([-600, 600])("rejects a correctly signed timestamp offset %i seconds", async (offset) => {
    const t = Math.floor(Date.now() / 1000) + offset;
    await expect(verifyStripeSignature(payload, `t=${t},v1=${sign(t)}`, secret))
      .rejects.toThrow("stale_stripe_signature");
  });

  it.each(["plus", "decimal", "exponent", "duplicate", "suffix"])(
    "rejects malformed or ambiguous timestamp: %s", async (kind) => {
      const t = Math.floor(Date.now() / 1000);
      const timestamp = {
        plus: `+${t}`, decimal: `${t}.0`, exponent: `${t}e0`,
        duplicate: `${t},t=${t + 1}`, suffix: `${t}=ignored`,
      }[kind];
      await expect(verifyStripeSignature(payload, `t=${timestamp},v1=${sign(t)}`, secret))
        .rejects.toThrow("invalid_stripe_signature_header");
    },
  );
});
