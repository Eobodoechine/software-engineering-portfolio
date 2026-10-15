const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function sha256(raw: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(raw)));
}

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): Promise<void> {
  const fields = signatureHeader.split(",").map((part) => part.trim().split("="));
  const timestamps = fields.filter(([key]) => key === "t");
  const timestampField = timestamps[0];
  if (timestamps.length !== 1 || !timestampField || timestampField.length !== 2
      || !/^\d+$/.test(timestampField[1] ?? "")) {
    throw new Error("invalid_stripe_signature_header");
  }
  const timestamp = Number(timestampField[1]);
  const signatures = fields.flatMap(([key, value, extra]) =>
    key === "v1" && extra === undefined && value !== undefined && /^[0-9a-f]{64}$/.test(value) ? [value] : []
  );
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) throw new Error("invalid_stripe_signature_header");
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) throw new Error("stale_stripe_signature");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampField[1]}.${rawBody}`)));
  if (!signatures.some((candidate) => timingSafeEqual(candidate, expected))) throw new Error("invalid_stripe_signature");
}
