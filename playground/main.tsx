import { StrictMode, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TextChat } from "./TextChat";
import { VoiceSpike } from "./VoiceSpike";

const TABS = [
  { id: "text", label: "Text" },
  { id: "voice", label: "Voice" },
] as const;

type Tab = (typeof TABS)[number]["id"];

function App() {
  // The hash keeps the tab across reloads: #voice, or none for text.
  const [tab, setTab] = useState<Tab>(() => (location.hash === "#voice" ? "voice" : "text"));

  const select = (next: Tab) => {
    setTab(next);
    history.replaceState(null, "", next === "voice" ? "#voice" : location.pathname + location.search);
  };

  // Arrow keys move between tabs, as in the ARIA tabs pattern.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const step = e.key === "ArrowRight" ? 1 : TABS.length - 1;
    const next = TABS[(TABS.findIndex((t) => t.id === tab) + step) % TABS.length]!.id;
    select(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <>
      <header className="page-header">
        <h1>YashOS Assistant playground</h1>
        <div className="tabs" role="tablist" aria-label="Mode" onKeyDown={onKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      {/* Text stays mounted so its conversation survives a look at voice. Voice unmounts when hidden,
          so no mic or socket stays open behind the text tab. */}
      <div role="tabpanel" id="panel-text" aria-labelledby="tab-text" hidden={tab !== "text"}>
        <TextChat />
      </div>
      <div role="tabpanel" id="panel-voice" aria-labelledby="tab-voice" hidden={tab !== "voice"}>
        {tab === "voice" && <VoiceSpike />}
      </div>
    </>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("playground: #root element missing");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
