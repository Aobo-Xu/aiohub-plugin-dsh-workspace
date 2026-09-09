import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const workflowPresenter: Presenter = {
  id: "workflow",
  matches(kind) {
    return kind.startsWith("workflow/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const label = typeof data.title === "string" ? data.title : typeof data.step === "string" ? data.step : "workflow";
    const view: PresenterViewModel = { kind: event.kind, summary: boundedText(`${label} (${event.kind})`) };
    if (typeof data.status === "string") view.status = data.status;
    return view;
  },
};
