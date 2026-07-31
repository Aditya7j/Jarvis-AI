type LogLevel = "debug" | "info" | "warn" | "error";

const ICONS: Record<LogLevel, string> = {
  debug: "·",
  info: "✓",
  warn: "⚠",
  error: "✕",
};

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel =
  (process.env.AI_LOG_LEVEL as LogLevel | undefined) || "info";

function timestamp(now: Date): string {
  return now.toISOString().slice(11, 23);
}

export class Logger {
  constructor(private readonly scope: string[] = []) {}

  child(scope: string): Logger {
    return new Logger([...this.scope, scope]);
  }

  private emit(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;
    const prefix = this.scope.length ? `[${this.scope.join(".")}]` : "";
    const icon = ICONS[level];
    const payload = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${timestamp(new Date())} ${icon} ${prefix} ${message}${payload}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.emit("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.emit("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.emit("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.emit("error", message, data);
  }
}

export const aiLogger = new Logger(["ai"]);
