import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const terminalPresenter: Presenter = {
  id: "terminal",
  matches(kind) {
    return kind.startsWith("terminal/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const label =
      typeof data.terminalId === "string" ? data.terminalId : typeof data.id === "string" ? data.id : "terminal";
    const view: PresenterViewModel = {
      kind: event.kind,
      summary: boundedText(`${label} (${event.kind})`),
      actions: [{ id: "more-details", label: "More details" }],
    };
    if (typeof data.status === "string") view.status = data.status;
    return view;
  },
};
