<script setup lang="ts">
import { ref } from "vue";
import type { SideChat } from "./side-chat-store";

const props = defineProps<{
  chat: SideChat;
  capsuleStale: boolean;
}>();

const emit = defineEmits<{
  ask: [question: string];
  copy: [content: string];
  "insert-draft": [content: string];
  refresh: [chatId: string];
  "request-close": [chatId: string];
}>();

const draft = ref("");

function submit(): void {
  const text = draft.value.trim();
  if (text.length === 0) return;
  emit("ask", text);
  draft.value = "";
}
</script>

<template>
  <section class="ws-side-chat" data-testid="side-chat-panel" :data-chat-id="chat.chatId" aria-label="Side Chat">
    <header class="ws-side-chat-header">
      <span class="ws-side-chat-title">{{ chat.title ?? "New side chat" }}</span>
      <span v-if="capsuleStale" class="ws-stale" data-testid="capsule-stale-badge" role="status">
        Context stale — newer main-task context available
      </span>
      <button v-if="capsuleStale" type="button" data-testid="capsule-refresh" @click="emit('refresh', chat.chatId)">
        Refresh context
      </button>
      <button type="button" data-testid="side-chat-close" aria-label="Close side chat" @click="emit('request-close', chat.chatId)">
        &times;
      </button>
    </header>
    <p v-if="chat.capsule?.reducedContextDisclosed" class="ws-reduced" data-testid="capsule-reduced" role="status">
      Host summary unavailable — answering with reduced context (goal/plan/tasks/nearby Turns/anchor).
    </p>
    <ol class="ws-side-chat-messages">
      <template v-for="(message, index) in chat.messages" :key="index">
        <li v-if="message.role === 'user'" class="ws-question" data-testid="side-chat-question">{{ message.content }}</li>
        <li v-else class="ws-answer" data-testid="side-chat-answer">
          <span class="ws-answer-content">{{ message.content }}</span>
          <span v-if="message.capsuleRevision" class="ws-answer-provenance">capsule: {{ message.capsuleRevision }}</span>
          <span class="ws-answer-actions">
            <button type="button" data-testid="answer-copy" @click="emit('copy', message.content)">Copy</button>
            <button type="button" data-testid="answer-insert-draft" @click="emit('insert-draft', message.content)">
              Insert as draft
            </button>
          </span>
        </li>
      </template>
    </ol>
    <form class="ws-side-chat-input" data-testid="side-chat-form" @submit.prevent="submit">
      <input v-model="draft" type="text" data-testid="side-chat-input" aria-label="Ask about this task" />
      <button type="submit" data-testid="side-chat-send">Ask</button>
    </form>
  </section>
</template>

<style scoped>
.ws-side-chat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  height: 100%;
  min-height: 0;
}
.ws-side-chat-header {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.9em;
}
.ws-side-chat-title {
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-stale {
  font-size: 0.8em;
  color: var(--color-warning, #b88230);
}
.ws-reduced {
  margin: 0;
  font-size: 0.8em;
  color: var(--text-color-secondary, #666);
}
.ws-side-chat-messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ws-question,
.ws-answer {
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 0.9em;
}
.ws-question {
  background: var(--fill-color-light, rgba(0, 0, 0, 0.05));
}
.ws-answer {
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ws-answer-provenance {
  font-size: 0.8em;
  color: var(--text-color-secondary, #666);
}
.ws-answer-actions {
  display: flex;
  gap: 6px;
}
.ws-side-chat-input {
  display: flex;
  gap: 6px;
}
.ws-side-chat-input input {
  flex: 1;
  min-width: 0;
}
</style>
