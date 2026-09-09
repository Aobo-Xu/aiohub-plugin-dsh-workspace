import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const contextPresenter: Presenter = {
  id: "context",
  matches(kind) {
    return kind.startsWith("context/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const text = typeof data.text === "string" ? data.text : typeof data.summary === "string" ? data.summary : "context";
    return { kind: event.kind, summary: boundedText(text) };
  },
};
