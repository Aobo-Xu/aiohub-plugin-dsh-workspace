import { BridgeCommandError } from "./controller-leases.js";
import type { ControllerLease } from "../../runtime-facade/src/types.js";

export type SessionCommandKind =
  | "create"
  | "list"
  | "search"
  | "resume"
  | "history"
  | "prompt"
  | "cancel"
  | "steer"
  | "queue"
  | "fork"
  | "rename"
  | "model"
  | "workspace";

export type SessionCommandInput = {
  kind: SessionCommandKind;
  input?: unknown;
};

type SessionServiceMethods = {
  [K in SessionCommandKind]: (input: unknown) => Promise<unknown>;
};

type SessionServiceOptions = {
  session: SessionServiceMethods;
  assertMutable: (lease: ControllerLease) => void;
};

export function createSessionService(options: SessionServiceOptions) {
  const { session, assertMutable } = options;

  return {
    async command(lease: ControllerLease, command: SessionCommandInput) {
      assertMutable(lease);

      if (!isSessionCommandKind(command.kind)) {
        throw new BridgeCommandError("UNKNOWN_SESSION_COMMAND");
      }

      return session[command.kind](command.input);
    },
  };
}

function isSessionCommandKind(value: unknown): value is SessionCommandKind {
  return typeof value === "string" && SESSION_COMMAND_KINDS.has(value as SessionCommandKind);
}

const SESSION_COMMAND_KINDS = new Set<SessionCommandKind>([
  "create",
  "list",
  "search",
  "resume",
  "history",
  "prompt",
  "cancel",
  "steer",
  "queue",
  "fork",
  "rename",
  "model",
  "workspace",
]);
