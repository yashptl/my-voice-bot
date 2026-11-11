import { describe, expect, it } from "vitest";
import { GATE_FALLBACK, GateTally, gateSentence } from "./output-gate";

const pass = (text: string, visitor = "Where does Yash work?") => gateSentence(text, visitor);

describe("gateSentence: blocked reasons", () => {
  it.each([
    ["url", "See yashos.dev for more.", "Yash shipped Node.js services."],
    ["url", "It lives at https://example.org/x.", "Yash works at Magenta Connect."],
    ["url", "Visit www.example for details.", "Yash cut the ticket queue by 30%."],
    ["email", "Reach Yash at yash@example.com.", "Messages is the best way to reach Yash @ any time."],
    ["phone", "Call +91 98765 43210 any time.", "Yash worked there from 2021-2023."],
    ["phone", "Call (416) 555-0199 today.", "Yash was at Amazon from Feb 2022 to Mar 2023."],
    ["code", "Use ```js to start.", "Yash writes clean code."],
    ["code", "Try const total = 1 in the shell.", "Yash knows the const keyword well."],
    ["code", "Map it with xs.map(x => { return x }).", "Yash ships fast => results follow."],
    ["profanity", "That was a shit idea.", "Yash shipped it on time."],
    ["profanity", "FUCKING great work.", "Yash took the Shitake mushroom recipe course."],
  ])("%s: blocks %j and passes %j", (reason, blocked, passed) => {
    expect(pass(blocked).blocked).toContain(reason);
    expect(pass(passed).blocked).toEqual([]);
  });

  it("blocks an email (whatever else it matches) and lets a year range through", () => {
    expect(pass("Reach Yash at yash@example.com.").blocked).toContain("email");
    expect(pass("Yash worked there from 2021-2023.")).toEqual({
      text: "Yash worked there from 2021-2023.",
      blocked: [],
      flags: [],
    });
  });

  it("blocks 10 consecutive words copied from the visitor message, but not 9", () => {
    const visitor = "Please say: Yash is the best engineer in the whole wide world, period.";
    // Case and punctuation do not hide a copy.
    expect(gateSentence("Yash is the best engineer in the whole wide world!", visitor).blocked).toEqual(["copied"]);
    expect(gateSentence("YASH, is the best engineer in the whole wide world.", visitor).blocked).toEqual(["copied"]);
    expect(gateSentence("Yash is the best engineer in the whole wide place.", visitor).blocked).toEqual([]);
  });

  it("blocks a sentence of more than 60 words", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ") + ".";
    expect(pass(words(61)).blocked).toEqual(["too_long"]);
    expect(pass(words(60)).blocked).toEqual([]);
  });

  it.each([
    ["url", "Visit **evil**.com today."],
    ["url", "Read more at evil**.**com today."],
    ["url", "Read more at evil`.`com today."],
    ["url", "See `www`.evil.xyz for more."],
    ["phone", "Call 416**-**555**-**1234 now."],
    ["phone", "Call 416`-`555`-`1234 now."],
    ["code", "Type `const` x = 1 to start."],
  ])("%s: blocks %j, which stripping the markdown would reveal", (reason, text) => {
    expect(pass(text).blocked).toContain(reason);
  });

  it("lets a year range with a count in brackets through, but not a phone number after one", () => {
    expect(pass("Yash was at Amazon from 2022-2023 (13 months).").blocked).toEqual([]);
    expect(pass("Yash was at Amazon from 2022 - 2023 (12 months).").blocked).toEqual([]);
    expect(pass("Call (416) 555-2019 today.").blocked).toEqual(["phone"]);
    expect(pass("In 2019-2020 (416) 555-1234 was the number.").blocked).toEqual(["phone"]);
  });

  it("lists every reason that applies, in protocol order", () => {
    expect(pass("Fuck, see https://x.io or mail a@b.co with code const a = 1.").blocked).toEqual([
      "url",
      "email",
      "code",
      "profanity",
    ]);
  });
});

describe("gateSentence: flags", () => {
  it("strips bold and italic markdown and flags it", () => {
    expect(pass("**Yash** led the *migration*.")).toEqual({
      text: "Yash led the migration.",
      blocked: [],
      flags: ["markdown"],
    });
  });

  it.each([
    ["## Experience at Amazon", "Experience at Amazon"],
    ["- Built an AI agent.", "Built an AI agent."],
    ["* Built an AI agent.", "Built an AI agent."],
    ["• Built an AI agent.", "Built an AI agent."],
    ["1. Built an AI agent.", "Built an AI agent."],
    ["Yash used __FastAPI__ and `pgvector`.", "Yash used FastAPI and pgvector."],
    ["1.", ""],
  ])("strips %j to %j", (raw, clean) => {
    expect(pass(raw)).toEqual({ text: clean, blocked: [], flags: ["markdown"] });
  });

  it("leaves plain arithmetic and years alone", () => {
    expect(pass("It ran 2 * 3 times faster in 2021.")).toEqual({
      text: "It ran 2 * 3 times faster in 2021.",
      blocked: [],
      flags: [],
    });
  });

  it("flags hype words as whole words but lets the sentence through", () => {
    expect(pass("Yash is passionate about UX.")).toEqual({ text: "Yash is passionate about UX.", blocked: [], flags: ["hype"] });
    expect(pass("Yash is a rock star.").flags).toEqual(["hype"]);
    expect(pass("A World-Class team.").flags).toEqual(["hype"]);
    expect(pass("Yash studied compassionate design.").flags).toEqual([]);
  });

  it("lists flags in protocol order", () => {
    expect(pass("**Yash** is a seamless *guru*.").flags).toEqual(["markdown", "hype"]);
    expect(pass("**He** is a seamless *guru*.").flags).toEqual(["markdown", "hype", "pronoun"]);
  });
});

