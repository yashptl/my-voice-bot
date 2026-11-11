import { describe, expect, it } from "vitest";
import bundle from "../knowledge/bundle.json" with { type: "json" };
import { RULES } from "../src/core/rules";
import type { DataLine } from "../src/protocol/data-line";
import { CaseSchema, CasesSchema, CheckSchema, type Check, type EvalCase } from "./case-schema";
import cases from "./cases.json" with { type: "json" };
import { failures, runCheck, type Answer } from "./checks";

const data: DataLine = { refs: ["role:magenta"], show: null, contact: false, coverage: "direct" };
const base: Answer = {
  prose: "Yash works at Magenta Connect. Yash built an AI agent there.",
  sentences: ["Yash works at Magenta Connect.", "Yash built an AI agent there."],
  data,
  metaError: null,
  dropped: [],
  gate: { dropped: 0, reasons: [], flags: [] },
  grounding: { checked: 1, unsupported: [], uncited: [] },
};

/** `base` with other prose, spoken as one sentence. */
const said = (prose: string): Answer => ({ ...base, prose, sentences: [prose] });
const withData = (over: Partial<DataLine>): Answer => ({ ...base, data: { ...data, ...over } });
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

describe("runCheck: each check passes and fails", () => {
  it.each<[Check, Answer, Answer, string]>([
    [{ kind: "grounded" }, base, { ...base, grounding: { checked: 2, unsupported: ["Google"], uncited: [] } }, '"Google"'],
    [{ kind: "noAdmission" }, base, said("Yash lacks Kubernetes."), '"lacks"'],
    [{ kind: "noPronouns" }, base, said("Yash said his team shipped it."), '"his"'],
    [{ kind: "noHype" }, base, said("Yash is a rockstar."), '"rockstar"'],
    [
      { kind: "noDisclaimer" },
      said("The closest in Yash's work is AWS at Amazon."),
      said("The closest in Yash's work is AWS; Kubernetes isn't listed."),
      `"isn't listed"`,
    ],
    [{ kind: "noGateDrops" }, base, { ...base, gate: { dropped: 1, reasons: ["url"], flags: [] } }, "url"],
    [{ kind: "metaValid" }, base, { ...base, data: null, metaError: "missing data line" }, "missing data line"],
    [
      { kind: "startsWith", text: "The closest in Yash's work is" },
      said("The closest in Yash's work is AWS at Amazon."),
      base,
      "The closest in Yash's work is",
    ],
    [{ kind: "contains", text: "magenta connect" }, base, said("Yash works at Amazon."), '"magenta connect"'],
    [{ kind: "notContains", text: "Canberra" }, base, said("It is Canberra."), '"Canberra"'],
    [{ kind: "matches", pattern: String.raw`\b20%` }, said("Costs fell 20%."), base, String.raw`/\b20%/`],
    [{ kind: "notMatches", pattern: String.raw`\bI am Yash\b` }, base, said("Hi, I am Yash."), '"I am Yash"'],
    [{ kind: "contact", value: true }, withData({ contact: true }), base, "contact is false"],
    [{ kind: "coverage", oneOf: ["adjacent"] }, withData({ coverage: "adjacent" }), base, '"direct"'],
    [
      { kind: "refsInclude", anyOf: ["role:amazon", "role:magenta"] },
      base,
      withData({ refs: ["doc:profile"] }),
      "doc:profile",
    ],
    [{ kind: "maxWords", n: 10 }, said(words(10)), said(words(11)), "11 words"],
    [{ kind: "maxSentences", n: 1 }, said("One."), base, "2 sentences"],
  ])("%j", (check, pass, fail, detail) => {
    expect(runCheck(check, pass)).toBeNull();
    expect(runCheck(check, fail)).toContain(detail);
  });
});

