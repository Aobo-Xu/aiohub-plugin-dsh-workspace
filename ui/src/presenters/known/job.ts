import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const jobPresenter: Presenter = {
  id: "job",
  matches(kind) {
    return kind.startsWith("job/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const label = typeof data.name === "string" ? data.name : typeof data.id === "string" ? data.id : "job";
    const view: PresenterViewModel = { kind: event.kind, summary: boundedText(`${label} (${event.kind})`) };
    if (typeof data.status === "string") view.status = data.status;
    return view;
  },
};
