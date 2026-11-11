import { z } from "zod";
import { parseRef } from "./refs";

const MAX_REFS = 8;

/** The one machine-readable line the model ends every reply with: `<meta>{...}</meta>`. */
export const DataLineSchema = z.object({
  refs: z
    .array(z.string())
    .max(MAX_REFS)
    .default([])
    .describe(
      `refs of the knowledge sections this reply used, most relevant first, at most ${MAX_REFS}; only refs that appear in the knowledge; [] if none`,
    ),
  show: z
    .string()
    .nullable()
    .default(null)
    .describe("one ref worth showing the visitor as a card, or null"),
  contact: z
    .boolean()
    .default(false)
    .describe("true only when the reply suggests contacting Yash directly through Messages"),
  coverage: z
    .enum(["direct", "adjacent", "none"])
    .describe(
      "direct when the knowledge answers the question, adjacent when it only has related evidence, none when it does not cover it",
    ),
});

export type DataLine = z.infer<typeof DataLineSchema>;

const EXAMPLE: DataLine = { refs: ["role:example", "skill:example"], show: null, contact: false, coverage: "direct" };

/** Prompt text for the data line, generated from the schema so the two cannot drift. */
export function dataLineInstructions(): string {
  const fields = Object.entries(DataLineSchema.shape).map(([key, field]) => {
    const options = field instanceof z.ZodEnum ? ` (one of ${field.options.map((o) => `"${o}"`).join(", ")})` : "";
    return `- ${key}${options}: ${field.description}`;
  });
  return [
    "# Data line",
    "End every reply with exactly one line of compact JSON wrapped in <meta> tags, after the reply text and with nothing after it, for example:",
    `<meta>${JSON.stringify(EXAMPLE)}</meta>`,
    "Fields:",
    ...fields,
    "The data line is never shown or read to the visitor.",
  ].join("\n");
}

export type DataLineResult = { ok: true; value: DataLine; dropped: string[] } | { ok: false; error: string };

/**
 * How a reply's data line came out: parsed ("ok"), never written ("missing"), or written but not
 * usable as one ("invalid"), which includes a bare `<refs>` list in its place.
 */
export type DataLineStatus = "ok" | "missing" | "invalid";

function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

const isKnown = (v: unknown, known: ReadonlySet<string>): v is string =>
  typeof v === "string" && parseRef(v) !== null && known.has(v);

/** The first MAX_REFS known refs of `values`, in order; everything else goes to `dropped`. */
function keepKnownRefs(values: readonly unknown[], known: ReadonlySet<string>): { refs: string[]; dropped: string[] } {
  const refs: string[] = [];
  const dropped: string[] = [];
  for (const ref of values) {
    if (isKnown(ref, known) && refs.length < MAX_REFS) refs.push(ref);
    else dropped.push(asText(ref));
  }
  return { refs, dropped };
}

/**
 * Parses the model's data line. Tolerates whitespace, the `<meta>` tags and a missing or cut-off
 * closing tag. Unknown, malformed or excess refs are dropped, and an unknown `show` becomes null;
 * everything dropped is listed in `dropped`. Anything else invalid is an error.
 */
export function parseDataLine(raw: string, known: ReadonlySet<string>): DataLineResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, error: "no JSON object in data line" };

  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `invalid JSON in data line: ${(e as Error).message}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "data line is not a JSON object" };
  }

  const obj: Record<string, unknown> = { ...json };
  const dropped: string[] = [];

  if (Array.isArray(obj.refs)) {
    const kept = keepKnownRefs(obj.refs, known);
    obj.refs = kept.refs;
    dropped.push(...kept.dropped);
  }
  if (obj.show !== undefined && obj.show !== null && !isKnown(obj.show, known)) {
    dropped.push(asText(obj.show));
    obj.show = null;
  }

  const parsed = DataLineSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: `invalid data line: ${issues.join("; ")}` };
  }
  return { ok: true, value: parsed.data, dropped };
}

/**
 * Reads the bare `<refs>a, b</refs>` list (comma or space separated) that a reply rarely ends with
 * instead of the data line. It is no data line: it says nothing of coverage or contact, so it never
 * becomes one, and its refs serve only as the answer's sources. Refs are kept and dropped as in
 * parseDataLine.
 */
export function parseRefsList(raw: string, known: ReadonlySet<string>): { refs: string[]; dropped: string[] } {
  return keepKnownRefs(raw.split(/[\s,]+/).filter(Boolean), known);
}
