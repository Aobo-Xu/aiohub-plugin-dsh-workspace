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

import { maskValue } from "./mask.js";
