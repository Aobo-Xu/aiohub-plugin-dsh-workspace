export type NotificationSourceEvent = {
  kind: string;
  sessionId: string;
  workspaceId: string;
  workspaceName?: string;
  interactionId?: string;
  /** Raw Host payload; never serialized into notification content. */
  data?: unknown;
};

export type WorkstationNotification = {
  title: string;
  body: string;
  navigate: { workspaceId: string; sessionId: string; interactionId?: string };
  acquireControl: false;
  cancelBackground: false;
};

const LABELS: Readonly<Record<string, string>> = {
  "turn/completed": "Turn completed",
  "turn/failed": "Turn failed",
  "turn/cancelled": "Turn cancelled",
  "turn/interrupted": "Turn interrupted",
  "interaction/approval": "Approval requested",
  "interaction/question": "Question asked",
  "interaction/resolved": "Interaction resolved",
};

/**
 * Redacted lifecycle notifications: only the minimum workspace/session
 * context required for exact navigation. Prompts, file contents, paths and
 * credentials never enter the payload; opening a notification never acquires
 * control and never cancels background work.
 */
export function buildNotification(event: NotificationSourceEvent): WorkstationNotification {
  const label = LABELS[event.kind] ?? "Session activity";
  const where = event.workspaceName ?? event.workspaceId;
  return {
    title: `${where}: ${label}`,
    body: `${label} in session ${event.sessionId} (workspace ${where}). Open to review — no control is acquired.`,
    navigate: {
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      ...(event.interactionId === undefined ? {} : { interactionId: event.interactionId }),
    },
    acquireControl: false,
    cancelBackground: false,
  };
}
