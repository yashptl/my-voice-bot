import { useEffect, useMemo, useState } from "react";
import type { MicState } from "../src/client/half-duplex";
import type { MicSource } from "../src/client/mic";
import { startSession } from "../src/client/text-chat";
import { getTurnstileToken, TEST_SITE_KEY } from "../src/client/turnstile";
import { VoiceSession, type VoiceSessionEventOf } from "../src/client/voice-session";
import type { DataLine } from "../src/protocol/data-line";
import type { AssistantState } from "../src/protocol/events";
import type { ClientMark, Mark, TurnRecord } from "../src/protocol/turn-record";

// Test questions made as described in fixtures/README.md; whichever exist are offered as sources.
const FIXTURES = import.meta.glob<string>("./fixtures/*.wav", { query: "?url", import: "default", eager: true });
const FIXTURE_NAMES = Object.keys(FIXTURES).sort();

/** Server marks shown as columns, in pipeline order ("received" is always 0). */
const MARK_COLUMNS: Mark[] = [
  "eagerEndOfTurn",
  "endOfTurn",
  "firstReasoning",
  "firstAnswerToken",
  "firstSentence",
  "firstAudio",
  "done",
];

interface TurnView {
  turnId: string;
  question: string;
  sentences: { id: number; text: string }[];
  meta: DataLine | null;
  record: TurnRecord | null;
  clientMarks: Partial<Record<ClientMark, number>>;
  /** Set when Stop came after turn.end (audio still playing): the last sentence heard, or null for none. */
  stoppedAfterEnd?: { lastHeard: number | null };
}

type Connection = Omit<VoiceSessionEventOf<"connection">, "type">;

