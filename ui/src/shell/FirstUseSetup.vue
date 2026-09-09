<script setup lang="ts">
import { computed, ref } from "vue";
import { LlmModelSelector } from "aiohub-ui";
import { useLlmProfiles } from "aiohub-sdk";

type WorkspaceOption = { id: string; name: string; path?: string };
type PresetOption = { id: string; label: string; description?: string };
type PermissionChoice = { id: string; label: string; recommended?: boolean };

const props = defineProps<{
  workspaceOptions: WorkspaceOption[];
  presets: PresetOption[];
  permissionChoices: PermissionChoice[];
  hostLimits?: Record<string, number>;
}>();

const emit = defineEmits<{
  complete: [selection: {
    workspaceId: string;
    model: string;
    presetId: string;
    permissions: string[];
  }];
  "browse-workspace": [];
}>();

const { enabledProfiles } = useLlmProfiles();

const selectedWorkspace = ref("");
const model = ref("");
const selectedPreset = ref("");
const selectedPermissions = ref<string[]>([]);

const modelMissing = computed(() => enabledProfiles.value.length === 0);
const canComplete = computed(
  () => selectedWorkspace.value !== "" && model.value !== "" && selectedPreset.value !== "",
);

// Nothing here is persisted by the plugin: workspaces, models and limits
// stay owned by AIO and the Host; setup only forwards the user's choice.
function complete(): void {
  if (!canComplete.value) {
    return;
  }
  emit("complete", {
    workspaceId: selectedWorkspace.value,
    model: model.value,
    presetId: selectedPreset.value,
    permissions: [...selectedPermissions.value],
  });
}

void props;
</script>

<template>
  <section class="ws-setup" aria-label="First use setup">
    <div class="ws-setup-field">
      <label for="ws-setup-workspace">Workspace</label>
      <select id="ws-setup-workspace" v-model="selectedWorkspace" data-testid="workspace-select">
        <option value="" disabled>Select workspace</option>
        <option
          v-for="workspace in workspaceOptions"
          :key="workspace.id"
          :value="workspace.id"
          data-testid="workspace-option"
        >{{ workspace.name }}</option>
      </select>
      <button type="button" data-testid="workspace-browse" @click="emit('browse-workspace')">Browse</button>
    </div>

    <div class="ws-setup-field">
      <p v-if="modelMissing" class="ws-setup-hint" data-testid="model-missing-hint">
        No model is configured yet. Configure one in AIO settings, then choose it here.
      </p>
      <LlmModelSelector v-model="model" />
    </div>

    <fieldset class="ws-setup-field">
      <legend>Preset</legend>
      <label v-for="preset in presets" :key="preset.id" data-testid="preset-option">
        <input
          v-model="selectedPreset"
          type="radio"
          name="ws-setup-preset"
          :value="preset.id"
          :data-testid="`preset-${preset.id}`"
        />
        {{ preset.label }}
      </label>
    </fieldset>

    <fieldset class="ws-setup-field">
      <legend>Permissions</legend>
      <label v-for="permission in permissionChoices" :key="permission.id" data-testid="permission-option">
        <input v-model="selectedPermissions" type="checkbox" :value="permission.id" />
        {{ permission.label }}
      </label>
    </fieldset>

    <p v-if="hostLimits" class="ws-setup-hint" data-testid="host-limits">
      <span v-for="(value, key) in hostLimits" :key="key">{{ key }}: {{ value }} </span>
    </p>

    <button
      type="button"
      data-testid="setup-complete"
      :disabled="!canComplete"
      @click="complete"
    >Start workstation</button>
  </section>
</template>

<style scoped>
.ws-setup {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 520px;
  padding: 24px;
  color: var(--text-color, inherit);
}
.ws-setup-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: none;
  padding: 0;
  margin: 0;
}
.ws-setup-hint {
  font-size: 12px;
  color: var(--text-color-secondary, #666);
}
</style>
