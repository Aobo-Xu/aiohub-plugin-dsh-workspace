import { boundedText, requireRecord, type Presenter, type PresenterViewModel } from "../registry";
import type { ProjectedEvent } from "../../state/reducers/session-reducer";

export const subagentPresenter: Presenter = {
  id: "subagent",
  matches(kind) {
    return kind.startsWith("subagent/");
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const data = requireRecord(event.data);
    const label = typeof data.name === "string" ? data.name : typeof data.agentId === "string" ? data.agentId : "subagent";
    const view: PresenterViewModel = {
      kind: event.kind,
      summary: boundedText(`${label} (${event.kind})`),
      actions: [{ id: "more-details", label: "More details" }],
    };
    if (typeof data.status === "string") view.status = data.status;
    return view;
  },
};