export function VoiceSpike() {
  const session = useMemo(() => new VoiceSession(), []);
  const [connection, setConnection] = useState<Connection>({ status: "closed" });
  const [providers, setProviders] = useState<string | null>(null);
  const [serverState, setServerState] = useState<AssistantState | null>(null);
  const [mic, setMic] = useState<MicState>("off");
  const [stt, setStt] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ text: string; final: boolean } | null>(null);
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [sourceKey, setSourceKey] = useState("mic");
  const [chosenFile, setChosenFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const addLog = (line: string) => setLog((lines) => [`${clock()}  ${line}`, ...lines].slice(0, 100));
    const updateTurn = (turnId: string, fn: (t: TurnView) => TurnView) =>
      setTurns((ts) => ts.map((t) => (t.turnId === turnId ? fn(t) : t)));

    const unsubscribe = [
      session.on("connection", (e) => {
        setConnection(e);
        addLog(`connection ${e.status}${e.mode ? ` (mode ${e.mode})` : ""}${e.detail ? `: ${e.detail}` : ""}`);
        if (e.status === "open") {
          fetchProviders().then(setProviders, (err: unknown) => setProviders(`health check failed: ${message(err)}`));
        }
        if (e.status === "closed") setServerState(null);
        if (e.status === "open") setStt("session 1 open");
        if (e.status === "closed") setStt(null);
      }),
      session.on("ready", (e) =>
        addLog(`ready: protocol ${e.protocol}, mode ${e.mode}, voice ${e.audio.encoding} ${e.audio.sampleRate} Hz`),
      ),
      session.on("state", (e) => {
        setServerState(e.state);
        addLog(`state ${e.state}`);
      }),
      session.on("mic", (e) => {
        setMic(e.state);
        addLog(`mic ${e.state}`);
      }),
      session.on("transcript", (e) => {
        setTranscript({ text: e.text, final: e.final });
        if (e.final) addLog(`transcript final (turn ${e.turnIndex})`);
      }),
      session.on("turn.start", (e) => {
        setTurns((ts) => [
          ...ts,
          { turnId: e.turnId, question: e.question, sentences: [], meta: null, record: null, clientMarks: {} },
        ]);
        addLog(`turn.start ${e.turnId}`);
      }),
      session.on("sentence", (e) =>
        updateTurn(e.turnId, (t) => ({ ...t, sentences: [...t.sentences, { id: e.id, text: e.text }] })),
      ),
      session.on("meta", (e) => updateTurn(e.turnId, (t) => ({ ...t, meta: e.data }))),
      session.on("turn.end", (e) => {
        updateTurn(e.turnId, (t) => ({ ...t, record: e.record }));
        addLog(`turn.end ${e.turnId}${e.record.interrupted ? " (interrupted)" : ""}`);
      }),
      session.on("turn.interrupted", (e) => {
        updateTurn(e.turnId, (t) => ({ ...t, record: e.record, stoppedAfterEnd: { lastHeard: e.lastHeardSentenceId } }));
        addLog(`turn.interrupted ${e.turnId} after turn.end, last heard sentence ${e.lastHeardSentenceId ?? "none"}`);
      }),
      session.on("stt", (e) => {
        // G6: Flux closing the speech-to-text session (the voice socket itself stays open).
        const line =
          e.status === "closed"
            ? `session ${e.session} closed after ${seconds(e.openForMs)} open, ` +
              (e.idleMs === null ? "no audio sent to it" : `${seconds(e.idleMs)} after its last audio`)
            : `session ${e.session} opened for new audio`;
        setStt(line);
        addLog(`stt ${line}`);
      }),
      session.on("mark", (e) => {
        updateTurn(e.turnId, (t) => ({ ...t, clientMarks: { ...t.clientMarks, [e.mark]: e.at } }));
        addLog(`mark ${e.mark}`);
      }),
      session.on("error", (e) => addLog(`error ${e.code}: ${e.message}`)),
    ];
    return () => {
      for (const off of unsubscribe) off();
      session.close();
    };
  }, [session]);

  // Space or Esc stops playback (outside form fields, which use those keys themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Escape") return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      session.interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  const connected = connection.status === "open";
  const current = turns.at(-1);

  const connect = () => {
    setProblem(null);
    setProviders(null);
    const baseUrl = `${window.location.origin}/assistant`;
    const getSession = async () => startSession({ baseUrl, turnstile: await getTurnstileToken(TEST_SITE_KEY) });
    session.connect(getSession, baseUrl).catch((err: unknown) => setProblem(message(err)));
  };

  const talk = async () => {
    setProblem(null);
    try {
      await session.talk(await resolveSource(sourceKey, chosenFile));
    } catch (err) {
      setProblem(message(err));
    }
  };

  return (
    <main className="spike">
      <style>{CSS}</style>
      <h2>Voice spike</h2>
      <p className="muted">
        Connect, pick a source, then Talk. Space or Esc stops playback; Stop also turns the mic off. The mic is
        muted while a reply plays and stays live for 8 s afterwards.
      </p>

      <div className="row">
        <button type="button" onClick={connect}>
          {connection.status === "closed" ? "Connect" : "Reconnect"}
        </button>
        <button type="button" onClick={() => session.close()} disabled={connection.status === "closed"}>
          Disconnect
        </button>
      </div>

      <div className="row">
        <label>
          Source{" "}
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="mic">Microphone</option>
            {FIXTURE_NAMES.map((key) => (
              <option key={key} value={key}>
                Test file: {key.replace("./fixtures/", "")}
              </option>
            ))}
            <option value="file" disabled={!chosenFile}>
              {chosenFile ? `Chosen file: ${chosenFile.name}` : "Chosen file (pick one)"}
            </option>
          </select>
        </label>
        <label>
          Use test file{" "}
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              setChosenFile(file);
              if (file) setSourceKey("file");
            }}
          />
        </label>
      </div>

      <div className="row">
        <button type="button" className="primary" onClick={talk} disabled={!connected}>
          Talk
        </button>
        <button type="button" onClick={() => session.stop()} disabled={!connected}>
          Stop
        </button>
      </div>

      {problem && <p className="problem">{problem}</p>}

      <dl className="status">
        <dt>Connection</dt>
        <dd>
          {connection.status}
          {connection.mode ? ` · mode ${connection.mode}` : ""}
          {connection.detail ? ` · ${connection.detail}` : ""}
        </dd>
        <dt>Providers</dt>
        <dd>{providers ?? "–"}</dd>
        <dt>Assistant</dt>
        <dd>{serverState ?? "–"}</dd>
        <dt>Mic</dt>
        <dd>{mic}</dd>
        <dt>Speech to text</dt>
        <dd>{stt ?? "–"}</dd>
      </dl>

      <section>
        <h3>Transcript</h3>
        <p className={transcript?.final ? "" : "muted"}>
          {transcript?.text || "–"}
          {transcript?.final ? " (final)" : ""}
        </p>
      </section>

      <section>
        <h3>Reply</h3>
        {current ? (
          <>
            <p className="muted">Q: {current.question}</p>
            <ol className="captions">
              {current.sentences.map((s) => (
                <li key={s.id}>{s.text}</li>
              ))}
            </ol>
            {current.meta && (
              <p className="muted">
                meta: coverage {current.meta.coverage} · refs {current.meta.refs.join(", ") || "none"} · show{" "}
                {current.meta.show ?? "none"} · contact {String(current.meta.contact)}
              </p>
            )}
          </>
        ) : (
          <p className="muted">–</p>
        )}
      </section>

      <section>
        <h3>Timings (ms since the server received the turn)</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Question</th>
                {MARK_COLUMNS.map((m) => (
                  <th key={m}>{m}</th>
                ))}
                <th>client: turn end → first audio played</th>
                <th>model</th>
                <th>tokens in / cached / reasoning / out</th>
                <th>TTS chars</th>
                <th>audio in (s)</th>
                <th>mic frames dropped</th>
                <th>interrupted</th>
                <th>error</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t, i) => (
                <TimingRow key={t.turnId} index={i + 1} turn={t} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>Log</h3>
        <ol className="log">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function TimingRow({ index, turn }: { index: number; turn: TurnView }) {
  const r = turn.record;
  const { clientTurnEnd, clientFirstAudioPlayed } = turn.clientMarks;
  const clientDelta =
    clientTurnEnd !== undefined && clientFirstAudioPlayed !== undefined ? clientFirstAudioPlayed - clientTurnEnd : null;
  return (
    <tr>
      <td>{index}</td>
      <td className="question">{turn.question}</td>
      {MARK_COLUMNS.map((m) => (
        <td key={m} className="num">
          {ms(r?.marks[m])}
        </td>
      ))}
      <td className="num">{ms(clientDelta ?? undefined)}</td>
      <td>{r?.model ?? "…"}</td>
      <td className="num">
        {r
          ? `${r.tokens.input} / ${r.tokens.cachedInput} / ${r.tokens.reasoning}${r.tokens.reasoningEstimated ? "~" : ""} / ${r.tokens.output}`
          : "…"}
      </td>
      <td className="num">{r?.ttsChars ?? "…"}</td>
      <td className="num">{r ? r.audioInSeconds.toFixed(1) : "…"}</td>
      <td className="num">{r?.droppedFrames ?? (r ? "–" : "…")}</td>
      <td>{r ? interruptedText(r, turn.stoppedAfterEnd) : "…"}</td>
      <td>{r?.error ?? ""}</td>
    </tr>
  );
}

async function resolveSource(key: string, chosenFile: File | null): Promise<MicSource> {
  if (key === "mic") return "mic";
  if (key === "file") {
    if (!chosenFile) throw new Error("choose a file first");
    return { file: await chosenFile.arrayBuffer() };
  }
  const url = FIXTURES[key];
  if (!url) throw new Error(`unknown test file ${key}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${key} (HTTP ${res.status})`);
  return { file: await res.arrayBuffer() };
}

async function fetchProviders(): Promise<string> {
  const res = await fetch("/assistant/health");
  const body: unknown = await res.json();
  if (!res.ok || typeof body !== "object" || body === null) throw new Error(`HTTP ${res.status}`);
  const providers = (body as { providers?: unknown }).providers;
  return typeof providers === "string" ? providers : JSON.stringify(providers ?? null);
}

function interruptedText(r: TurnRecord, after: TurnView["stoppedAfterEnd"]): string {
  if (!r.interrupted) return "no";
  if (!after) return "yes";
  return `yes, after turn.end (heard up to ${after.lastHeard ?? "none"})`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function ms(value: number | undefined): string {
  return value === undefined ? "–" : String(Math.round(value));
}

function clock(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Page-wide rules (body, colors, focus) live in styles.css.
const CSS = `
.spike { font-size: 15px; }
.spike h2 { margin: 0 0 4px; }
.spike h3 { margin: 24px 0 8px; font-size: 1rem; }
.spike .muted { color: light-dark(#555, #aaa); }
.spike .problem { color: light-dark(#a1001b, #ff8f8f); font-weight: 600; }
.spike .row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 12px 0; }
.spike button { font: inherit; padding: 6px 14px; }
.spike button.primary { font-weight: 600; }
.spike select, .spike input { font: inherit; max-width: 100%; }
.spike .status { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 16px 0; }
.spike .status dt { color: light-dark(#555, #aaa); }
.spike .status dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.spike .captions { padding-left: 1.5rem; }
.spike .scroll { overflow-x: auto; }
.spike table { border-collapse: collapse; font-size: 13px; }
.spike th, .spike td {
  border: 1px solid light-dark(#ccc, #444);
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
.spike th { font-weight: 600; background: light-dark(#f2f2f2, #222); }
.spike td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.spike td.question { min-width: 16rem; }
.spike .log {
  list-style: none;
  padding: 8px;
  margin: 0;
  max-height: 16rem;
  overflow-y: auto;
  border: 1px solid light-dark(#ccc, #444);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;
