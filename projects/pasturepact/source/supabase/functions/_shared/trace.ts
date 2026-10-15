// Exact-line, redacted, verdict-neutral tracing for the money path.
//
// Every emitted line names the source location that produced it (`<file>:<line>:<fn>`), so a run
// artifact points at the exact line behind a value, a refusal or a failure instead of only a summary.
// Failures additionally carry the redacted JS stack, which holds the exact throwing line.
//
// Rules that keep this purely additive and safe:
//  - nothing here can throw: every helper swallows its own errors, and the accumulator never decides
//    a stage, a lease, a provider call or a verdict;
//  - no line records credentials, card data, tokens, request bodies or header values — only redacted
//    text, key names, codes and source locations. Redaction reaches every string *leaf* of a `data`
//    payload, so a credential inside a nested object or array cannot slip past the scrubbers;
//  - the payload walk is bounded: depth, node count and entries-per-container each stop growing, and
//    the overflow becomes a placeholder instead of a dump;
//  - recorded lines are frozen, so a trace artifact cannot be rewritten after the fact. The
//    `lines` getter returns a copy; call `clear()` to rotate between run parts
//    (see scripts/w09-cut-same-order-proof.mjs:137);
//  - the accumulator is bounded so a runaway loop cannot grow a response, and a run that reaches the cap
//    says so inside its own lines, not only in memory the process throws away.

