export type PresenterInput = {
  kind: string;
  data: unknown;
  provenance: { source: string; model?: string; preset?: string };
  operations?: Record<string, boolean>;
};

export type PresenterRecord = {
  kind: string;
  data: unknown;
  provenance: PresenterInput["provenance"];
  actions: readonly string[];
};

const KNOWN_KINDS = new Set([
  "message",
  "reasoning",
  "tool",
  "job",
  "workflow",
  "context",
  "file",
  "diff",
  "terminal",
  "subagent",
]);

export function normalizePresenter(input: PresenterInput): PresenterRecord {
  const kind = KNOWN_KINDS.has(input.kind) ? input.kind : `unknown:${input.kind}`;
  return {
    kind,
    data: maskValue(input.data),
    provenance: { ...input.provenance },
    actions: kind.startsWith("unknown:")
      ? []
      : Object.entries(input.operations ?? {})
        .filter(([, available]) => available)
        .map(([id]) => id),
  };
}

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue);
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" ? maskText(value) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (/api[_-]?key|token|secret|password/i.test(key)) return [key, "***"];
    return [key, maskValue(child)];
  }));
}

function maskText(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\s]+/g, "<path>");
}
