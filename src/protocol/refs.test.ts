import { describe, expect, it } from "vitest";
import { parseRef } from "./refs";

describe("parseRef", () => {
  it("splits a valid ref into kind and id", () => {
    expect(parseRef("role:magenta")).toEqual({ kind: "role", id: "magenta" });
    expect(parseRef("doc:resume")).toEqual({ kind: "doc", id: "resume" });
  });

  it("accepts ids of up to 48 characters", () => {
    expect(parseRef(`skill:${"a".repeat(48)}`)).toEqual({ kind: "skill", id: "a".repeat(48) });
  });

  it.each([
    "experience:magenta",
    "role:Magenta",
    "role:",
    "role",
    ":magenta",
    "role:-magenta",
    "role:a:b",
    "role:magenta ",
    `role:${"a".repeat(49)}`,
  ])("rejects %j", (s) => {
    expect(parseRef(s)).toBeNull();
  });
});
