export type ContextSummaryInput = {
  workspaceId: string;
  sessionId: string;
  source: "dsh";
  cursor: string;
  stale: boolean;
  facts: readonly { kind: string; text: string }[];
  maxChars: number;
};

export type ContextSummary = {
  text: string;
  provenance: {
    source: "dsh";
    workspaceId: string;
    sessionId: string;
    cursor: string;
  };
  stale: boolean;
  omittedFacts: number;
};

export function createContextSummary(input: ContextSummaryInput): ContextSummary {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 32) {
    throw new Error("maxChars must be at least 32");
  }
  const header = `DSH ${input.workspaceId}/${input.sessionId} @ ${input.cursor}${input.stale ? " [stale]" : ""}`;
  const lines = [header];
  let omittedFacts = 0;
  for (const fact of input.facts) {
    const line = `${fact.kind}: ${maskSummaryText(fact.text)}`;
    const candidate = `${lines.join("\n")}\n${line}`;
    if (candidate.length > input.maxChars) {
      omittedFacts += 1;
      continue;
    }
    lines.push(line);
  }
  const text = lines.join("\n").slice(0, input.maxChars);
  return {
    text,
    provenance: {
      source: input.source,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      cursor: input.cursor,
    },
    stale: input.stale,
    omittedFacts,
  };
}

function maskSummaryText(text: string): string {
  return text
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1:***")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>");
}
