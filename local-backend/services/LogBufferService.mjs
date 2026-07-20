const DEFAULT_LIMIT = 1000;
const SECRET_KEY_PATTERN =
  /authorization|cookie|token|jwt|password|secret|session|storageState|storage-state|firebase|github/i;
const SECRET_VALUE_PATTERN =
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+|([?&](?:token|jwt|session|password|secret|authorization)=)[^&\s]+/gi;

function redactText(value = "") {
  return String(value).replace(SECRET_VALUE_PATTERN, (_match, bearerPrefix, queryPrefix) => {
    if (bearerPrefix) return `${bearerPrefix}[REDACTED]`;
    if (queryPrefix) return `${queryPrefix}[REDACTED]`;
    return "[REDACTED]";
  });
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: redactText(value.message || ""),
      code: value.code || "",
      status: value.status || value.statusCode || 0,
    };
  }
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[Circular]";

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeValue(entryValue, seen),
    ])
  );
}

function messageFromArgs(args = []) {
  return args
    .map((arg) => {
      const sanitized = sanitizeValue(arg);

      if (typeof sanitized === "string") return sanitized;

      try {
        return JSON.stringify(sanitized);
      } catch {
        return String(sanitized);
      }
    })
    .join(" ");
}

function categoryFromMessage(message = "", level = "info") {
  if (level === "error") return "ERROR";
  if (/elitical|\/api\/1\//i.test(message)) return "ELITICAL";
  if (/sync|reconciliation|queue/i.test(message)) return "SYNC";
  if (/\bfailed|failure|exception\b/i.test(message)) return "ERROR";
  if (/local-backend|backend|\/api\/|\/health/i.test(message)) return "BACKEND";
  return "SYSTEM";
}

export class LogBufferService {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    this.entries = [];
    this.nextId = 1;
  }

  add(level = "info", args = [], details = {}) {
    const message = messageFromArgs(Array.isArray(args) ? args : [args]);
    const entry = {
      id: this.nextId,
      timestamp: new Date().toISOString(),
      level,
      category: details.category || categoryFromMessage(message, level),
      message,
    };

    this.nextId += 1;
    this.entries.push(entry);

    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }

    return entry;
  }

  snapshot({ sinceId = 0, limit = this.limit } = {}) {
    const maxEntries = Math.max(1, Math.min(this.limit, Number(limit) || this.limit));
    const idFloor = Number(sinceId) || 0;
    const filtered = this.entries.filter((entry) => entry.id > idFloor);

    return {
      entries: filtered.slice(-maxEntries),
      latestId: this.entries.at(-1)?.id || 0,
      limit: this.limit,
    };
  }

  captureConsole(consoleLike = console) {
    const methods = ["log", "info", "warn", "error"];
    const originals = {};

    methods.forEach((method) => {
      originals[method] = consoleLike[method].bind(consoleLike);
      consoleLike[method] = (...args) => {
        this.add(method === "log" ? "info" : method, args);
        originals[method](...args);
      };
    });

    this.add("info", ["Backend log buffer initialized."], { category: "SYSTEM" });

    return () => {
      methods.forEach((method) => {
        consoleLike[method] = originals[method];
      });
    };
  }
}
