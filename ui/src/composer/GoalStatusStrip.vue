<script setup lang="ts">
export type GoalStripView = {
  goalId: string;
  phase: string;
  objective: string;
  progress?: { done: number; total: number };
  revision: number;
  paused: boolean;
  resumeAvailable: boolean;
};

defineProps<{ goal: GoalStripView }>();

const emit = defineEmits<{
  "open-goal": [goal: GoalStripView];
  "resume-goal": [payload: { goalId: string; revision: number }];
}>();
</script>

<template>
  <div
    class="ws-goal-strip"
    data-testid="goal-strip"
    role="button"
    tabindex="0"
    :aria-label="`Goal ${goal.phase}: ${goal.objective}`"
    @click="emit('open-goal', goal)"
    @keydown.enter="emit('open-goal', goal)"
  >
    <span class="ws-goal-phase" data-testid="goal-phase">{{ goal.phase }}</span>
    <span class="ws-goal-objective" data-testid="goal-objective">{{ goal.objective }}</span>
    <span v-if="goal.progress" class="ws-goal-progress" data-testid="goal-progress">
      {{ goal.progress.done }}/{{ goal.progress.total }}
    </span>
    <button
      v-if="goal.paused && goal.resumeAvailable"
      type="button"
      class="ws-goal-resume"
      data-testid="goal-resume"
      @click.stop="emit('resume-goal', { goalId: goal.goalId, revision: goal.revision })"
    >Resume</button>
  </div>
</template>

<style scoped>
.ws-goal-strip {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
  font-size: 0.85em;
  cursor: pointer;
}
.ws-goal-phase {
  padding: 0 6px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
}
.ws-goal-objective {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-goal-progress {
  color: var(--text-color-secondary, #666);
}
.ws-goal-resume {
  border: none;
  background: transparent;
  color: var(--color-primary, #409eff);
  cursor: pointer;
}
</style>
