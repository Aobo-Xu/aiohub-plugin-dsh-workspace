<script setup lang="ts">
import type { InspectorTab } from "../inspector-store";

export type GoalView = {
  goalId?: string;
  text?: string;
  status?: string;
  milestones?: readonly { id: string; text: string; done: boolean }[];
};

defineProps<{ tab?: InspectorTab; goal?: GoalView }>();
</script>

<template>
  <div class="ws-goal-panel" data-testid="goal-panel">
    <template v-if="goal">
      <p data-testid="goal-text">{{ goal.text }}</p>
      <p v-if="goal.status" data-testid="goal-status">{{ goal.status }}</p>
      <ul>
        <li v-for="milestone in goal.milestones ?? []" :key="milestone.id" :data-milestone-id="milestone.id">
          <span :aria-label="milestone.done ? 'done' : 'pending'">{{ milestone.done ? "☑" : "☐" }}</span>
          {{ milestone.text }}
        </li>
      </ul>
    </template>
    <p v-else data-testid="goal-empty" role="status">No Host goal reported for this session.</p>
  </div>
</template>

<style scoped>
.ws-goal-panel {
  padding: 8px;
  font-size: 0.9em;
}
</style>
