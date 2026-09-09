/**
 * Test stub for the aiohub-ui import-map module. Mirrors the public named
 * exports with inspectable minimal components.
 */
import { defineComponent, h } from "vue";

export const LlmModelSelector = defineComponent({
  name: "LlmModelSelector",
  props: {
    modelValue: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
    placeholder: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h(
        "button",
        {
          type: "button",
          "data-testid": "llm-model-selector",
          disabled: props.disabled,
          onClick: () => emit("update:modelValue", "profile-1:model-1"),
        },
        props.modelValue === "" ? props.placeholder || "select-model" : props.modelValue,
      );
  },
});

export const BaseDialog = defineComponent({
  name: "BaseDialog",
  props: { visible: { type: Boolean, default: false }, title: { type: String, default: "" } },
  setup(props, { slots }) {
    return () =>
      props.visible
        ? h("div", { role: "dialog", "aria-modal": "true", "aria-label": props.title }, slots.default?.())
        : null;
  },
});

export const RichCodeEditor = defineComponent({ name: "RichCodeEditor" });
export const RichTextRenderer = defineComponent({ name: "RichTextRenderer" });
export const DraggablePanel = defineComponent({ name: "DraggablePanel" });
export const DynamicIcon = defineComponent({
  name: "DynamicIcon",
  props: { name: { type: String, default: "" } },
  setup(props) {
    return () => h("i", { "data-icon": props.name });
  },
});

export default {};
