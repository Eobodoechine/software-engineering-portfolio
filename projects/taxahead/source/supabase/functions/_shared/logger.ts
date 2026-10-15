// supabase/functions/_shared/logger.ts
//
// Structured JSON-line logger for Supabase Deno edge functions.
// Captures stack traces with file:line so every error is immediately pinpointable.

import { redactText, sanitizeLogValue } from "./redaction.ts";

type LogExtra = Record<string, unknown>;

function captureStack(skipFrames = 2): string {
  try {
    const err = new Error();
    const lines = (err.stack ?? "").split("\n");
    const relevant = lines.slice(skipFrames).find((l) => {
      const trimmed = l.trim();
      return trimmed && !trimmed.includes("logger.ts");
    });
    return (relevant ?? lines[lines.length - 1] ?? "").trim();
  } catch {
    return "unable_to_capture_stack";
  }
}

export interface StructuredLogger {
  error(message: string, extra?: LogExtra): void;
  warn(message: string, extra?: LogExtra): void;
  info(message: string, extra?: LogExtra): void;
}

export function logger(fnName: string): StructuredLogger {
  function emit(level: "error" | "warn" | "info", message: string, extra?: LogExtra): void {
    try {
      const stack = captureStack(3);
      const entry: Record<string, unknown> = {
        time: new Date().toISOString(),
        level,
        fn: fnName,
        message: redactText(message),
        stack,
      };
      if (extra && typeof extra === "object") {
        for (const [k, v] of Object.entries(extra)) {
          if (k === "time" || k === "level" || k === "fn" || k === "message" || k === "stack")
            continue;
          entry[k] = sanitizeLogValue(v, k);
        }
      }
      const line = JSON.stringify(entry);
      if (level === "error") {
        console.error(line);
      } else {
        console.log(line);
      }
    } catch {
      console.error(`[${fnName}] ${level}: ${redactText(message)}`);
    }
  }
  return {
    error(message, extra) {
      emit("error", message, extra);
    },
    warn(message, extra) {
      emit("warn", message, extra);
    },
    info(message, extra) {
      emit("info", message, extra);
    },
  };
}
