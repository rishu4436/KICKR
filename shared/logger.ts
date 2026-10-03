import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function createLogger(options: {
  level: LogLevel;
  sink?: (line: string) => void;
}): Logger {
  const sink = options.sink ?? ((line: string) => console.log(line));
  const min = RANK[options.level];

  const write = (level: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (RANK[level] < min) {
      return;
    }
    const payload = redact({
      level,
      message,
      time: new Date().toISOString(),
      ...fields,
    });
    sink(JSON.stringify(payload));
  };

  return {
    debug: (fields, message) => write("debug", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message),
  };
}

export function silentLogger(): Logger {
  return createLogger({ level: "error", sink: () => undefined });
}
