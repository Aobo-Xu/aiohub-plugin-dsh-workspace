import {
  maskSecrets,
  type Presenter,
  type PresenterViewModel,
} from "./registry";
import type { ProjectedEvent } from "../state/reducers/session-reducer";

/**
 * Bounded defensive presenter for additive/unknown kinds: masked, size-bounded
 * summary plus an explicit raw-detail path. It never dumps payloads inline and
 * keeps the rest of the Turn usable.
 */
export const genericPresenter: Presenter = {
  id: "generic",
  matches() {
    return false;
  },
  toViewModel(event: ProjectedEvent): PresenterViewModel {
    const masked = maskSecrets(event.data);
    return {
      kind: event.kind,
      summary: `Unknown event ${event.kind}`,
      details: JSON.stringify(masked),
      actions: [
        { id: "more-details", label: "More details" },
        { id: "ask-in-side-chat", label: "Ask in Side Chat" },
      ],
    };
  },
};