const SCRUB: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "PRIVATE_KEY"],
  [/pi_[A-Za-z0-9]+_secret_[A-Za-z0-9_]+/g, "CLIENT_SECRET"],
  [/_secret_[A-Za-z0-9_]+/g, "_secret_REDACTED"],
  [/\b(?:sk|rk|pk|pp)_(?:live|test)_[A-Za-z0-9_]+/gi, "PROVIDER_KEY"],
  [/\bwhsec_[A-Za-z0-9]+/g, "WEBHOOK_SECRET"],
  [/\b(?:\d[ -]?){13,18}\d\b/g, "CARD_NUMBER"],
  // Superset of the previous `(postgresql?:\/\/)` rule, which matched only `postgresq`/`postgresql` and
  // so left the bare `postgres://` scheme — what psql and Supabase actually print — with its password.
  // The userinfo class is `[^\s:@/]+:[^\s@/]+`, which cannot span a literal `@`, so a password printed
  // with an unencoded `@` lost only its head and left the rest in the clear. Per RFC 3986 an `@` inside
  // userinfo must be percent-encoded, so everything before the LAST `@` of the authority is userinfo:
  // the class now allows `@` while still refusing whitespace, `/`, `?` and `#`, which keeps the match
  // inside the authority and leaves a userinfo-free conninfo — and any `@` in prose, a path or a query
  // after it — byte-identical.
  [/((?:postgresql|postgresq|postgres):\/\/)[^/?#\s]*@/gi, "$1REDACTED@"],
];

export function redactTrace(text: unknown): string {
  let out: string;
  try {
    out = String(text);
  } catch { return "UNSTRINGIFIABLE"; } // null-prototype and exotic values must not throw into the caller
  for (const [pattern, replacement] of SCRUB) out = out.replaceAll(pattern, replacement);
  return out.length > 4000 ? `${out.slice(0, 4000)}…` : out;
}

// Bounds for the payload walk. They are generous enough that no real diagnostic payload is touched — a
// database row of 100 columns at nesting depth 3 stays whole — and tight enough that a cyclic, very deep
// or very wide payload becomes a placeholder rather than an unbounded dump.
const TRACE_MAX_DEPTH = 6;
const TRACE_MAX_NODES = 2048;
const TRACE_MAX_ENTRIES = 128;
const TRACE_CYCLE = "[trace_cycle]";
const TRACE_TRUNCATED = "[trace_truncated]";
const TRACE_UNREADABLE = "[trace_unreadable]";
const TRACE_UNSUPPORTED = "[trace_unsupported:";
const TRACE_MAX_LINE_BYTES = 64 * 1024;
const TRACE_LIMIT_CEILING = 1000;

// `Object.freeze` is shallow, so the walker freezes every container as it returns it. Only containers the
// tracer built itself are ever frozen: the recorded line is a copy, so a caller keeps full use of the
// objects it passed in, and a recorded line cannot be rewritten after the run.
function freeze<T>(value: T): T {
  return Object.freeze(value) as T;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || Object.getPrototypeOf(proto) === null; // a bare bag, or Object.prototype
}

function typeTag(value: object): string {
  try {
    return Object.prototype.toString.call(value).slice(8, -1) || "object"; // "[object Date]" -> "Date"
  } catch { return "object"; }
}

function redactUnsupported(value: unknown): string {
  const type = typeof value;
  // A bigint is JSON-hostile (`JSON.stringify` throws on it), so it becomes its digits; a function or a
  // symbol becomes a type tag only, because rendering either one could dump source into an artifact.
  if (type === "bigint") return redactTrace(String(value));
  return `${TRACE_UNSUPPORTED}${type}]`;
}

// Redact every string leaf of a `data` value, at any depth. `redactTrace` only takes a string, so a
// credential handed to the recorder inside an object or an array used to be stored verbatim and written
// straight to disk by the sink. Containers are rebuilt as fresh frozen copies; non-string scalars, null,
// key order and depth survive.
function redactLeaves(
  value: unknown,
  depth: number,
  ancestors: unknown[],
  state: { nodes: number },
): unknown {
  if (typeof value === "string") return redactTrace(value);
  if (value === null) return null;
  if (value === undefined) return undefined; // an array hole stays a hole: `JSON.stringify` renders it as null
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return redactUnsupported(value);
  if (ancestors.includes(value)) return TRACE_CYCLE;
  if (depth >= TRACE_MAX_DEPTH || state.nodes >= TRACE_MAX_NODES) return TRACE_TRUNCATED;
  state.nodes += 1;
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index >= TRACE_MAX_ENTRIES) { items.push(TRACE_TRUNCATED); break; }
        items.push(redactLeaves(value[index], depth + 1, ancestors, state));
      }
      return freeze(items);
    }
    if (!isPlainObject(value)) return `${TRACE_UNSUPPORTED}${typeTag(value)}]`;
    let keys: string[];
    try { keys = Object.keys(value); } catch { return TRACE_UNREADABLE; } // a proxy that refuses to be listed
    const detail: Record<string, unknown> = {};
    const kept = keys.slice(0, TRACE_MAX_ENTRIES);
    for (const key of kept) {
      const redactedKey = redactTrace(key);
      let child: unknown;
      try { child = (value as Record<string, unknown>)[key]; } catch { detail[redactedKey] = TRACE_UNREADABLE; continue; }
      if (child === undefined) continue;
      detail[redactedKey] = redactLeaves(child, depth + 1, ancestors, state);
    }
    if (keys.length > kept.length) detail[TRACE_TRUNCATED] = TRACE_TRUNCATED;
    return freeze(detail);
  } finally {
    ancestors.pop();
  }
}

export type TraceLine = Readonly<{ at: string; src: string; event: string; data?: Record<string, unknown>; error?: string; stack?: string[] }>;

const TRACER_MODULE = /^trace\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SCRIPT_FILE = /\.(?:tsx|jsx|ts|mts|cts|js|mjs|cjs)$/;
const REAL_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

type Frame = Readonly<{ file: string; line: string; name: string }>;

