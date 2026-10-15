import { corsHeaders } from "../_shared/cors.ts";
import { json, readJson, requireMethod } from "../_shared/http.ts";
import { userClient } from "../_shared/supabase.ts";

type CheckoutBody = {
  items?: Array<{ offeringId?: string; units?: number; expectedVersion?: number; termsVersion?: string; fulfillmentRoute?: string; acceptedQuoteId?: string }>;
  destinationPostalCode?: string;
  holdMinutes?: number;
};

Deno.serve(async (request) => {
  const cors = corsHeaders(request);
  if (!cors) return json({ error: "origin_not_allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const methodError = requireMethod(request, "POST");
  if (methodError) return methodError;
  try {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey?.match(/^[0-9a-f-]{36}$/i)) return json({ error: "valid_idempotency_key_required" }, 400, cors);
    const body = await readJson(request) as CheckoutBody;
    const checkoutClient = userClient(request);
    const items = Array.isArray(body.items) ? body.items.map((item) => ({
      offering_id: item.offeringId, units: item.units,
      expected_version: item.expectedVersion, terms_version: item.termsVersion,
      fulfillment_route: item.fulfillmentRoute, accepted_quote_id: item.acceptedQuoteId
    })) : body.items;
    const { data, error } = await checkoutClient.rpc("start_multi_farm_checkout_v3", {
      p_items: items,
      p_destination_postal_code: body.destinationPostalCode,
      p_hold_minutes: body.holdMinutes ?? 20,
      p_idempotency_key: idempotencyKey,
      p_request_sha256: null
    });
    if (error) return json({ error: "checkout_rejected", code: error.code, detail: error.message }, 409, cors);
    return json(data, 201, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message === "authorization_required" ? 401
      : message === "request_too_large" ? 413 : 400;
    return json({ error: message }, status, cors);
  }
});