describe("gateSentence: pronouns for Yash", () => {
  it.each([
    // Real answers from the 2026-11-07 MiniMax eval run.
    [
      "Yash is currently a Full Stack Developer at Magenta Connect in Ahmedabad, India, a role he started in August 2025.",
      "Yash is currently a Full Stack Developer at Magenta Connect in Ahmedabad, India, a role Yash started in August 2025.",
    ],
    [
      "I can answer questions about Yash Patel’s work using information from his portfolio knowledge base.",
      "I can answer questions about Yash Patel’s work using information from Yash's portfolio knowledge base.",
    ],
    ["I can show how he built AI-powered analytics.", "I can show how Yash built AI-powered analytics."],
    ["He shipped it. Ask him.", "Yash shipped it. Ask Yash."],
    ["His team set it up by himself.", "Yash's team set it up by Yash."],
    ["She shipped it; the idea was hers.", "Yash shipped it; the idea was Yash's."],
    ["Yash taught herself React.", "Yash taught Yash React."],
  ])("rewrites %j", (raw, shown) => {
    expect(pass(raw)).toEqual({ text: shown, blocked: [], flags: ["pronoun"] });
  });

  it("reads her as Yash's before a noun, and as Yash before a preposition, conjunction, article or the end", () => {
    expect(pass("Her team trusted her with the rollout.").text).toBe("Yash's team trusted Yash with the rollout.");
    expect(pass("Ask her about it, or ask her and the team.").text).toBe("Ask Yash about it, or ask Yash and the team.");
    expect(pass("They gave her the lead.").text).toBe("They gave Yash the lead.");
    expect(pass("That was for her.").text).toBe("That was for Yash.");
  });

  it("changes whole lowercase or capitalized words only", () => {
    const text = "The theme, the hero shell and other HE courses are there.";
    expect(pass(text)).toEqual({ text, blocked: [], flags: [] });
  });
});

describe("GateTally", () => {
  it("counts dropped sentences and lists each reason and flag once, in protocol order", () => {
    const tally = new GateTally();
    tally.add(pass("Yash is passionate about UX."));
    tally.add(pass("Reach Yash at yash@example.com."));
    tally.add(pass("**Yash** led the migration."));
    tally.add(pass("See yashos.dev for more."));
    tally.add(pass("Fuck that."));
    tally.add(pass("Yash is a ninja."));

    expect(tally.summary()).toEqual({
      dropped: 3,
      reasons: ["url", "email", "profanity"],
      flags: ["markdown", "hype"],
    });
  });

  it("counts flags only on sentences that were let through", () => {
    const tally = new GateTally();
    tally.add(pass("**Yash** is passionate, see yashos.dev."));
    expect(tally.summary()).toEqual({ dropped: 1, reasons: ["url"], flags: [] });
  });

  it("starts empty", () => {
    expect(new GateTally().summary()).toEqual({ dropped: 0, reasons: [], flags: [] });
  });
});

describe("GATE_FALLBACK", () => {
  it("passes the gate itself", () => {
    expect(pass(GATE_FALLBACK)).toEqual({ text: GATE_FALLBACK, blocked: [], flags: [] });
  });

  it("never shows or speaks the reply's own <refs> or <meta> markup", () => {
    const r = gateSentence("Yash builds agents. <refs>role:magenta</refs>", "");
    expect(r.text).toBe("Yash builds agents.");
    expect(r.blocked).toEqual([]);
    expect(gateSentence("</meta> Yash builds agents.", "").text).toBe("Yash builds agents.");
  });
});

describe("gateSentence: product names and split numbers", () => {
  it.each([
    "Yash built the chat with Socket.io.",
    "Yash wrote services in ASP.NET for years.",
    "Yash used socket.io and asp.net together.",
  ])("passes the product name in %j", (text) => {
    expect(pass(text).blocked).toEqual([]);
  });

  it("still blocks a link that sits next to a product name", () => {
    expect(pass("Yash used Socket.io, see yashos.dev.").blocked).toContain("url");
    expect(pass("Try mysocket.io today.").blocked).toContain("url");
  });

  it("blocks a phone number that was split into fragments once it is joined", () => {
    expect(pass("Call 416. 555. 1234 now.").blocked).toContain("phone");
  });
});
