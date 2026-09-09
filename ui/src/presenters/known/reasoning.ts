import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const reasoningPresenter: Presenter = {
  id: "reasoning",
  matches(kind) {
    return kind.startsWith("reasoning/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const text = typeof data.text === "string" ? data.text : typeof data.delta === "string" ? data.delta : "";
    return {
      kind: event.kind,
      summary: boundedText(text.length > 0 ? text : "Reasoning"),
      ...(event.kind.endsWith("delta") ? { status: "streaming" } : {}),
    };
  },
};