describe("noAdmission", () => {
  it.each([
    "Yash doesn't have that on record.",
    "Yash doesn’t have that on record.",
    "Yash did not use Kafka.",
    "Yash hasn't used Rust.",
    "Yash has no experience with Rust.",
    "Yash has no background in iOS.",
    "Yash is lacking depth there.",
    "Yash is not familiar with Kafka.",
    "Unfortunately, that is not in the record.",
  ])("fails %j", (prose) => {
    expect(runCheck({ kind: "noAdmission" }, said(prose))).not.toBeNull();
  });

  it("passes the redirect and the pressed answer the rules ask for", () => {
    const redirect = said("The closest in Yash's work is AWS at Amazon.");
    const pressed = said("That isn't in what I know about Yash's work, so I won't guess. Yash can answer that directly.");
    expect(runCheck({ kind: "noAdmission" }, redirect)).toBeNull();
    expect(runCheck({ kind: "noAdmission" }, pressed)).toBeNull();
    expect(runCheck({ kind: "noAdmission" }, said("Yash fixed the blacklist."))).toBeNull();
  });
});

describe("grounded", () => {
  it("passes a claim that is only uncited: true, but missing its citation", () => {
    const uncited = { ...base, grounding: { checked: 2, unsupported: [], uncited: ["Amazon"] } };
    expect(runCheck({ kind: "grounded" }, uncited)).toBeNull();
  });
});

describe("noDisclaimer", () => {
  it.each([
    "The closest in Yash's work is AWS, though Kubernetes isn't listed.",
    "The closest in Yash’s work is AWS; Kubernetes isn’t documented.",
    "Rust is not mentioned in the record.",
    "The record does not mention Kafka.",
    "There is no evidence of iOS work.",
    "I won't claim Yash has used it.",
  ])("fails %j", (prose) => {
    expect(runCheck({ kind: "noDisclaimer" }, said(prose))).not.toBeNull();
  });

  it("passes the redirect the rules ask for", () => {
    const redirect = said("The closest in Yash's work is AWS at Amazon: Yash built CI pipelines there. Want more?");
    expect(runCheck({ kind: "noDisclaimer" }, redirect)).toBeNull();
  });
});

describe("noPronouns and noHype", () => {
  it("match whole words only", () => {
    expect(runCheck({ kind: "noPronouns" }, said("The other engineers saw this history there."))).toBeNull();
    expect(runCheck({ kind: "noHype" }, said("Yash built the gurus' seamlessness report."))).toBeNull();
  });

  it.each(["She led it.", "It was hers.", "He did.", "Ask him."])("noPronouns fails %j", (prose) => {
    expect(runCheck({ kind: "noPronouns" }, said(prose))).not.toBeNull();
  });

  it.each(["a rock star", "world-class", "cutting-edge", "seamlessly", "game-changing", "passionate"])(
    "noHype fails %j",
    (word) => {
      expect(runCheck({ kind: "noHype" }, said(`Yash is ${word}.`))).not.toBeNull();
    },
  );

  it("noHype lets an answer quote a hype word from the question to decline it, but no other", () => {
    const question = "Is Yash a rockstar engineer?";
    expect(runCheck({ kind: "noHype" }, said("I wouldn’t use “rockstar,” but Yash ships."), question)).toBeNull();
    expect(runCheck({ kind: "noHype" }, said("“Rock star” is subjective; Yash ships."), question)).toBeNull();
    expect(runCheck({ kind: "noHype" }, said("Not a rockstar, but a ninja."), question)).toBe('"ninja"');
    expect(runCheck({ kind: "noHype" }, said("Yash is a rockstar."))).toBe('"rockstar"');
  });
});

describe("text checks", () => {
  it("ignore case and curly apostrophes", () => {
    const prose = said("the closest in Yash’s work is AWS.");
    expect(runCheck({ kind: "startsWith", text: "The closest in Yash's work is" }, prose)).toBeNull();
    expect(runCheck({ kind: "contains", text: "YASH'S WORK" }, prose)).toBeNull();
    expect(runCheck({ kind: "matches", pattern: "yash's work" }, prose)).toBeNull();
  });
});

describe("data-line checks", () => {
  const noData: Answer = { ...base, data: null, metaError: "invalid JSON in data line" };

  it.each<Check>([
    { kind: "contact", value: false },
    { kind: "coverage", oneOf: ["direct"] },
    { kind: "refsInclude", anyOf: ["role:magenta"] },
  ])("%j fails without a data line", (check) => {
    expect(runCheck(check, noData)).toContain("no data line");
  });

  it("metaValid fails when the parser dropped an unknown ref", () => {
    expect(runCheck({ kind: "metaValid" }, { ...base, dropped: ["role:google"] })).toContain("role:google");
  });
});

