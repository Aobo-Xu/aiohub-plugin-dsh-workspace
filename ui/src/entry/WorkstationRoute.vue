<script setup lang="ts">
// The workstation shell is assembled by later tasks. This entry proves the
// production loading contract: a single ESM default component export that
// resolves host modules (vue/aiohub-sdk/aiohub-ui) through the AIO import map.
</script>

<template>
  <div class="dsh-workstation-route" role="main" aria-label="Coding工作站"></div>
</template>

<style scoped>
.dsh-workstation-route {
  width: 100%;
  height: 100%;
  background: var(--bg-color, transparent);
}
</style>
