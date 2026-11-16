/**
 * What a visitor sees before asking anything. Kept in one client module so this repo's playground
 * and the site that copies src/client show the same words.
 */

/** Fixed text with no model call, so it shows at once and says up front that this is an AI. */
export const GREETING = "Hi, I'm Yash's AI assistant. Ask about Yash's work and I'll show where each answer comes from.";

export interface Starter {
  id: "fit" | "ai" | "built";
  text: string;
  /** A small label shown beside the starter, for who it is meant for. */
  note?: string;
}

/** The questions offered as chips. Clicking one asks its text. */
export const STARTERS: readonly Starter[] = [
  { id: "fit", text: "Is Yash a fit for my role?" },
  { id: "ai", text: "What has Yash built with AI?" },
  { id: "built", text: "How were you built?", note: "for engineers" },
];

/** Further questions, listed beneath the starters. */
export const MORE_QUESTIONS: readonly string[] = [
  "What does Yash do now?",
  "Why hire Yash?",
  "What is Yash's strongest project?",
  "Where is Yash based, and is remote OK?",
  "What is Yash still learning?",
];