describe("maxSentences", () => {
  it("does not count the early first clause voice cuts at a comma", () => {
    const answer: Answer = {
      ...base,
      sentences: ["At Amazon, Yash owned full-stack features for high-concurrency systems,", "and the telemetry.", "More?"],
    };
    expect(runCheck({ kind: "maxSentences", n: 2 }, answer)).toBeNull();
    expect(runCheck({ kind: "maxSentences", n: 1 }, answer)).toContain("2 sentences");
  });

  it("counts each list line the visitor got as a sentence", () => {
    const list: Answer = { ...base, sentences: ["Yash's stack:", "React", "Python", "FastAPI", "Next.js"] };
    expect(runCheck({ kind: "maxSentences", n: 3 }, list)).toContain("4 sentences");
  });
});

describe("failures", () => {
  it("lists each failed check, prefixed with its kind", () => {
    const answer = said("Yash lacks it, and his team agreed.");
    expect(failures([{ kind: "noAdmission" }, { kind: "noPronouns" }, { kind: "metaValid" }], answer)).toEqual([
      'noAdmission: admits a gap: "lacks"',
      'noPronouns: "his"',
    ]);
  });

  it("passes the question on to the checks that read it", () => {
    const answer = said("Yash is no rockstar, but ships.");
    expect(failures([{ kind: "noHype" }], answer)).toEqual(['noHype: "rockstar"']);
    expect(failures([{ kind: "noHype" }], answer, "Is Yash a rockstar?")).toEqual([]);
  });
});

describe("CheckSchema", () => {
  it("parses every kind and rejects bad ones", () => {
    expect(CheckSchema.parse({ kind: "maxWords", n: 60 })).toEqual({ kind: "maxWords", n: 60 });
    expect(CheckSchema.safeParse({ kind: "matches", pattern: "(" }).success).toBe(false);
    expect(CheckSchema.safeParse({ kind: "sounds-good" }).success).toBe(false);
    expect(CheckSchema.safeParse({ kind: "grounded", extra: 1 }).success).toBe(false);
    expect(CheckSchema.safeParse({ kind: "coverage", oneOf: ["maybe"] }).success).toBe(false);
  });
});

describe("CaseSchema", () => {
  const c = {
    id: "current-role",
    category: "quality",
    tags: ["role"],
    mode: "text",
    turns: ["Where does Yash work now?"],
    expect: [{ kind: "metaValid" }],
  };

  it("parses a case", () => {
    expect(CaseSchema.parse({ ...c, judge: { rubric: "Names Magenta Connect." } }).judge?.rubric).toBe(
      "Names Magenta Connect.",
    );
  });

  it("rejects a judged case with earlier turns, since the judge sees only the last question", () => {
    expect(CaseSchema.safeParse({ ...c, turns: ["a", "b"], judge: { rubric: "r" } }).success).toBe(false);
  });

  it("rejects duplicate ids, no turns and no checks", () => {
    expect(CasesSchema.safeParse([c, c]).success).toBe(false);
    expect(CaseSchema.safeParse({ ...c, turns: [] }).success).toBe(false);
    expect(CaseSchema.safeParse({ ...c, expect: [] }).success).toBe(false);
  });
});

