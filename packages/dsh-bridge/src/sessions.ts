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
      if (!isSessionCommandKind(command.kind)) {
        throw new BridgeCommandError("UNKNOWN_SESSION_COMMAND");
      }

      // Reads may be issued by an observer. All other verbs remain fenced by
      // the controller lease before the adapter is touched.
      if (!READ_SESSION_COMMAND_KINDS.has(command.kind)) {
        assertMutable(lease);
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

const READ_SESSION_COMMAND_KINDS = new Set<SessionCommandKind>([
  "list",
  "search",
  "history",
]);
