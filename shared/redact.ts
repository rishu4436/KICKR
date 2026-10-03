const SECRET_KEY =
  /password|secret|token|authorization|databaseurl|redisurl|privatekey|seed|signature|apikey|credential|nonce/i;

const CONNECTION_URL = /(?:postgres(?:ql)?|redis):\/\/\S+/gi;

/**
 * Return a copy safe for structured logs.
 * Keys that look like secrets are replaced. Connection URLs inside strings
 * are replaced so a database password cannot leak through a message field.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redact(inner, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value.replace(CONNECTION_URL, (match) => {
      const scheme = match.startsWith("redis") ? "redis" : "postgres";
      return `${scheme}://[redacted]`;
    });
  }
  return value;
}
