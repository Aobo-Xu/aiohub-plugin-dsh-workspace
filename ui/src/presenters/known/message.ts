import {
  boundedText,
  provenanceFrom,
  requireRecord,
  textFromContent,
  type Presenter,
  type PresenterViewModel,
} from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const messagePresenter: Presenter = {
  id: "message",
  matches(kind) {
    return kind === "user/message" || kind === "assistant/message";
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const text = textFromContent(data.content);
    const view: PresenterViewModel = {
      kind: event.kind,
      summary: boundedText(text.length > 0 ? text : "(empty message)"),
      actions: [{ id: "ask-in-side-chat", label: "Ask in Side Chat" }],
    };
    if (event.kind === "assistant/message") {
      view.provenance = provenanceFrom(data);
      if (typeof data.status === "string") view.status = data.status;
    }
    return view;
  },
};
