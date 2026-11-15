/**
 * Structured logs: one JSON line per event, with a level, a message and ids as fields, which a host
 * can search and page on. Never secrets, query text, values or a person's question: ids and counts only.
 */
export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** The same logger with these fields on every line (a worker's name, a run's id). */
  with(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  write: (level: LogLevel, line: string) => void = (level, line) =>
    level === "error" ? console.error(line) : console.info(line),
): Logger {
  const at =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) =>
      write(level, JSON.stringify({ time: new Date().toISOString(), level, msg, ...base, ...fields }));
  return {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    with: (fields) => createLogger({ ...base, ...fields }, write),
  };
}

export const logger = createLogger();