// One stack frame -> `{ file, line, name }`, or null when the frame cannot name a decision site.
// Handles the Node ESM (`file:///…mjs:12:5`), Deno/Edge (`file:///…index.ts:867:20`, no function
// slot), Vitest (`/abs/…test.ts:41:7`, `Object.<anonymous>`, `?v=` queries) and `-e`/REPL (`[eval1]`)
// forms.
function parseFrame(raw: string): Frame | null {
  const frame = raw.trim();
  if (!frame) return null;
  const body = frame.startsWith("at ") ? frame.slice(3).trim() : frame;
  const open = body.lastIndexOf(" (");
  let name = "";
  let location = body;
  if (open > 0 && body.endsWith(")")) {
    name = body.slice(0, open).replace(/^(?:async|new|get|set)\s+/, "");
    location = body.slice(open + 2, -1);
  }
  const located = location.match(/^(.*):(\d+):(\d+)$/);
  if (!located) return null;
  const rawPath = located[1] ?? "";
  const line = located[2] ?? "";
  if (!rawPath || !line) return null;
  const path = rawPath.split(/[?#]/)[0] ?? rawPath; // drop a bundler query/hash before naming the file
  if (!path || path.startsWith("node:")) return null;
  const file = path.replace(/^.*[/\\]/, "");
  if (TRACER_MODULE.test(file)) return null; // never attribute a line to the logger itself
  if (!SCRIPT_FILE.test(path) && !file.startsWith("[eval")) return null;
  return { file, line, name: REAL_NAME.test(name) ? name : "" };
}

// `skipFrames` is consumed only by frames that could name a decision site, so a caller's explicit skip
// is never inflated by the tracer's own or by runtime-internal frames.
export function sourceFromFrames(frames: readonly string[], skipFrames = 0): string {
  try {
    let skipped = 0;
    for (const raw of frames) {
      const frame = parseFrame(raw);
      if (!frame) continue;
      if (skipped < skipFrames) { skipped += 1; continue; }
      return frame.name ? `${frame.file}:${frame.line}:${frame.name}` : `${frame.file}:${frame.line}`;
    }
  } catch { /* fall through to the last-resort fallback */ }
  return "unknown:0";
}

function sourceOf(skipFrames: number): string {
  try {
    return sourceFromFrames((new Error().stack ?? "").split("\n").slice(1), skipFrames);
  } catch { return "unknown:0"; }
}

export function stackFrames(error: unknown, limit = 12): string[] {
  try {
    const raw = error instanceof Error && typeof error.stack === "string"
      ? error.stack : (new Error().stack ?? "");
    return raw.split("\n").slice(1).map((line) => line.trim()).filter(Boolean)
      .map((line) => redactTrace(line)).slice(0, limit);
  } catch { return []; }
}

// supabase-js surfaces RPC failures as a plain `{message, details, hint, code}` object, not an Error.
function describeObjectError(value: Record<string, unknown>): string {
  const message = typeof value.message === "string" ? value.message : "";
  const code = typeof value.code === "string" ? value.code : "";
  const details = typeof value.details === "string" && value.details ? ` details=${value.details}` : "";
  const hint = typeof value.hint === "string" && value.hint ? ` hint=${value.hint}` : "";
  const rendered = `${message || "object_error"}${code ? ` [${code}]` : ""}${details}${hint}`.trim();
  return rendered || "object_error";
}

// `skipFrames` is the caller's own statement of how many deciding frames to step over: a thin wrapper
// passes 1 to report its caller. The tracer never adds a skip of its own — its frames are not counted.
export function traceAt(event: string, data?: Record<string, unknown>, error?: unknown, skipFrames = 0): TraceLine {
  const detail: Record<string, unknown> = {};
  try {
    const bag = data ?? {};
    const ancestors: unknown[] = [bag]; // the bag itself is an ancestor, so a self-referencing payload cycles
    const state = { nodes: 0 };
    const allKeys = Object.keys(bag);
    const keys = allKeys.slice(0, TRACE_MAX_ENTRIES);
    for (const key of keys) {
      const redactedKey = redactTrace(key);
      let value: unknown;
      try { value = bag[key]; } catch { detail[redactedKey] = TRACE_UNREADABLE; continue; } // a throwing getter names itself
      if (value === undefined) continue;
      detail[redactedKey] = redactLeaves(value, 1, ancestors, state);
    }
    if (allKeys.length > keys.length) detail[TRACE_TRUNCATED] = TRACE_TRUNCATED;
  } catch { /* ignore */ }
  const message = error instanceof Error ? `${error.name}: ${error.message}`
    : typeof error === "string" ? error
    : error && typeof error === "object" ? describeObjectError(error as Record<string, unknown>)
    : error === undefined ? undefined : String(error);
  return freeze<TraceLine>({
    at: new Date().toISOString(),
    src: sourceOf(skipFrames),
    event: String(event).slice(0, 64),
    ...(Object.keys(detail).length ? { data: freeze(detail) } : {}),
    ...(message !== undefined ? { error: redactTrace(message) } : {}),
    ...(error !== undefined ? { stack: freeze<string[]>(stackFrames(error, 8)) } : {}),
  });
}

// The documented per-run line cap.
export const DEFAULT_TRACE_LIMIT = 600;

// A limit that is not a positive finite number used to disable the layer silently: `0 < NaN` is false, so
// not one line was ever pushed, and `0 >= NaN` is false too, so `overflowed` never admitted it. Such a
// limit now falls back to `DEFAULT_TRACE_LIMIT` and the fallback is recorded on the first line emitted.
function normalizeTraceLimit(requested: unknown): { requested: unknown; limit: number; invalid: boolean } {
  const numeric = typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : 0;
  const invalid = numeric < 1;
  const clamped = invalid ? DEFAULT_TRACE_LIMIT : Math.min(numeric, TRACE_LIMIT_CEILING);
  return { requested, limit: clamped, invalid };
}

// A bounded, per-request accumulator. `mark` records a decision/IO boundary; `fail` records an error
// with its stack. Neither can throw, and neither is ever consulted to make a decision.
export function traceRecorder(limit = DEFAULT_TRACE_LIMIT) {
  const bound = normalizeTraceLimit(limit);
  const origin = sourceOf(0); // who declared this recorder, named by the overflow marker
  const lines: TraceLine[] = [];
  let dropped = 0;
  let limitFlagged = false;

  // The flags ride in `data` of a line the tracer rebuilds, so the annotated line keeps its own `at`,
  // `src`, `event`, `error` and `stack`: a flag never rewrites the record it travels with.
  const withData = (line: TraceLine, extra: Record<string, unknown>): TraceLine => freeze<TraceLine>({
    ...line,
    data: freeze<Record<string, unknown>>({ ...(line.data ?? {}), ...extra }),
  });

  const push = (line: TraceLine): void => {
    let finalLine = line;
    try {
      if (JSON.stringify(finalLine).length > TRACE_MAX_LINE_BYTES) {
        finalLine = freeze<TraceLine>({
          ...line,
          data: freeze<Record<string, unknown>>({ _trace_line_truncated: true, ceiling: TRACE_MAX_LINE_BYTES }),
        });
      }
    } catch { /* stringify may throw on exotic objects; leave the line unmodified */ }
    if (!bound.invalid || limitFlagged) { lines.push(finalLine); return; }
    limitFlagged = true;
    lines.push(withData(finalLine, {
      trace_limit: freeze<Record<string, unknown>>({
        requested: redactTrace(bound.requested), effective: bound.limit, fallback: DEFAULT_TRACE_LIMIT,
      }),
    }));
  };

  // The cap has to survive the run. `overflowed` alone reaches nobody: both real consumers persist
  // `rec.lines` and nothing else, so a truncated artifact used to look complete. The counter therefore
  // annotates the last retained line as each drop happens — a synthetic extra line would change the
  // length and the event sequence of `rec.lines`, which those consumers pin.
  const flagDropped = (): void => {
    dropped += 1;
    const index = lines.length - 1;
    const base = index >= 0 ? lines[index] : undefined;
    if (base === undefined) return;
    lines[index] = withData(base, {
      trace_overflow: freeze<Record<string, unknown>>({ limit: bound.limit, dropped, recorder: origin }),
    });
  };

  const mark = (event: string, data?: Record<string, unknown>, skipFrames = 0): void => {
    try {
      if (lines.length < bound.limit) push(traceAt(event, data, undefined, skipFrames));
      else flagDropped();
    } catch { /* never throw */ }
  };
  const fail = (event: string, error: unknown, data?: Record<string, unknown>, skipFrames = 0): void => {
    try {
      if (lines.length < bound.limit) push(traceAt(event, data, error, skipFrames));
      else flagDropped();
    } catch { /* never throw */ }
  };
  return {
    mark,
    fail,
    // `lines` returns a copy so external mutations cannot corrupt the recorded buffer.
    // Use `clear()` to reset between run parts.
    get lines(): TraceLine[] { return [...lines]; },
    clear(): void { lines.length = 0; },
    get overflowed(): boolean { return lines.length >= bound.limit; },
    get dropped(): number { return dropped; },
    get limit(): number { return bound.limit; },
  };
}