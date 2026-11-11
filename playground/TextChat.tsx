import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { AssistantHttpError, ask, startSession } from "../src/client/text-chat";
import { getTurnstileToken, TEST_SITE_KEY } from "../src/client/turnstile";
import { DEFAULT_BASE_URL } from "../src/client/urls";
import { MAX_MESSAGE_CHARS, type SessionResponse } from "../src/protocol/chat";
import type { DataLine } from "../src/protocol/data-line";
import type { ServerEvent, Source } from "../src/protocol/events";
import type { TurnRecord } from "../src/protocol/turn-record";
import { Inspector } from "./Inspector";

const STARTERS = [
  "Where does Yash work now?",
  "What has Yash built with AI?",
  "Why hire Yash for a full-stack role?",
  "How were you built?",
];

/** Fixed text with no model call, so it shows at once and says up front that this is an AI. */
const GREETING = "Hi, I'm Yash's AI assistant. Ask me about Yash's work, projects and skills.";

/**
 * The playground has no YashOS windows, so both point at the site. In YashOS they become
 * openResume() and the Messages hand-over with a draft note.
 */
const RESUME_URL = "https://yashos.dev";
const MESSAGES_URL = "https://yashos.dev";

/** The character counter appears this close to the cap, so ordinary questions never see it. */
const COUNTER_FROM = MAX_MESSAGE_CHARS - 400;
/** A session this close to expiring is replaced before the next question rather than failing it. */
const SESSION_MARGIN_MS = 60_000;

const EXPIRED = "This conversation expired, so earlier questions won't be remembered. Send again to start a new one.";

type Status = "thinking" | "answering" | "done" | "stopped" | "failed";

/**
 * Why an answer is incomplete. `cut_off`: the connection dropped, so asking again usually works.
 * `failed`: the server sent an error, after its one retry of the model, so Messages is offered too.
 */
type Problem = "cut_off" | "failed";
const PROBLEMS: Record<Problem, string> = {
  cut_off: "The connection dropped before the answer finished. Please ask again.",
  failed: "The assistant couldn't finish this answer. You can ask again, or message Yash directly.",
};

interface Turn {
  key: number;
  question: string;
  sentences: { id: number; text: string }[];
  /** From `meta`, or from `sources` (data null) when the reply had no valid data line but named refs. */
  meta: { data: DataLine | null; sources: Source[] } | null;
  record: TurnRecord | null;
  status: Status;
  /** Why the answer is incomplete, once the server has taken the question. */
  problem: Problem | null;
}

/** States that replace the composer: this conversation's questions are used up, or the day's. */
type Notice = "limit" | "resting";

/**
 * Text chat against the local Worker. The session (Turnstile, then `POST /session`) starts when the
 * page opens, so the first question doesn't wait for it. A question the server refused (busy, rate
 * limited, expired) never entered the conversation: it leaves the list, goes back in the box, and a
 * hint says why. A question it took stays, with whatever was shown and a note if it was cut short.
 */
