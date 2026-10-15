const configuredOrigin = Deno.env.get("APP_ORIGIN") ?? "https://pasturepact.netlify.app";
const localOrigins = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);

export function corsHeaders(request: Request): HeadersInit | null {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  if (origin !== configuredOrigin && !localOrigins.has(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type, idempotency-key, x-client-info",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin"
  };
}
