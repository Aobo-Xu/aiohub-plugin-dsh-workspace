import type { ProjectedEvent } from "../state/reducers/session-reducer";
import { genericPresenter } from "./generic-presenter";
import { messagePresenter } from "./known/message";
import { reasoningPresenter } from "./known/reasoning";
import { toolPresenter } from "./known/tool";
import { jobPresenter } from "./known/job";
import { workflowPresenter } from "./known/workflow";
import { contextPresenter } from "./known/context";
import { filePresenter } from "./known/file";
import { diffPresenter } from "./known/diff";
import { terminalPresenter } from "./known/terminal";
import { subagentPresenter } from "./known/subagent";

export const GENERIC_PRESENTER_ID = "generic";
/** Hard cap for one serialized presenter view model (masked, bounded output). */
export const PRESENTER_VIEW_MODEL_BOUND = 4000;

const CREDENTIAL_KEY = /key|token|secret|password|authorization|cookie|credential/i;
const MAX_STRING = 160;
const MAX_ARRAY = 20;
const MAX_DEPTH = 6;

export type PresenterAction = { id: string; label: string };

export type PresenterProvenance = {
  model: string;
  source: string;
  preset: string;
};

export type PresenterViewModel = {
  kind: string;
  summary: string;
  status?: string;
  provenance?: PresenterProvenance;
  actions?: PresenterAction[];
  details?: string;
  /** True when the DTO failed its presenter contract and output is degraded. */
  degraded?: boolean;
};

export type Presenter = {
  id: string;
  matches(kind: string): boolean;
  toViewModel(event: ProjectedEvent): PresenterViewModel;
};

/** Thrown by known presenters when the Host DTO does not satisfy the contract. */
export class PresenterContractError extends Error {}

const KNOWN_PRESENTERS: readonly Presenter[] = [
  messagePresenter,
  reasoningPresenter,
  toolPresenter,
  jobPresenter,
  workflowPresenter,
  contextPresenter,
  filePresenter,
  diffPresenter,
  terminalPresenter,
  subagentPresenter,
];

export function resolvePresenter(kind: string): Presenter {
  return KNOWN_PRESENTERS.find((presenter) => presenter.matches(kind)) ?? genericPresenter;
}

/**
 * Presenter errors are isolated per card: a malformed DTO degrades to the
 * masked generic summary instead of breaking the surrounding Turn.
 */
export function toViewModelSafe(event: ProjectedEvent): PresenterViewModel {
  let view: PresenterViewModel;
  try {
    view = resolvePresenter(event.kind).toViewModel(event);
  } catch {
    view = genericPresenter.toViewModel(event);
    view = { ...view, degraded: true };
  }
  return enforceBound(view);
}

export function requireRecord(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PresenterContractError("event data must be an object");
  }
  return data as Record<string, unknown>;
}

export function boundedText(value: unknown, max = MAX_STRING): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

export function provenanceFrom(data: Record<string, unknown>): PresenterProvenance {
  return {
    model: typeof data.model === "string" ? data.model : "unknown model",
    source: typeof data.source === "string" ? data.source : "unknown source",
    preset: typeof data.preset === "string" ? data.preset : "no preset",
  };
}

/** Recursively masks credential-like values and bounds strings/arrays. */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") return boundedText(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_ARRAY).map((item) => maskSecrets(item, depth + 1));
    if (value.length > MAX_ARRAY) bounded.push(`… ${value.length - MAX_ARRAY} more`);
    return bounded;
  }
  const record = value as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    masked[key] = CREDENTIAL_KEY.test(key) ? "[masked]" : maskSecrets(record[key], depth + 1);
  }
  return masked;
}

function enforceBound(view: PresenterViewModel): PresenterViewModel {
  let bounded = view;
  if (JSON.stringify(bounded).length > PRESENTER_VIEW_MODEL_BOUND) {
    bounded = {
      ...bounded,
      summary: boundedText(bounded.summary, 200),
      details: bounded.details === undefined ? undefined : boundedText(bounded.details, 400),
    };
  }
  if (JSON.stringify(bounded).length > PRESENTER_VIEW_MODEL_BOUND) {
    const { details: _dropped, ...rest } = bounded;
    bounded = { ...rest, summary: boundedText(rest.summary, 120) };
  }
  return bounded;
}
