import { describe, expect, it } from "vitest";
import { ReplySplitter } from "./reply-splitter";

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function run(chunks: string[]): { prose: string; meta: string | null; refs?: string } {
  const splitter = new ReplySplitter();
  let prose = "";
  for (const c of chunks) prose += splitter.push(c);
  const end = splitter.end();
  return { prose: prose + end.prose, meta: end.meta, refs: end.refs };
}

const META = '{"refs":["role:magenta"],"show":null,"contact":false,"coverage":"direct"}';
const REPLY = `Yash works at Magenta Connect. Latency is < 1 s.\n<meta>${META}</meta>`;

describe("ReplySplitter", () => {
  it("holds back a partial <meta prefix, then routes the rest to meta", () => {
    const splitter = new ReplySplitter();
    expect(splitter.push("Hello <me")).toBe("Hello ");
    expect(splitter.push('ta>{"refs":[]}</meta>')).toBe("");
    expect(splitter.end().meta).toBe('{"refs":[]}');
  });

  it("emits prose containing < straight away", () => {
    const splitter = new ReplySplitter();
    expect(splitter.push("latency < 1 s.")).toBe("latency < 1 s.");
  });

  it("releases a held-back < as soon as the next chunk shows it is not meta", () => {
    const splitter = new ReplySplitter();
    expect(splitter.push("latency <")).toBe("latency ");
    expect(splitter.push(" 1 s.")).toBe("< 1 s.");
    const splitter2 = new ReplySplitter();
    expect(splitter2.push("a <m")).toBe("a ");
    expect(splitter2.push("ore")).toBe("<more");
  });

  it("returns all prose and null meta when the reply has no data line", () => {
    const splitter = new ReplySplitter();
    expect(splitter.push("Yash built it. ")).toBe("Yash built it. ");
    expect(splitter.push("It works.")).toBe("It works.");
    expect(splitter.end()).toEqual({ meta: null, prose: "" });
  });

  it("releases a trailing partial prefix at the end when no meta followed", () => {
    const splitter = new ReplySplitter();
    expect(splitter.push("ends with <me")).toBe("ends with ");
    expect(splitter.end()).toEqual({ meta: null, prose: "<me" });
  });

  it("reassembles meta split over 5 chunks exactly", () => {
    const chunks = [
      "Yash works at Magenta Connect.\n<",
      'met',
      'a>{"refs":["role:mag',
      'enta"],"show":null,"contact":false,"coverage":"direct"}</m',
      "eta>",
    ];
    expect(run(chunks)).toEqual({ prose: "Yash works at Magenta Connect.\n", meta: META });
  });

  it("gives the same prose and meta for every chunk size", () => {
    const expected = { prose: "Yash works at Magenta Connect. Latency is < 1 s.\n", meta: META };
    for (let size = 1; size <= REPLY.length; size++) {
      expect(run(chunk(REPLY, size)), `chunk size ${size}`).toEqual(expected);
    }
  });

  it("never leaks any part of the data line into prose, whatever the chunking", () => {
    for (let size = 1; size <= REPLY.length; size++) {
      expect(run(chunk(REPLY, size)).prose).not.toMatch(/<\/?m|refs|coverage/);
    }
  });

  it("matches the tags case-insensitively", () => {
    expect(run(['Done.<META>{"coverage":"none"}</Meta>'])).toEqual({ prose: "Done.", meta: '{"coverage":"none"}' });
  });

  it("keeps meta without a closing tag, and ignores text after a closing tag", () => {
    expect(run(['Hi.<meta> {"coverage":"none"} '])).toEqual({ prose: "Hi.", meta: '{"coverage":"none"}' });
    expect(run(['Hi.<meta>{"coverage":"none"}</meta> trailing words'])).toEqual({
      prose: "Hi.",
      meta: '{"coverage":"none"}',
    });
  });

  it("reports when the prose is over because the data line has started", () => {
    const splitter = new ReplySplitter();
    splitter.push("Yash built it.<me");
    expect(splitter.metaStarted).toBe(false);
    splitter.push("ta>{");
    expect(splitter.metaStarted).toBe(true);
  });

  it("returns an empty string, not null, for an empty data line", () => {
    expect(run(["Hi.<meta></meta>"])).toEqual({ prose: "Hi.", meta: "" });
  });

  describe("a data line written without <meta> tags", () => {
    const BARE = `Yash works at Magenta Connect.\n${META}`;
    const FENCED = `Yash works at Magenta Connect.\n\`\`\`json\n${META}\n\`\`\``;

    it.each([
      ["bare JSON as the last line", BARE],
      ["a fenced JSON block as the last line", FENCED],
      ["bare JSON with only the closing tag", `${BARE}</meta>`],
      ["bare JSON after spaces", `Yash works at Magenta Connect.\n  ${META}`],
    ])("is meta, never prose: %s", (_name, reply) => {
      for (let size = 1; size <= reply.length; size++) {
        expect(run(chunk(reply, size)), `chunk size ${size}`).toEqual({ prose: "Yash works at Magenta Connect.\n", meta: META });
      }
    });

    it("is meta when it is the whole reply", () => {
      expect(run([META])).toEqual({ prose: "", meta: META });
    });

    it("still counts as meta when malformed, so it is reported rather than spoken", () => {
      expect(run(['Hi.\n{"refs": ["role:magenta"], "coverage": direct}'])).toEqual({
        prose: "Hi.\n",
        meta: '{"refs": ["role:magenta"], "coverage": direct}',
      });
    });

    it("releases a line that only starts like JSON once the reply ends", () => {
      const splitter = new ReplySplitter();
      expect(splitter.push("Yash shipped it.\n{curly} is a word")).toBe("Yash shipped it.\n");
      expect(splitter.end()).toEqual({ meta: null, prose: "{curly} is a word" });
    });

    it("releases a held line as prose when a tagged data line follows it", () => {
      expect(run(["Hi.\n`code` here.\n", `<meta>${META}</meta>`])).toEqual({ prose: "Hi.\n`code` here.\n", meta: META });
    });

    it("drops a code fence opened just before a tagged data line", () => {
      expect(run([`Hi.\n\`\`\`\n<meta>${META}</meta>\n\`\`\``])).toEqual({ prose: "Hi.\n", meta: META });
    });

    it("leaves braces in the middle of a line alone", () => {
      const splitter = new ReplySplitter();
      expect(splitter.push("Sets like {a, b} are fine.")).toBe("Sets like {a, b} are fine.");
    });
  });

  describe("a bare <refs> list in place of the data line (seen in the 2026-11-08 evals)", () => {
    const LIST = "role:magenta, role:amazon";

    it.each([
      ["on its own line", `Yash works at Magenta Connect.\n<refs>${LIST}</refs>`, "Yash works at Magenta Connect.\n"],
      ["after the last sentence", `Yash works at Magenta Connect. <refs>${LIST}</refs>`, "Yash works at Magenta Connect. "],
      ["with a newline after it", `Yash works at Magenta Connect.\n<refs>${LIST}</refs>\n`, "Yash works at Magenta Connect.\n"],
      ["with no closing tag", `Yash works at Magenta Connect.\n<refs>${LIST}`, "Yash works at Magenta Connect.\n"],
      ["in capitals", `Yash works at Magenta Connect.\n<REFS>${LIST}</Refs>`, "Yash works at Magenta Connect.\n"],
    ])("is held back and returned as refs, never prose: %s", (_name, reply, prose) => {
      for (let size = 1; size <= reply.length; size++) {
        expect(run(chunk(reply, size)), `chunk size ${size}`).toEqual({ prose, meta: null, refs: LIST });
      }
    });

    it("is ignored when a data line follows it, which then wins", () => {
      expect(run([`Hi.\n<refs>${LIST}</refs>`, `\n<meta>${META}</meta>`]).meta).toBe(META);
    });

    it.each([
      ["bare JSON", `Yash works at Magenta Connect.\n<refs>role:magenta</refs>\n${META}`],
      ["a fenced JSON block", `Yash works at Magenta Connect.\n<refs>role:magenta</refs>\n\`\`\`json\n${META}\n\`\`\``],
      ["bare JSON after a list with no closing tag", `Yash works at Magenta Connect.\n<refs>role:magenta\n${META}`],
      ["bare JSON after a blank line", `Yash works at Magenta Connect. <refs>role:magenta</refs>\n\n${META}`],
    ])("gives way to a tagless data line after it, and stays hidden: %s", (_name, reply) => {
      const prose = reply.slice(0, reply.search(/<refs>/));
      for (let size = 1; size <= reply.length; size++) {
        expect(run(chunk(reply, size)), `chunk size ${size}`).toEqual({ prose, meta: META });
      }
    });

    it("hides the list but keeps a later line that only starts like JSON as prose", () => {
      const reply = "Hi.\n<refs>role:magenta</refs>\n{curly} is a word";
      expect(run([reply])).toEqual({ prose: "Hi.\n\n{curly} is a word", meta: null, refs: "role:magenta" });
    });

    it("is prose after all when words follow it, released as soon as they show", () => {
      const splitter = new ReplySplitter();
      expect(splitter.push("Hi. <refs>role:magenta</refs>")).toBe("Hi. ");
      expect(splitter.push(" Want more?")).toBe("<refs>role:magenta</refs> Want more?");
      expect(splitter.end()).toEqual({ meta: null, prose: "" });
    });

    it("does not hold back the rest of a reply that names a list in its middle", () => {
      const splitter = new ReplySplitter();
      expect(splitter.push("Yash said <refs>x</refs> once. ")).toBe("Yash said <refs>x</refs> once. ");
      expect(splitter.push("Then more. ")).toBe("Then more. ");
      expect(splitter.push("And more.")).toBe("And more.");
      expect(splitter.end()).toEqual({ meta: null, prose: "" });
    });

    it("releases a list once words start the line after it", () => {
      const splitter = new ReplySplitter();
      expect(splitter.push("Hi.\n<refs>role:magenta</refs>\n")).toBe("Hi.\n");
      expect(splitter.push("Want more?")).toBe("<refs>role:magenta</refs>\nWant more?");
    });

    it("gives the same prose for every chunk size when words follow it", () => {
      const reply = `Yash said <refs>${LIST}</refs> once.\nThen more.\n<meta>${META}</meta>`;
      for (let size = 1; size <= reply.length; size++) {
        expect(run(chunk(reply, size)), `chunk size ${size}`).toEqual({
          prose: `Yash said <refs>${LIST}</refs> once.\nThen more.\n`,
          meta: META,
        });
      }
    });

    it("does not hold back a word that only starts like the tag", () => {
      const splitter = new ReplySplitter();
      expect(splitter.push("see <ref")).toBe("see ");
      expect(splitter.push("erence> here.")).toBe("<reference> here.");
    });
  });

  it("drops a <refs> list held just before a <meta> line from the prose", () => {
    const s = new ReplySplitter();
    const out = s.push("Hi.\n<refs>role:magenta</refs>\n<meta>{\"refs\":[]}</meta>");
    expect(out).toBe("Hi.\n");
    expect(s.end().meta).toBe('{"refs":[]}');
  });

  it("keeps sentences after an unclosed <refs> list as prose, and the list out of it", () => {
    const s = new ReplySplitter();
    const out = s.push("Yash builds agents.\n<refs>role:magenta, skill:rag\nThen more words here.");
    const end = s.end();
    expect(out + end.prose).toBe("Yash builds agents.\nThen more words here.");
    expect(end.refs).toBe("role:magenta, skill:rag");
  });
});
