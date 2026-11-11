import { z } from "zod";
import { DataLineSchema } from "../src/protocol/data-line";

/** A regular expression source, tested case-insensitively against the answer (curly quotes made straight). */
const Pattern = z
  .string()
  .min(1)
  .refine(
    (source) => {
      try {
        new RegExp(source, "i");
        return true;
      } catch {
        return false;
      }
    },
    { message: "not a valid regular expression" },
  );
const Text = z.string().min(1);
const Count = z.number().int().positive();

/**
 * One deterministic check on the last answer of a case. checks.ts implements each one; text checks
 * ignore case and treat curly quotes as straight ones.
 */
export const CheckSchema = z.discriminatedUnion("kind", [
  /**
   * The grounding check found no unsupported claim: no number the cited sections lack, and no name
   * found nowhere in the knowledge. Uncited claims (true, but from a section not cited) pass.
   */
  z.strictObject({ kind: z.literal("grounded") }),
  /** No phrasing that says or implies Yash lacks something ("doesn't have", "no experience", "lacks"). */
  z.strictObject({ kind: z.literal("noAdmission") }),
  /**
   * No saying the asked-about thing is missing ("isn't listed", "no record", "won't claim"): on a
   * first ask the rules want only the closest real evidence.
   */
  z.strictObject({ kind: z.literal("noDisclaimer") }),
  /** No he/him/his/himself/she/her/hers/herself. */
  z.strictObject({ kind: z.literal("noPronouns") }),
  /** None of the hype words the output gate flags, except one quoted from the question. */
  z.strictObject({ kind: z.literal("noHype") }),
  /** The output gate dropped no sentence (a link, an address, code, a copy of the question...). */
  z.strictObject({ kind: z.literal("noGateDrops") }),
  /** The data line parsed and cited only known refs. */
  z.strictObject({ kind: z.literal("metaValid") }),
  z.strictObject({ kind: z.literal("startsWith"), text: Text }),
  z.strictObject({ kind: z.literal("contains"), text: Text }),
  z.strictObject({ kind: z.literal("notContains"), text: Text }),
  z.strictObject({ kind: z.literal("matches"), pattern: Pattern }),
  z.strictObject({ kind: z.literal("notMatches"), pattern: Pattern }),
  /** The data line's `contact` flag. */
  z.strictObject({ kind: z.literal("contact"), value: z.boolean() }),
  /** The data line's `coverage` is one of these. */
  z.strictObject({ kind: z.literal("coverage"), oneOf: z.array(DataLineSchema.shape.coverage).min(1) }),
  /** The data line cites at least one of these refs. */
  z.strictObject({ kind: z.literal("refsInclude"), anyOf: z.array(Text).min(1) }),
  z.strictObject({ kind: z.literal("maxWords"), n: Count }),
  /** Sentences the visitor got (the early first clause voice cuts at a comma is not one). */
  z.strictObject({ kind: z.literal("maxSentences"), n: Count }),
]);
export type Check = z.infer<typeof CheckSchema>;

/**
 * One eval case. `turns` are visitor messages in order: earlier turns get real answers, which become
 * the history for the next one, and `expect` applies to the last answer. Safety cases run several
 * times and fail the suite on any failed run; quality cases run once and only report. `judge` asks
 * the model judge to score the last answer against `rubric`.
 */
export const CaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    category: z.enum(["safety", "quality"]),
    tags: z.array(Text),
    mode: z.enum(["text", "voice"]),
    turns: z.array(Text).min(1),
    expect: z.array(CheckSchema).min(1),
    judge: z.strictObject({ rubric: Text }).optional(),
  })
  .refine((c) => c.judge === undefined || c.turns.length === 1, {
    message: "a judged case has one turn: the judge sees only the last question",
  });
export type EvalCase = z.infer<typeof CaseSchema>;

export const CasesSchema = z
  .array(CaseSchema)
  .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, { message: "case ids must be unique" });
