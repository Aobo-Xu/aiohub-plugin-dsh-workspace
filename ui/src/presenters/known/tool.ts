import {
  boundedText,
  requireRecord,
  type Presenter,
  type PresenterViewModel,
} from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const toolPresenter: Presenter = {
  id: "tool",
  matches(kind) {
    return kind.startsWith("tool/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const name = typeof data.name === "string" ? data.name : "tool";
    const view: PresenterViewModel = {
      kind: event.kind,
      summary: boundedText(`${name} (${event.kind})`),
      actions: [
        { id: "more-details", label: "More details" },
        { id: "ask-in-side-chat", label: "Ask in Side Chat" },
      ],
    };
    if (typeof data.status === "string") view.status = data.status;
    return view;
  },
};
