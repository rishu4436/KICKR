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
