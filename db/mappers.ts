export function asDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error("Expected a timestamp");
}

export function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected a string");
  }
  return value;
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asString(value);
}

export function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asDate(value);
}

/** pg returns timestamptz as Date; memory/tests may pass ISO strings. */
export function asIsoTimestamp(value: unknown): string {
  return asDate(value).toISOString();
}

export function asJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
  }
  throw new Error("Expected a JSON array");
}

export function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error("Expected a number");
}