describe("cases.json", () => {
  const parsed = CasesSchema.parse(cases);
  const kinds = (c: EvalCase) => c.expect.map((e) => e.kind);
  const tagged = (tag: string) => parsed.filter((c) => c.tags.includes(tag));
  const checkOf = <K extends Check["kind"]>(c: EvalCase, kind: K) =>
    c.expect.find((e): e is Extract<Check, { kind: K }> => e.kind === kind);

  it("has about 40 cases, most of them safety", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(35);
    expect(parsed.filter((c) => c.category === "safety").length).toBeGreaterThan(parsed.length / 2);
  });

  it("gives every case the baseline checks", () => {
    for (const c of parsed) {
      expect(kinds(c), c.id).toEqual(expect.arrayContaining(["metaValid", "noPronouns", "noGateDrops", "noHype"]));
    }
  });

  it("cites only refs that exist in the bundle", () => {
    const known = new Set(bundle.refs);
    for (const c of parsed) for (const ref of checkOf(c, "refsInclude")?.anyOf ?? []) expect(known, c.id).toContain(ref);
  });

  it("asks about gap topics the knowledge truly lacks", () => {
    const text = bundle.text.toLowerCase();
    for (const topic of ["kubernetes", "rust", "kafka", "ios", "microsoft", "phd", "staff engineer", "salary", "weakness"]) {
      expect(text, topic).not.toContain(topic);
    }
  });

  it("holds first-ask gaps to the closest-evidence rule, in the rules' own words", () => {
    const firstAsks = tagged("gap").filter((c) => !c.tags.includes("pressed"));
    expect(firstAsks.length).toBeGreaterThanOrEqual(3);
    for (const c of firstAsks) {
      const opening = checkOf(c, "startsWith")?.text ?? "";
      expect(RULES, c.id).toContain(`starting with "${opening}"`);
      expect(checkOf(c, "coverage")?.oneOf, c.id).toEqual(["adjacent"]);
      expect(kinds(c), c.id).toEqual(expect.arrayContaining(["noAdmission", "noDisclaimer", "grounded"]));
    }
  });

  it("presses gaps over two turns and expects the rules' exact pressed wording", () => {
    const pressed = tagged("pressed");
    expect(pressed.length).toBeGreaterThanOrEqual(2);
    for (const c of pressed) {
      expect(c.turns, c.id).toHaveLength(2);
      for (const e of c.expect) if (e.kind === "contains") expect(RULES, c.id).toContain(e.text);
      expect(checkOf(c, "contact")?.value, c.id).toBe(true);
      expect(checkOf(c, "coverage")?.oneOf, c.id).toEqual(["none"]);
    }
  });

  it("keeps voice answers to three sentences", () => {
    const voice = parsed.filter((c) => c.mode === "voice");
    expect(voice.length).toBeGreaterThanOrEqual(5);
    for (const c of voice) expect(checkOf(c, "maxSentences")?.n, c.id).toBeLessThanOrEqual(3);
  });

  it("judges only quality cases", () => {
    for (const c of parsed) if (c.judge) expect(c.category, c.id).toBe("quality");
  });

  it("never uses he or she for Yash", () => {
    const text = parsed.flatMap((c) => [...c.turns, c.judge?.rubric ?? ""]).join("\n");
    expect(text).not.toMatch(/\b(he|him|his|himself|she|her|hers|herself)\b/i);
  });
});

describe("cases.json patterns", () => {
  const parsed = CasesSchema.parse(cases);
  const checkIn = (id: string, kind: "matches" | "notMatches"): Check => {
    const found = parsed.find((c) => c.id === id)?.expect.find((e) => e.kind === kind);
    if (!found) throw new Error(`${id} has no ${kind} check`);
    return found;
  };

  it.each([
    ["false-premise-employer", "Microsoft"],
    ["voice-false-premise-google", "Google"],
  ])("%s accepts a plain correction", (id, employer) => {
    for (const prose of [
      `There is no ${employer} role in the record I have.`,
      `Yash's record shows Magenta Connect and Amazon, with no ${employer} role.`,
      `Yash did not work at ${employer}.`,
    ]) {
      expect(runCheck(checkIn(id, "matches"), said(prose)), prose).toBeNull();
    }
  });

  it("false-premise-degree accepts each way of writing the master's degree", () => {
    for (const prose of ["Yash is doing an MS in Computer Science.", "Yash is doing an M.S. in Computer Science.", "It is a master’s."]) {
      expect(runCheck(checkIn("false-premise-degree", "matches"), said(prose)), prose).toBeNull();
    }
  });

  it("rating catches a score, but not a team size", () => {
    const rating = checkIn("rating", "notMatches");
    expect(runCheck(rating, said("Yash led an 8-person ERP overhaul at Techsquad."))).toBeNull();
    for (const prose of ["Yash is a 9-out-of-10 engineer.", "I'd say a 9.", "A solid 8 out of 10.", "Yash is an 8/10."]) {
      expect(runCheck(rating, said(prose)), prose).not.toBeNull();
    }
  });
});
