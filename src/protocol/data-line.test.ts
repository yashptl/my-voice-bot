import { describe, expect, it } from "vitest";
import { dataLineInstructions, parseDataLine, parseRefsList } from "./data-line";

const known = new Set(["role:magenta", "project:fieldops"]);

describe("parseDataLine", () => {
  it("keeps known refs and reports unknown ones", () => {
    const raw =
      '{"refs":["role:magenta","role:google"],"show":"project:fieldops","contact":false,"coverage":"direct"}';
    expect(parseDataLine(raw, known)).toEqual({
      ok: true,
      value: { refs: ["role:magenta"], show: "project:fieldops", contact: false, coverage: "direct" },
      dropped: ["role:google"],
    });
  });

  it("drops malformed refs", () => {
    const result = parseDataLine('{"refs":["Role:Magenta",42,"role:magenta"],"coverage":"direct"}', known);
    expect(result).toMatchObject({ ok: true, value: { refs: ["role:magenta"] }, dropped: ["Role:Magenta", "42"] });
  });

  it("keeps at most 8 refs and reports the rest", () => {
    const many = new Set(Array.from({ length: 10 }, (_, i) => `skill:s${i}`));
    const result = parseDataLine(JSON.stringify({ refs: [...many], coverage: "direct" }), many);
    expect(result).toMatchObject({
      ok: true,
      value: { refs: ["skill:s0", "skill:s1", "skill:s2", "skill:s3", "skill:s4", "skill:s5", "skill:s6", "skill:s7"] },
      dropped: ["skill:s8", "skill:s9"],
    });
  });

  it("sets an unknown show to null and reports it", () => {
    const result = parseDataLine('{"show":"project:secret","coverage":"adjacent"}', known);
    expect(result).toEqual({
      ok: true,
      value: { refs: [], show: null, contact: false, coverage: "adjacent" },
      dropped: ["project:secret"],
    });
  });

  it("applies defaults for missing optional fields", () => {
    expect(parseDataLine('{"coverage":"none"}', known)).toEqual({
      ok: true,
      value: { refs: [], show: null, contact: false, coverage: "none" },
      dropped: [],
    });
  });

  it.each([
    ['  <meta> {"coverage":"none"} </meta>\n'],
    ['<meta>{"coverage":"none"}'],
    ['{"coverage":"none"}</me'],
  ])("tolerates whitespace, tags and a missing closing tag: %j", (raw) => {
    expect(parseDataLine(raw, known)).toMatchObject({ ok: true, value: { coverage: "none" } });
  });

  it.each([
    ['{"coverage":"maybe"}'],
    ["{}"],
    ['{"refs":["role:magenta"]'],
    ["no json here"],
    ['{"contact":"yes","coverage":"none"}'],
  ])("rejects %j", (raw) => {
    expect(parseDataLine(raw, known)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe("parseRefsList", () => {
  it.each([
    ["commas", "role:magenta, project:fieldops"],
    ["spaces", "role:magenta project:fieldops"],
    ["commas and newlines", " role:magenta,\nproject:fieldops, "],
  ])("reads refs separated by %s", (_name, raw) => {
    expect(parseRefsList(raw, known)).toEqual({ refs: ["role:magenta", "project:fieldops"], dropped: [] });
  });

  it("drops unknown and malformed refs as parseDataLine does, and reports them", () => {
    expect(parseRefsList("role:google, Role:Magenta, role:magenta", known)).toEqual({
      refs: ["role:magenta"],
      dropped: ["role:google", "Role:Magenta"],
    });
  });

  it("keeps at most 8 refs", () => {
    const many = Array.from({ length: 10 }, (_, i) => `skill:s${i}`);
    const result = parseRefsList(many.join(", "), new Set(many));
    expect(result).toEqual({ refs: many.slice(0, 8), dropped: many.slice(8) });
  });

  it("reads an empty list as no refs", () => {
    expect(parseRefsList("  ", known)).toEqual({ refs: [], dropped: [] });
  });
});

describe("dataLineInstructions", () => {
  it("names the tag, every field and every coverage value", () => {
    const text = dataLineInstructions();
    for (const word of ["<meta>", "refs", "show", "contact", "coverage", "direct", "adjacent", "none"]) {
      expect(text).toContain(word);
    }
  });

  it("shows an example line the parser accepts", () => {
    const example = /<meta>.*<\/meta>/.exec(dataLineInstructions())?.[0];
    expect(example).toBeDefined();
    expect(parseDataLine(example ?? "", known)).toMatchObject({ ok: true });
  });
});
