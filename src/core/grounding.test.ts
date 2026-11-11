import { describe, expect, it } from "vitest";
import realBundle from "../../knowledge/bundle.json" with { type: "json" };
import type { Bundle } from "../knowledge/types";
import { checkGrounding } from "./grounding";

const TEXT = [
  "## doc:profile — Profile · Yash Patel",
  "Name: Yash Patel, known as Yash",
  "",
  "## role:magenta — Magenta Connect · Full Stack Developer · Aug 2025 - now",
  "Location: Ahmedabad, India",
  "- Cut report load times by 30% with React and FastAPI.",
  "- Rolled the platform out to 1,200 field staff.",
  "",
  "## role:amazon — Amazon · Software Development Engineer · Feb 2022 - Mar 2023",
  "Location: Toronto, Canada",
  "- Ran on-call rotations and mentored new hires.",
  "",
  "## doc:skills — Skills",
  "Skills:",
  "- skill:react — React (Frontend): Used across the stack.",
  "- skill:rl — RL (AI and data)",
  "- skill:rest — REST (Frontend)",
  "",
].join("\n");

const bundle: Bundle = {
  version: "a1b2c3d4e5f6",
  hash: "a1b2c3d4e5f6".padEnd(64, "1"),
  text: TEXT,
  refs: ["doc:profile", "doc:resume", "doc:skills", "role:amazon", "role:magenta", "skill:react", "skill:rest", "skill:rl"],
  titles: {
    "doc:profile": "Profile",
    "doc:resume": "Resume",
    "doc:skills": "Skills",
    "role:magenta": "Magenta Connect · Full Stack Developer",
    "role:amazon": "Amazon · Software Development Engineer",
    "skill:react": "React",
    "skill:rl": "RL",
    "skill:rest": "REST",
    "project:yashos": "YashOS",
  },
  keyterms: ["Yash", "Magenta Connect", "Amazon"],
  tokenEstimate: Math.ceil(TEXT.length / 4),
};

const BOTH = ["role:magenta", "role:amazon"];

