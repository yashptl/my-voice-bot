import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./sentences";

/** Pushes `text` in chunks of `size` characters and returns everything emitted, flush included. */
function split(text: string, size = text.length, o?: ConstructorParameters<typeof SentenceSplitter>[0]): string[] {
  const splitter = new SentenceSplitter(o);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  return [...out, ...splitter.flush()];
}

const NO_FIRST_CLAUSE = { firstClauseMinWords: Infinity };

describe("SentenceSplitter", () => {
  it("splits on sentence ends and flushes the last sentence", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Yash built it. It works!")).toEqual(["Yash built it."]);
    expect(splitter.flush()).toEqual(["It works!"]);
    expect(splitter.flush()).toEqual([]);
  });

  it("does not split abbreviations, decimals or dotted names", () => {
    const text = "It uses Node.js and runs in 1.5 s on the U.S. East coast, e.g. Virginia.";
    expect(split(text, text.length, NO_FIRST_CLAUSE)).toEqual([text]);
  });

  it.each([
    "Yash used tools like Vite, i.e. the fast ones, every day.",
    "Yash worked with Dr. Patel on the study.",
    "React vs. Vue came up in the review.",
    "Yash mentored a Ph.D. student on the project.",
    "The call starts at 9 a.m. Pacific time.",
    "The service handled 2.5 million requests a day.",
    "The site moved from Next.js to Astro in a week.",
    "Yash is based in the U.S. and works remotely.",
    "Version 3.11 shipped with a 0.2 s cold start.",
    "It took 3 hrs. to migrate everything.",
    'The reviewer asked "why?" and Yash showed the numbers.',
  ])("keeps %j as one sentence", (text) => {
    expect(split(text, text.length, NO_FIRST_CLAUSE)).toEqual([text]);
  });

  it("still splits after a dotted name or a number that ends a sentence", () => {
    expect(split("Yash rebuilt it in Node.js. It got faster.")).toEqual(["Yash rebuilt it in Node.js.", "It got faster."]);
    expect(split("Yash started in 2021. Then came Amazon.")).toEqual(["Yash started in 2021.", "Then came Amazon."]);
  });

  it("splits on ? and ! and keeps closing quotes and brackets with the sentence", () => {
    expect(split('Why? The team said "ship it." Then it shipped (in May.) Done!')).toEqual([
      "Why?",
      'The team said "ship it."',
      "Then it shipped (in May.)",
      "Done!",
    ]);
    expect(split("Really?! Yes... It did.")).toEqual(["Really?!", "Yes...", "It did."]);
  });

  it("waits for what follows a period before deciding", () => {
    const splitter = new SentenceSplitter(NO_FIRST_CLAUSE);
    expect(splitter.push("It runs in 1.")).toEqual([]);
    expect(splitter.push("5 s. Fast")).toEqual(["It runs in 1.5 s."]);
    expect(splitter.flush()).toEqual(["Fast"]);
  });

  it("ends a sentence at a newline and skips blank lines", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Yash built it\n\nIt works")).toEqual(["Yash built it"]);
    expect(splitter.flush()).toEqual(["It works"]);
    expect(split("e.g.\nnext")).toEqual(["e.g.", "next"]);
  });

  describe("first clause", () => {
    const clause = "At Amazon, Yash owned full-stack features for high-concurrency systems,";

    it("emits the first clause of 6 or more words before the period arrives, once 3 more words follow it", () => {
      const splitter = new SentenceSplitter();
      expect(splitter.push(`${clause} on-call`)).toEqual([]);
      expect(splitter.push(" rotations and ")).toEqual([clause]);
      expect(splitter.push("telemetry. ")).toEqual([]);
      expect(splitter.flush()).toEqual(["on-call rotations and telemetry."]);
    });

    it.each([
      "Yash is a Full Stack Developer at Magenta Connect in Ahmedabad, India.",
      "Yash is a Full Stack Developer at Magenta Connect in Ahmedabad, Gujarat, India.",
      "Yash owned full-stack features at Amazon in Toronto, since 2022.",
    ])("keeps a tail of one or two words with its sentence: %j", (text) => {
      expect(split(text)).toEqual([text]);
      for (let size = 1; size < text.length; size++) expect(split(text, size), `chunk size ${size}`).toEqual([text]);
    });

    it("waits while the clause is shorter than the minimum", () => {
      const splitter = new SentenceSplitter();
      expect(splitter.push("At Amazon, ")).toEqual([]);
      expect(splitter.push("Yash shipped a lot.")).toEqual([]);
      expect(splitter.flush()).toEqual(["At Amazon, Yash shipped a lot."]);
    });

    it("applies only to the first sentence of a reply", () => {
      const second = "Later, at Magenta Connect, Yash built an agent that plans field visits, end to end.";
      expect(split(`Yash builds things. ${second}`)).toEqual(["Yash builds things.", second]);
      expect(split(`${clause} on-call rotations and telemetry. ${second}`)).toEqual([
        clause,
        "on-call rotations and telemetry.",
        second,
      ]);
    });

    it("honours a custom minimum", () => {
      expect(split("At Amazon, Yash shipped full-stack features.", undefined, { firstClauseMinWords: 2 })).toEqual([
        "At Amazon,",
        "Yash shipped full-stack features.",
      ]);
    });

    it("does not split a number with a thousands separator", () => {
      const text = "Yash handled more than 12,000 requests per second at peak load.";
      expect(split(text)).toEqual([text]);
    });
  });

  it("gives the same sentences for every chunk size", () => {
    const text =
      "At Amazon, Yash owned full-stack features for high-concurrency systems, with on-call duty. " +
      'It uses Node.js and runs in 1.5 s on the U.S. East coast, e.g. Virginia. Why? "Speed." ' +
      "Yash cut costs by 30%!\nNext line here";
    const expected = split(text);
    expect(expected).toEqual([
      "At Amazon, Yash owned full-stack features for high-concurrency systems,",
      "with on-call duty.",
      "It uses Node.js and runs in 1.5 s on the U.S. East coast, e.g. Virginia.",
      "Why?",
      '"Speed."',
      "Yash cut costs by 30%!",
      "Next line here",
    ]);
    for (let size = 1; size < text.length; size++) {
      expect(split(text, size), `chunk size ${size}`).toEqual(expected);
    }
  });
});