export function TextChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const sessionRef = useRef<Promise<SessionResponse> | null>(null);
  const activeRef = useRef<AbortController | null>(null);
  const nextKey = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The notice card's title, which takes focus when the card replaces the focused composer. */
  const noticeRef = useRef<HTMLParagraphElement>(null);
  /** Whether the page is scrolled to the end, so a growing answer keeps it there. */
  const followRef = useRef(true);
  /**
   * The session that took the questions on screen. Its history lives on the server, so a question
   * sent with a different one would be answered without the thread above it.
   */
  const answeredBy = useRef<string | null>(null);

  /** The current session; a new one when there is none, the last attempt failed, or it is about to expire. */
  async function ensureSession(): Promise<SessionResponse> {
    const pending = sessionRef.current;
    if (pending) {
      const session = await pending.catch(() => null);
      if (session && session.expiresAt - Date.now() > SESSION_MARGIN_MS) return session;
      if (sessionRef.current === pending) sessionRef.current = null;
    }
    sessionRef.current ??= getTurnstileToken(TEST_SITE_KEY).then((turnstile) =>
      startSession({ baseUrl: DEFAULT_BASE_URL, turnstile }),
    );
    return sessionRef.current;
  }

  function warmUp() {
    // A failure here resurfaces, with its reason, on the first question.
    ensureSession().then(
      (session) => {
        if (session.resting) setNotice("resting");
      },
      () => {},
    );
  }

  // The ref keeps StrictMode's second effect run from starting a second session.
  useEffect(warmUp, []);
  useEffect(() => () => activeRef.current?.abort(), []);

  useEffect(() => {
    const onScroll = () => {
      followRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 64;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (turns.length > 0 && followRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [turns]);

  // A notice unmounts the composer; if it had focus, focus fell to <body> and the next Tab would skip
  // the card. Focusing the card's title keeps keyboard visitors in place and has it read out.
  useEffect(() => {
    if (notice && document.activeElement === document.body) noticeRef.current?.focus();
  }, [notice]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || activeRef.current || notice) return;
    const controller = new AbortController();
    activeRef.current = controller;
    const key = nextKey.current++;
    const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.key === key ? fn(t) : t)));
    const withdraw = () => setTurns((ts) => ts.filter((t) => t.key !== key));
    let started = false;

    setStreaming(true);
    setHint(null);
    setInput("");
    followRef.current = true;
    setTurns((ts) => [
      ...ts,
      { key, question: message, sentences: [], meta: null, record: null, status: "thinking", problem: null },
    ]);

    try {
      const session = await ensureSession();
      if (session.resting) {
        withdraw();
        setNotice("resting");
        return;
      }
      if (answeredBy.current && answeredBy.current !== session.token) {
        // The session expired (or was about to) and ensureSession() replaced it: say so before a
        // follow-up like "what stack did that use?" goes to an empty history.
        answeredBy.current = null;
        withdraw();
        setInput((current) => current || message);
        setHint(EXPIRED);
        return;
      }
      await ask({
        baseUrl: DEFAULT_BASE_URL,
        token: session.token,
        message,
        signal: controller.signal,
        onEvent: (e) => {
          started = true;
          answeredBy.current = session.token;
          if (e.type === "error" && (e.code === "limit" || e.code === "resting")) setNotice(e.code);
          update((t) => applyEvent(t, e));
        },
      });
      update((t) => (t.status === "thinking" || t.status === "answering" ? { ...t, status: "failed", problem: "cut_off" } : t));
    } catch (err) {
      if (controller.signal.aborted) {
        update((t) => ({ ...t, status: "stopped" }));
      } else if (started) {
        update((t) => ({ ...t, status: "failed", problem: t.problem ?? "cut_off" }));
      } else {
        withdraw();
        setInput((current) => current || message);
        if (err instanceof AssistantHttpError && (err.code === "limit" || err.code === "resting")) {
          setNotice(err.code);
        } else {
          if (err instanceof AssistantHttpError && err.code === "auth") {
            // The hint below already says the conversation expired; the next session should not say it again.
            sessionRef.current = null;
            answeredBy.current = null;
          }
          setHint(refusalHint(err));
        }
      }
    } finally {
      activeRef.current = null;
      setStreaming(false);
    }
  }

  function stop() {
    activeRef.current?.abort();
  }

  function startOver() {
    stop();
    sessionRef.current = null;
    answeredBy.current = null;
    setTurns([]);
    setNotice(null);
    setHint(null);
    warmUp();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && streaming) {
      e.preventDefault();
      stop();
      return;
    }
    // Safari fires the Enter that accepts an IME candidate after compositionend, with isComposing
    // false but keyCode 229; without that check it would send a half-typed Japanese or Chinese question.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    void send(input);
  }

  function pickStarter(question: string) {
    void send(question);
    // Keep keyboard focus in the box (the chips go away); on touch screens this would pop the keyboard up.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }

  return (
    <section className="chat" aria-label="Text chat">
      <div className="messages" role="log" aria-label="Conversation">
        <p className="greeting">{GREETING}</p>
        {turns.map((turn) => (
          <TurnView key={turn.key} turn={turn} />
        ))}
      </div>

      {turns.length === 0 && !notice && (
        <ul className="starters" aria-label="Suggested questions">
          {STARTERS.map((q) => (
            <li key={q}>
              <button type="button" className="chip" onClick={() => pickStarter(q)}>
                {q}
              </button>
            </li>
          ))}
        </ul>
      )}

      {notice === "resting" && <RestingCard titleRef={noticeRef} />}
      {notice === "limit" && <LimitCard titleRef={noticeRef} onStartOver={startOver} />}

      {!notice && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          {hint && (
            <p className="hint" role="alert">
              {hint}
            </p>
          )}
          <label className="sr-only" htmlFor="chat-input">
            Your question
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={2}
            maxLength={MAX_MESSAGE_CHARS}
            placeholder="Ask about Yash's work, projects or skills"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-bar">
            <span className="counter" aria-live="polite">
              {input.length >= COUNTER_FROM &&
                `${input.length.toLocaleString()} / ${MAX_MESSAGE_CHARS.toLocaleString()} characters`}
            </span>
            {streaming ? (
              // Stop replaces Send in the same spot (React reuses the node), so the second click of a
              // double-clicked Send lands here. That click has detail 2 and is ignored; a single
              // click (1) or a key press (0) still stops.
              <button
                type="button"
                className="button"
                onClick={(e) => {
                  if (e.detail <= 1) stop();
                }}
              >
                Stop
              </button>
            ) : (
              <button type="submit" className="button primary" disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </form>
      )}

      <p className="footnote">
        This is an AI assistant, and answers can be wrong. Your messages go to MiniMax, which writes the replies, so
        please don't share personal details.{!notice && " Enter sends, Shift+Enter adds a line."}
      </p>
    </section>
  );
}

function applyEvent(t: Turn, e: ServerEvent): Turn {
  switch (e.type) {
    case "sentence":
      if (t.status !== "thinking" && t.status !== "answering") return t;
      return { ...t, status: "answering", sentences: [...t.sentences, { id: e.id, text: e.text }] };
    case "meta":
      return { ...t, meta: { data: e.data, sources: e.sources } };
    case "sources":
      return { ...t, meta: { data: null, sources: e.sources } };
    case "turn.end":
      return { ...t, record: e.record, status: t.status === "failed" ? "failed" : "done" };
    case "error":
      return { ...t, status: "failed", problem: "failed" };
    default:
      return t;
  }
}

/** Why a question the server never took was refused, and what to do next. */
function refusalHint(err: unknown): string {
  if (!(err instanceof AssistantHttpError)) {
    const reason = err instanceof Error ? err.message : String(err);
    return `Couldn't reach the assistant (${reason}). Check the connection and send again.`;
  }
  switch (err.code) {
    case "busy":
      return "Still finishing the last answer. Send again in a moment.";
    case "rate_limited":
      return "That's a lot of questions in a minute. Wait a moment, then send again.";
    case "auth":
      return "This conversation expired. Send again to start a new one.";
    case "bad_request":
      return "That message couldn't be sent. Try a shorter question.";
    default:
      return `The assistant couldn't take that question (${err.message}). Send again in a moment.`;
  }
}

function TurnView({ turn }: { turn: Turn }) {
  const answer = turn.sentences.map((s) => s.text).join(" ");
  const sources = turn.meta?.sources ?? [];
  return (
    <article className="turn">
      <p className="question">{turn.question}</p>
      <div className="answer">
        {answer ? (
          <p className="answer-text">{answer}</p>
        ) : (
          turn.status === "thinking" && (
            <p className="thinking">
              Thinking<span className="dots" aria-hidden="true" />
            </p>
          )
        )}
        {turn.status === "stopped" && <p className="note">{answer ? "Stopped." : "Stopped before the answer started."}</p>}
        {turn.problem === "cut_off" && <p className="note problem">{PROBLEMS.cut_off}</p>}
        {sources.length > 0 && (
          <ul className="sources" aria-label="Sources">
            {sources.map((s) => (
              <li key={s.ref} title={s.ref}>
                {s.title}
              </li>
            ))}
          </ul>
        )}
        {turn.problem === "failed" ? (
          <MessagesCard text={PROBLEMS.failed} problem />
        ) : (
          turn.meta?.data?.contact && <MessagesCard text="The best way to reach Yash is Messages." />
        )}
        {turn.record && (
          <Inspector record={turn.record} meta={turn.meta?.data ?? null} refs={sources.map((s) => s.ref)} />
        )}
      </div>
    </article>
  );
}

/** Messages, offered when the model sets `contact` and when an answer fails. */
function MessagesCard({ text, problem = false }: { text: string; problem?: boolean }) {
  return (
    <div className="card">
      <p className={problem ? "problem" : undefined}>{text}</p>
      <div className="actions">
        <a className="button primary" href={MESSAGES_URL} target="_blank" rel="noreferrer">
          Message Yash
        </a>
      </div>
    </div>
  );
}

function RestingCard({ titleRef }: { titleRef: Ref<HTMLParagraphElement> }) {
  return (
    <div className="card" role="status">
      <p className="card-title" tabIndex={-1} ref={titleRef}>
        The assistant is resting for today.
      </p>
      <p>Yash is a full-stack and AI engineer, open to new roles.</p>
      <div className="actions">
        <a className="button" href={RESUME_URL} target="_blank" rel="noreferrer">
          Open the resume
        </a>
        <a className="button primary" href={MESSAGES_URL} target="_blank" rel="noreferrer">
          Message Yash
        </a>
      </div>
    </div>
  );
}

function LimitCard({ titleRef, onStartOver }: { titleRef: Ref<HTMLParagraphElement>; onStartOver(): void }) {
  return (
    <div className="card" role="status">
      <p className="card-title" tabIndex={-1} ref={titleRef}>
        This conversation has reached its question limit.
      </p>
      <p>Yash can pick it up from here, or you can start a new conversation.</p>
      <div className="actions">
        <button type="button" className="button" onClick={onStartOver}>
          Start a new conversation
        </button>
        <a className="button primary" href={MESSAGES_URL} target="_blank" rel="noreferrer">
          Message Yash
        </a>
      </div>
    </div>
  );
}
