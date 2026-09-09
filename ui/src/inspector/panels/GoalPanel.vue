<script setup lang="ts">
import type { InspectorTab } from "../inspector-store";

export type GoalView = {
  goalId?: string;
  text?: string;
  status?: string;
  revision?: number;
  milestones?: readonly { id: string; text: string; done: boolean }[];
  limits?: { maxRounds?: number };
  blockers?: readonly { id: string; text: string }[];
};

const props = defineProps<{
  tab?: InspectorTab;
  goal?: GoalView;
  /** Host-advertised Goal management capabilities; controls exist only for these. */
  capabilities?: readonly string[];
}>();

const emit = defineEmits<{
  "edit-goal": [payload: { goalId?: string; revision?: number }];
  "open-limits": [payload: { goalId?: string; revision?: number }];
  "open-blockers": [payload: { goalId?: string; revision?: number }];
  "clear-goal": [payload: { goalId?: string; revision?: number }];
}>();

function advertised(capability: string): boolean {
  return (props.capabilities ?? []).includes(capability);
}

function identity(): { goalId?: string; revision?: number } {
  return { goalId: props.goal?.goalId, revision: props.goal?.revision };
}
</script>

<template>
  <div class="ws-goal-panel" data-testid="goal-panel">
    <template v-if="goal">
      <p data-testid="goal-text">{{ goal.text }}</p>
      <p v-if="goal.status" data-testid="goal-status">{{ goal.status }}</p>
      <p v-if="goal.revision !== undefined" class="ws-goal-revision" data-testid="goal-revision">
        revision {{ goal.revision }}
      </p>
      <ul>
        <li v-for="milestone in goal.milestones ?? []" :key="milestone.id" :data-milestone-id="milestone.id">
          <span :aria-label="milestone.done ? 'done' : 'pending'">{{ milestone.done ? "☑" : "☐" }}</span>
          {{ milestone.text }}
        </li>
      </ul>
      <div class="ws-goal-controls">
        <button v-if="advertised('goal.edit')" type="button" data-testid="goal-edit" @click="emit('edit-goal', identity())">
          Edit
        </button>
        <button v-if="advertised('goal.limits')" type="button" data-testid="goal-limits" @click="emit('open-limits', identity())">
          Round limits{{ goal.limits?.maxRounds !== undefined ? ` (${goal.limits.maxRounds})` : "" }}
        </button>
        <button v-if="advertised('goal.blockers')" type="button" data-testid="goal-blockers" @click="emit('open-blockers', identity())">
          Blockers{{ (goal.blockers ?? []).length > 0 ? ` (${(goal.blockers ?? []).length})` : "" }}
        </button>
        <button v-if="advertised('goal.clear')" type="button" data-testid="goal-clear" @click="emit('clear-goal', identity())">
          Clear
        </button>
      </div>
    </template>
    <p v-else data-testid="goal-empty" role="status">No Host goal reported for this session.</p>
  </div>
</template>

<style scoped>
.ws-goal-panel {
  padding: 8px;
  font-size: 0.9em;
}
.ws-goal-revision {
  color: var(--text-color-secondary, #666);
  font-size: 0.85em;
}
.ws-goal-controls {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
</style>
