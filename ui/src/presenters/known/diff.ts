import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const diffPresenter: Presenter = {
  id: "diff",
  matches(kind) {
    return kind.startsWith("diff/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const label = typeof data.path === "string" ? data.path : typeof data.id === "string" ? data.id : "diff";
    const view: PresenterViewModel = {
      kind: event.kind,
      summary: boundedText(`${label} (${event.kind})`),
      actions: [{ id: "more-details", label: "More details" }],
    };
    if (typeof data.status === "string") view.status = data.status;
    return view;
  },
};
