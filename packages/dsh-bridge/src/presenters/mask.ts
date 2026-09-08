export function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue);
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" ? maskText(value) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (/api[_-]?key|token|secret|password/i.test(key)) return [key, "***"];
    return [key, maskValue(child)];
  }));
}

export function maskText(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, "<path>")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1***");
}
