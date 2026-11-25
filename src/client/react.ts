import { useSyncExternalStore } from "react";
import type { AssistantSession, AssistantSnapshot } from "./assistant-session";

/** The session's state, re-rendering the component when it changes. The only client file that imports React. */
export function useAssistant(session: AssistantSession): AssistantSnapshot {
  return useSyncExternalStore(session.subscribe, () => session.snapshot, () => session.snapshot);
}
