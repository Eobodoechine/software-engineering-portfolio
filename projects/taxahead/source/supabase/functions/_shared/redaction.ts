const SENSITIVE_KEY =
  /(authorization|cookie|token|secret|password|credential|card|cvc|expiry|ssn|taxpayer|email|document|payload|content|raw|w2|1099)/i;
const PATTERNS: RegExp[] = [
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+\b/g,
  /\bwhsec_[A-Za-z0-9_-]+\b/g,
  /\b(?:access|refresh)[_-]?token\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

export function redactText(value: string): string {
  let result = value.slice(0, 1000);
  for (const pattern of PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
}

export function sanitizeLogValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 4) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => sanitizeLogValue(item, "", depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[childKey] = sanitizeLogValue(child, childKey, depth + 1);
    }
    return output;
  }
  return String(value);
}
