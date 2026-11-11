import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { ChatMessage } from "../src/client/assistant-session";
import { AssistantSession } from "../src/client/assistant-session";
import { DISCLOSURE } from "../src/client/disclosure";
import { useAssistant } from "../src/client/react";
import { getTurnstileToken, TEST_SITE_KEY } from "../src/client/turnstile";
import { DEFAULT_BASE_URL } from "../src/client/urls";
import { MAX_MESSAGE_CHARS } from "../src/protocol/chat";
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

/** What a failed answer says. Codes not listed (provider, internal, protocol) get the Messages card. */
const PROBLEMS: Partial<Record<NonNullable<ChatMessage["error"]>, string>> = {
  unknown: "The connection dropped before the answer finished. Please ask again.",
  busy: "Still finishing the last answer. Send again in a moment.",
  rate_limited: "That's a lot of questions in a minute. Wait a moment, then send again.",
  bad_request: "That message couldn't be sent. Try a shorter question.",
};
const FAILED = "The assistant couldn't finish this answer. You can ask again, or message Yash directly.";

function newSession() {
  return new AssistantSession({
    baseUrl: DEFAULT_BASE_URL,
    turnstileToken: () => getTurnstileToken(TEST_SITE_KEY),
  });
}

/**
 * Text chat against the local Worker, bound to one AssistantSession. The session starts when the
 * page opens, so the first question doesn't wait for it. A question the server refused stays in
 * the list with its reason; one it took stays too, with whatever was shown and a note if it was
 * cut short.
 */
export function TextChat() {
  const [session, setSession] = useState(newSession);
  const { status, busy, limitReached, notice: sessionNotice, messages } = useAssistant(session);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The notice card's title, which takes focus when the card replaces the focused composer. */
  const noticeRef = useRef<HTMLParagraphElement>(null);
  /** Whether the page is scrolled to the end, so a growing answer keeps it there. */
  const followRef = useRef(true);

  // start() is idempotent, so StrictMode's second effect run does not start a second session.
  useEffect(() => {
    void session.start();
    return () => session.stop();
  }, [session]);

  useEffect(() => {
    const onScroll = () => {
      followRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 64;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (messages.length > 0 && followRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [messages]);

  /** States that replace the composer: this conversation's questions are used up, or the day's. */
  const card = status === "resting" ? "resting" : limitReached ? "limit" : null;

  // A card unmounts the composer; if it had focus, focus fell to <body> and the next Tab would skip
  // the card. Focusing the card's title keeps keyboard visitors in place and has it read out.
  useEffect(() => {
    if (card && document.activeElement === document.body) noticeRef.current?.focus();
  }, [card]);

  function send(text: string) {
    if (!text.trim() || busy || card) return;
    followRef.current = true;
    setInput("");
    void session.ask(text);
  }

  function startOver() {
    session.dispose();
    setInput("");
    setSession(newSession());
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      session.stop();
      return;
    }
    // Safari fires the Enter that accepts an IME candidate after compositionend, with isComposing
    // false but keyCode 229; without that check it would send a half-typed Japanese or Chinese question.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    send(input);
  }

  function pickStarter(question: string) {
    send(question);
    // Keep keyboard focus in the box (the chips go away); on touch screens this would pop the keyboard up.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }

  const turns: { question: ChatMessage; answer: ChatMessage | undefined }[] = [];
  for (let i = 0; i < messages.length; i += 2) turns.push({ question: messages[i]!, answer: messages[i + 1] });

  return (
    <section className="chat" aria-label="Text chat">
      <p className="disclosure">{DISCLOSURE}</p>
      <div className="messages" role="log" aria-label="Conversation">
        <p className="greeting">{GREETING}</p>
        {turns.map(({ question, answer }) => (
          <TurnView key={question.id} question={question} answer={answer} />
        ))}
      </div>

      {messages.length === 0 && !card && (
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

      {card === "resting" && <RestingCard titleRef={noticeRef} />}
      {card === "limit" && <LimitCard titleRef={noticeRef} onStartOver={startOver} />}

      {!card && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          {sessionNotice && (
            <p className="hint" role="status">
              {sessionNotice}
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
            {busy ? (
              // Stop replaces Send in the same spot (React reuses the node), so the second click of a
              // double-clicked Send lands here. That click has detail 2 and is ignored; a single
              // click (1) or a key press (0) still stops.
              <button
                type="button"
                className="button"
                onClick={(e) => {
                  if (e.detail <= 1) session.stop();
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

      {!card && <p className="footnote">Enter sends, Shift+Enter adds a line.</p>}
    </section>
  );
}

function TurnView({ question, answer }: { question: ChatMessage; answer: ChatMessage | undefined }) {
  const sources = answer?.sources ?? [];
  const error = answer?.error;
  const problem = error && error !== "limit" && error !== "resting" ? error : null;
  return (
    <article className="turn">
      <p className="question">{question.text}</p>
      {answer && (
        <div className="answer">
          {answer.text ? (
            <p className="answer-text">{answer.text}</p>
          ) : (
            answer.pending && (
              <p className="thinking">
                Thinking<span className="dots" aria-hidden="true" />
              </p>
            )
          )}
          {answer.stopped && <p className="note">{answer.text ? "Stopped." : "Stopped before the answer started."}</p>}
          {problem && PROBLEMS[problem] && <p className="note problem">{PROBLEMS[problem]}</p>}
          {sources.length > 0 && (
            <ul className="sources" aria-label="Sources">
              {sources.map((s) => (
                <li key={s.ref} title={s.ref}>
                  {s.title}
                </li>
              ))}
            </ul>
          )}
          {problem && !PROBLEMS[problem] ? (
            <MessagesCard text={FAILED} problem />
          ) : (
            answer.contact && <MessagesCard text="The best way to reach Yash is Messages." />
          )}
          {answer.record && <Inspector record={answer.record} coverage={answer.coverage} refs={sources.map((s) => s.ref)} />}
        </div>
      )}
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