describe("checkGrounding", () => {
  it("finds nothing unsupported in an answer grounded in the cited sections", () => {
    const prose =
      "Yash works at Magenta Connect in Ahmedabad, where Yash cut load times by 30% with React. " +
      "Before that, Yash was at Amazon in Toronto from 2022.";
    expect(checkGrounding(prose, BOTH, bundle)).toEqual({ checked: 5, unsupported: [], uncited: [] });
  });

  it("flags a number the cited sections do not contain", () => {
    const prose = "Yash cut load times by 30% at Amazon.";
    expect(checkGrounding(prose, ["role:amazon"], bundle)).toEqual({ checked: 2, unsupported: ["30%"], uncited: [] });
    expect(checkGrounding(prose, ["role:magenta", "role:amazon"], bundle).unsupported).toEqual([]);
  });

  it("matches numbers whole, with commas ignored on both sides", () => {
    expect(checkGrounding("Yash rolled it out to 1200 field staff.", ["role:magenta"], bundle).unsupported).toEqual([]);
    expect(checkGrounding("Yash rolled it out to 1,200 field staff.", ["role:magenta"], bundle).unsupported).toEqual([]);
    // "20" is inside "2025" and "2022", but no section says 20.
    expect(checkGrounding("Yash led 20 engineers.", BOTH, bundle)).toEqual({ checked: 1, unsupported: ["20"], uncited: [] });
    // A number before a comma is still the number, as written.
    // A year from another section is uncited, not invented (see the year test below).
    expect(checkGrounding("In 2023, Yash left Amazon.", ["role:magenta"], bundle)).toEqual({
      checked: 2,
      unsupported: [],
      uncited: ["2023", "Amazon"],
    });
  });

  it("holds numbers other than years to the cited sections: one from an uncited section is unsupported, not uncited", () => {
    expect(checkGrounding("Yash rolled it out to 1,200 field staff.", ["role:amazon"], bundle)).toEqual({
      checked: 1,
      unsupported: ["1,200"],
      uncited: [],
    });
  });

  it("skips single-digit integers but checks single digits with a percent sign", () => {
    expect(checkGrounding("Yash led 3 teams.", [], bundle)).toEqual({ checked: 0, unsupported: [], uncited: [] });
    expect(checkGrounding("Costs fell by 3%.", BOTH, bundle)).toEqual({ checked: 1, unsupported: ["3%"], uncited: [] });
  });

  it("lists a known name that the cited sections do not mention as uncited, as written in the answer", () => {
    expect(checkGrounding("Yash built that at magenta connect.", ["role:amazon"], bundle)).toEqual({
      checked: 1,
      unsupported: [],
      uncited: ["magenta connect"],
    });
  });

  it("supports a known name that appears in a cited section, even as an ordinary skill word", () => {
    expect(checkGrounding("Yash used React there.", ["role:magenta"], bundle)).toEqual({
      checked: 1,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding("Yash used React there.", ["role:amazon"], bundle).uncited).toEqual(["React"]);
  });

  it("reads a skill ref as its own line under doc:skills, and only that line", () => {
    expect(checkGrounding("Yash used React there.", ["skill:react"], bundle)).toEqual({
      checked: 1,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding("Yash used React and REST there.", ["skill:react"], bundle).uncited).toEqual(["REST"]);
  });

  it("matches known names as whole words only, and ignores titles that are too short or generic", () => {
    // "reactive" is not React; "RL" is too short to be a known name (and its cited line holds it); "Profile" is excluded.
    expect(
      checkGrounding("Yash wrote reactive code and a profile page with RL.", ["role:amazon", "skill:rl"], bundle),
    ).toEqual({ checked: 0, unsupported: [], uncited: [] });
  });

  it("does not read an ordinary word as an all-caps name, nor treat a stop name as a known name", () => {
    expect(checkGrounding("The rest of the work was data pipelines.", ["role:amazon"], bundle)).toEqual({
      checked: 0,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding("Yash designed REST services.", ["role:amazon"], bundle).uncited).toEqual(["REST"]);
    expect(checkGrounding("Yash designed REST services.", ["skill:rest"], bundle).uncited).toEqual([]);
    // YashOS has a title, but it is where the visitor is: naming it is never a claim.
    expect(checkGrounding("Reach Yash in Messages on YashOS.", ["role:amazon"], bundle)).toEqual({
      checked: 0,
      unsupported: [],
      uncited: [],
    });
  });

  it("flags a proper name that appears nowhere in the knowledge", () => {
    expect(checkGrounding("Yash worked at Google.", BOTH, bundle)).toEqual({ checked: 1, unsupported: ["Google"], uncited: [] });
    expect(checkGrounding("Yash deployed it on Google Cloud Run.", BOTH, bundle).unsupported).toEqual([
      "Google Cloud Run",
    ]);
  });

  it("does not check a name at the start of a sentence", () => {
    expect(checkGrounding("Toronto is where Yash worked in 2022.", ["role:amazon"], bundle)).toEqual({
      checked: 1,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding("Yash shipped it. Google uses something similar.", BOTH, bundle)).toEqual({
      checked: 0,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding('Yash shipped it. "Google" is not in the record.', BOTH, bundle).checked).toBe(0);
  });

  it("lists a name found only in an uncited section as uncited, and ignores stop words", () => {
    const prose =
      "Yash lived in Toronto, and I can say Yash's work is solid; in March, on a Monday, an AI wrote this in English. " +
      "Reach Yash Patel in Messages on YashOS, OK.";
    expect(checkGrounding(prose, ["role:magenta"], bundle)).toEqual({ checked: 1, unsupported: [], uncited: ["Toronto"] });
  });

  it("checks a hyphenated or joined run word by word", () => {
    expect(checkGrounding("Yash is a Full-Stack Developer at Magenta Connect.", ["role:magenta"], bundle)).toEqual({
      checked: 1,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding("Yash shipped React-based FastAPI dashboards.", ["role:magenta"], bundle)).toEqual({
      checked: 1,
      unsupported: [],
      uncited: [],
    });
    expect(checkGrounding("Yash shipped Kafka-based pipelines at Amazon.", ["role:amazon"], bundle).unsupported).toEqual([
      "Kafka-based",
    ]);
  });

  it("does not count a name or number the visitor's own message holds as invented", () => {
    const question = "What did Yash build at Microsoft, where Yash cut costs by 80%?";
    const answer = "Yash did not work at Microsoft, and the record has no 80% figure.";
    expect(checkGrounding(answer, BOTH, bundle)).toEqual({ checked: 2, unsupported: ["80%", "Microsoft"], uncited: [] });
    expect(checkGrounding(answer, BOTH, bundle, question)).toEqual({ checked: 2, unsupported: [], uncited: [] });
    // A name the knowledge holds is still uncited when the visitor said it too: the citation is what is checked.
    expect(checkGrounding("Yash was at Amazon.", ["role:magenta"], bundle, "Did Yash work at Amazon?").uncited).toEqual([
      "Amazon",
    ]);
  });

  it("ignores cited refs that are not in the bundle and treats no refs as nothing cited", () => {
    expect(checkGrounding("Yash cut load times by 30%.", ["role:google"], bundle)).toEqual({
      checked: 1,
      unsupported: ["30%"],
      uncited: [],
    });
    expect(checkGrounding("Yash cut load times by 30%.", [], bundle).unsupported).toEqual(["30%"]);
  });

  it("lists each unsupported claim once and counts it once", () => {
    expect(checkGrounding("Yash led 40 people, then 40 more, at Google and again at Google.", BOTH, bundle)).toEqual({
      checked: 2,
      unsupported: ["40", "Google"],
      uncited: [],
    });
  });

  it("re-reads the sections when the bundle changes", () => {
    const changed: Bundle = {
      ...bundle,
      hash: "f".repeat(64),
      text: bundle.text.replace("30%", "45%"),
    };
    expect(checkGrounding("Yash cut load times by 30%.", ["role:magenta"], bundle).unsupported).toEqual([]);
    expect(checkGrounding("Yash cut load times by 30%.", ["role:magenta"], changed).unsupported).toEqual(["30%"]);
    expect(checkGrounding("Yash cut load times by 30%.", ["role:magenta"], bundle).unsupported).toEqual([]);
  });

  it("checks nothing in an empty answer", () => {
    expect(checkGrounding("", BOTH, bundle)).toEqual({ checked: 0, unsupported: [], uncited: [] });
  });
});

describe("checkGrounding on the real knowledge", () => {
  const real: Bundle = realBundle;
  const check = (prose: string, refs: string[], visitor?: string) => checkGrounding(prose, refs, real, visitor);
  const clean = { unsupported: [], uncited: [] };

  it.each<[string, string[]]>([
    ["Yash built a RAG-based AI agent there.", ["role:magenta"]],
    ["Yash is a Full-Stack Developer at Magenta Connect.", ["role:magenta"]],
    ["Yash shipped PostgreSQL-backed, AI-powered services there.", ["role:magenta"]],
    ["Yash used Python FastAPI and the Google Maps API there.", ["role:magenta"]],
    ["Yash uses React and Next.js.", ["skill:react", "skill:nextjs"]],
    ["At Magenta Connect, Yash built an internal agent.", ["skill:llms"]],
    ["This is Yash Patel's assistant.", ["project:assistant"]],
  ])("supports %j citing %j", (prose, refs) => {
    expect(check(prose, refs)).toMatchObject(clean);
  });

  it("flags an employer the knowledge never names, unless the visitor named it", () => {
    expect(check("Yash worked at Microsoft.", ["role:amazon"]).unsupported).toEqual(["Microsoft"]);
    expect(check("Yash worked at Microsoft.", ["role:amazon"], "Did Yash work at Microsoft?")).toMatchObject(clean);
  });

  it("lists a known name once, not again for the capitalized words inside it", () => {
    expect(check("Yash is studying for an MS in Computer Science at Georgia Tech.", ["role:magenta"])).toEqual({
      checked: 2,
      unsupported: [],
      uncited: ["MS in Computer Science", "Georgia Tech"],
    });
  });

  it("reports a name the knowledge holds only elsewhere as uncited: Google is there only as Google Maps", () => {
    expect(check("Yash worked at Google from 2022.", ["role:amazon"])).toEqual({
      checked: 2,
      unsupported: [],
      uncited: ["Google"],
    });
  });

  it("counts a year from an uncited section as uncited, but a percentage from one as unsupported", () => {
    const year = checkGrounding("Yash has shipped since 2021.", ["role:techsquad"], realBundle as Bundle, "");
    expect(year.unsupported).toEqual([]);
    expect(year.uncited).toContain("2021");
    const percent = checkGrounding("Yash cut the ticket queue by 20%.", ["role:amazon"], realBundle as Bundle, "");
    expect(percent.unsupported).toContain("20%");
  });
});
