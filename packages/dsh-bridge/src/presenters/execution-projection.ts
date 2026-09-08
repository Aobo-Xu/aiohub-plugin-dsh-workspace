export type ExecutionProjectionInput = {
  kind: "job" | "workflow" | "subagent";
  id: string;
  parentId?: string;
  sessionId: string;
  generation: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted" | "inactive";
  progress?: { completed: number; total?: number };
  operations?: Record<string, boolean>;
};

export function normalizeExecutionProjection(input: ExecutionProjectionInput) {
  return {
    kind: input.kind,
    id: input.id,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    sessionId: input.sessionId,
    generation: input.generation,
    status: input.status,
    ...(input.progress === undefined ? {} : { progress: { ...input.progress } }),
    actions: Object.entries(input.operations ?? {})
      .filter(([, available]) => available)
      .map(([id]) => id),
  };
}
