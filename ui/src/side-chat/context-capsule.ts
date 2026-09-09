import { boundedText, maskSecrets } from "../presenters/registry";

export type SourceAnchor = {
  kind: string;
  id: string;
  sessionId: string;
  turnId?: string;
  excerpt?: string;
};

export type CapsuleInput = {
  anchor?: SourceAnchor;
  summary?: string;
  goal?: { text: string; revision: number };
  plan?: string;
  tasks?: readonly string[];
  nearbyTurns?: readonly { turnId: string; status: string; summary: string }[];
  /** Sources the user explicitly expanded; nothing is copied automatically. */
  expansions?: readonly { id: string; kind: string; content: string; bytes?: number }[];
  /** Safe Host-reported revision identity only; never the prompt text. */
  promptRevision?: string;
};

export type CapsulePart = {
  id: string;
  kind: string;
  content: string;
  bytes: number;
  masked: boolean;
};

export type ContextCapsule = {
  mainSessionId: string;
  pinnedRevision: string;
  anchor?: SourceAnchor;
  summaryAvailable: boolean;
  reducedContextDisclosed: boolean;
  maskingApplied: boolean;
  promptRevision?: string;
  parts: CapsulePart[];
  totalBytes: number;
};

const PART_BOUND = 4000;
const NEARBY_LIMIT = 3;
const CREDENTIAL_ASSIGNMENT =
  /(api[_-]?key|token|secret|password|authorization|cookie|credential)(\s*[=:]\s*)(["'])?[^"';,\s]+/gi;

function maskText(text: string): { text: string; masked: boolean } {
  let masked = false;
  const replaced = text.replace(CREDENTIAL_ASSIGNMENT, (_match, key: string, sep: string, quote?: string) => {
    masked = true;
    return `${key}${sep}${quote ?? ""}[masked]`;
  });
  return { text: replaced, masked };
}

function makePart(id: string, kind: string, raw: string): { part: CapsulePart; masked: boolean } {
  const masking = maskText(raw);
  const content = boundedText(masking.text, PART_BOUND);
  return {
    part: { id, kind, content, bytes: content.length, masked: masking.masked },
    masked: masking.masked,
  };
}

/**
 * Builds the bounded read-only context capsule. Only the exact anchor, the
 * available Host summary/goal/plan/tasks, bounded nearby Turns and explicitly
 * expanded sources enter; unselected history is never copied and the full
 * effective System Prompt text never enters automatically.
 */
export function buildCapsule(
  mainSessionId: string,
  input: CapsuleInput,
  options: { mainStateRevision: string },
): ContextCapsule {
  const parts: CapsulePart[] = [];
  let maskingApplied = false;

  const add = (id: string, kind: string, raw: string) => {
    const { part, masked } = makePart(id, kind, raw);
    if (masked) maskingApplied = true;
    parts.push(part);
  };

  if (input.anchor !== undefined) {
    // maskSecrets keeps the anchor structural fields bounded as well.
    const anchor = input.anchor;
    if (anchor.excerpt !== undefined) {
      add(`anchor:${anchor.id}`, "anchor", anchor.excerpt);
    }
  }
  if (input.summary !== undefined) {
    add("summary", "summary", input.summary);
  }
  if (input.goal !== undefined) {
    add(`goal:${input.goal.revision}`, "goal", input.goal.text);
  }
  if (input.plan !== undefined) {
    add("plan", "plan", input.plan);
  }
  if (input.tasks !== undefined && input.tasks.length > 0) {
    add("tasks", "tasks", input.tasks.join("\n"));
  }
  for (const turn of (input.nearbyTurns ?? []).slice(0, NEARBY_LIMIT)) {
    add(`nearby:${turn.turnId}`, "nearby-turn", `${turn.turnId} [${turn.status}] ${turn.summary}`);
  }
  for (const expansion of input.expansions ?? []) {
    add(`expansion:${expansion.id}`, "expansion", expansion.content);
  }

  // Defensive: even if a caller smuggles prompt text on the input object,
  // only the revision identity is ever recorded.
  const structured = maskSecrets({ promptRevision: input.promptRevision ?? null });

  return {
    mainSessionId,
    pinnedRevision: options.mainStateRevision,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    summaryAvailable: input.summary !== undefined,
    reducedContextDisclosed: input.summary === undefined,
    maskingApplied,
    ...((structured as { promptRevision?: string | null }).promptRevision
      ? { promptRevision: (structured as { promptRevision: string }).promptRevision }
      : {}),
    parts,
    totalBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
  };
}

export function renderCapsule(capsule: ContextCapsule): string {
  const lines = [
    `Context capsule for DSH session ${capsule.mainSessionId} (pinned at ${capsule.pinnedRevision}).`,
    capsule.summaryAvailable ? "" : "Note: Host session summary unavailable; context is reduced.",
    ...capsule.parts.map((part) => `[${part.kind}:${part.id}]${part.masked ? " (masked)" : ""} ${part.content}`),
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}
