import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses strings and [a, b] lists, and returns the body after the fence", () => {
    const md = "---\nref: project:assistant\ntitle: This assistant\nrefs: [role:magenta, skill:llms]\n---\nBody";
    expect(parseFrontmatter(md)).toEqual({
      data: { ref: "project:assistant", title: "This assistant", refs: ["role:magenta", "skill:llms"] },
      body: "Body",
    });
  });

  it("returns empty data and the whole text when there is no frontmatter", () => {
    const md = "# Notes\n\nNo fence here.\n";
    expect(parseFrontmatter(md)).toEqual({ data: {}, body: md });
  });

  it("accepts CRLF line endings, blank lines and an empty list", () => {
    const md = "---\r\nref: story:x\r\n\r\nrefs: []\r\n---\r\nBody\r\n";
    expect(parseFrontmatter(md)).toEqual({ data: { ref: "story:x", refs: [] }, body: "Body\r\n" });
  });

  it("keeps colons after the first one in a value and strips matching quotes", () => {
    const md = '---\ntitle: "Why: the short version"\nnote: \'quoted\'\n---\n';
    expect(parseFrontmatter(md).data).toEqual({ title: "Why: the short version", note: "quoted" });
  });

  it("throws on a line that is not key: value", () => {
    expect(() => parseFrontmatter("---\nref project:assistant\n---\nBody")).toThrow(/line 1/);
  });

  it("throws when the opening fence is never closed", () => {
    expect(() => parseFrontmatter("---\nref: project:assistant\nBody")).toThrow(/closing ---/);
  });
});
