import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildBundle, docFromMarkdown, sha256Hex, type Doc } from "./build";
import { ContentSchema, type Content } from "./content-schema";

function fixture(): Content {
  return {
    schemaVersion: 1,
    profile: {
      name: "Yash",
      fullName: "Yash Patel",
      role: "Full-stack and AI engineer",
      pitch: "I build interfaces people enjoy and the systems behind them.",
      summary: "I work across the stack.",
      location: "Ahmedabad, India",
      timeZone: "Asia/Kolkata",
      availability: { open: true, label: "Open to new roles" },
      headline: { stack: ["react"], ai: ["llms"] },
    },
    domains: [
      { id: "frontend", label: "Frontend", summary: "Interfaces that can grow." },
      { id: "ai", label: "AI and data", summary: "Models with the right context." },
    ],
    roles: [
      {
        id: "magenta",
        company: "Magenta Connect",
        short: "Magenta",
        title: "Full Stack Developer",
        location: "Ahmedabad, India",
        period: "Aug 2025 - now",
        summary: "Modernizing an enterprise sales platform.",
        highlights: ["Built an internal AI agent on retrieval-augmented generation."],
        skills: ["react", "llms"],
      },
      {
        id: "alberta",
        company: "University of Alberta",
        short: "UAlberta",
        title: "Frontend Developer",
        location: "Edmonton, Canada, contract",
        period: "Jan 2021 - May 2021",
        summary: "Making social engagement data easy to explore.",
        highlights: ["Improved load speed by 25%."],
        skills: ["react", "javascript"],
      },
    ],
    projects: [
      {
        id: "fieldops",
        name: "Field operations platform",
        kind: "Professional work at Magenta Connect",
        year: "2025",
        summary: "One platform for field sales teams.",
        problem: "Field teams reported on paper.",
        approach: "A schema-driven form engine.",
        result: "Sales reporting went fully digital.",
        stack: ["React", "FastAPI"],
      },
    ],
    skills: [
      { id: "react", label: "React", domain: "frontend", note: "Led the frontend overhaul at Magenta Connect." },
      { id: "javascript", label: "JavaScript", domain: "frontend" },
      { id: "llms", label: "LLMs", domain: "ai", note: "An internal AI agent at Magenta Connect." },
    ],
    education: [
      {
        id: "gatech",
        school: "Georgia Institute of Technology",
        short: "Georgia Tech",
        degree: "MS in Computer Science",
        focus: "Machine learning specialization",
        location: "Remote",
        period: "Aug 2025 - now",
        skills: ["llms"],
      },
    ],
    computed: { shippingSince: 2021, currentRoleId: "magenta", currentStudyId: "gatech" },
  };
}

const docs: Doc[] = [
  { ref: "project:assistant", title: "This assistant", refs: ["role:magenta", "skill:llms"], body: "An AI assistant.\n" },
];

/** The section that starts with `## <ref> ` and runs to the next `## ` header. */
function section(text: string, ref: string): string {
  const start = text.indexOf(`## ${ref} `);
  if (start < 0) throw new Error(`no section ${ref}`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

describe("ContentSchema", () => {
  it("accepts the fixture", () => {
    expect(ContentSchema.safeParse(fixture()).success).toBe(true);
  });

  it("rejects contact details the bundle must not carry", () => {
    const content = { ...fixture(), profile: { ...fixture().profile, email: "someone@example.com" } };
    expect(ContentSchema.safeParse(content).success).toBe(false);
  });

  it("rejects a role that names an unknown skill", () => {
    const content = fixture();
    content.roles[0]!.skills.push("cobol");
    const result = ContentSchema.safeParse(content);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/unknown skill "cobol"/);
  });

  it("rejects a current role id that is not a role", () => {
    const content = fixture();
    content.computed.currentRoleId = "google";
    expect(ContentSchema.safeParse(content).success).toBe(false);
  });
});

describe("buildBundle", () => {
  it("is deterministic and hashes its text", () => {
    const a = buildBundle(fixture(), docs);
    const b = buildBundle(fixture(), docs);
    expect(b.text).toBe(a.text);
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(createHash("sha256").update(a.text, "utf8").digest("hex"));
    expect(a.version).toBe(a.hash.slice(0, 12));
  });

  it("starts every section with a header line naming its ref", () => {
    const { text, refs } = buildBundle(fixture(), docs);
    expect(text).toContain("## role:magenta — Magenta Connect · Full Stack Developer · Aug 2025 - now\n");
    expect(text.startsWith("## ")).toBe(true);
    const headers = text.split("\n").filter((line) => line.startsWith("#"));
    for (const header of headers) expect(header).toMatch(/^## [a-z]+:[a-z0-9-]+ — \S/);
    const sectionRefs = headers.map((header) => header.split(" ")[1]);
    for (const ref of sectionRefs) expect(refs).toContain(ref);
  });

  it("lists every section and skill ref, sorted", () => {
    const { refs } = buildBundle(fixture(), docs);
    expect(refs).toEqual(
      [
        "doc:profile",
        "doc:resume",
        "doc:skills",
        "edu:gatech",
        "project:assistant",
        "project:fieldops",
        "role:alberta",
        "role:magenta",
        "skill:javascript",
        "skill:llms",
        "skill:react",
      ],
    );
    expect(refs).toEqual([...refs].sort());
  });

  it("renders skills as ref lines, with or without a note", () => {
    const skills = section(buildBundle(fixture(), docs).text, "doc:skills");
    expect(skills).toContain("- skill:react — React (Frontend): Led the frontend overhaul at Magenta Connect.\n");
    expect(skills).toMatch(/^- skill:javascript — JavaScript \(Frontend\)$/m);
    expect(skills).toContain("- skill:llms — LLMs (AI and data): An internal AI agent at Magenta Connect.");
  });

  it("carries no email, links or LinkedIn", () => {
    const { text } = buildBundle(fixture(), docs);
    expect(text).not.toMatch(/@|http|linkedin/i);
  });

  it("refuses content or docs that contain contact details", () => {
    const withLink: Doc = { ...docs[0]!, body: "See https://example.com for more." };
    expect(() => buildBundle(fixture(), [withLink])).toThrow(/project:assistant.*contact details/);
    const content = fixture();
    content.roles[0]!.highlights.push("Reach out at someone@example.com.");
    expect(() => buildBundle(content, docs)).toThrow(/role:magenta.*contact details/);
  });

  it("anchors computed facts to a year, never a count of years", () => {
    const { text } = buildBundle(fixture(), docs);
    const profile = section(text, "doc:profile");
    expect(profile).toContain("Shipping since 2021");
    expect(profile).toContain("Current role: Full Stack Developer at Magenta Connect");
    expect(profile).toContain("Current study: MS in Computer Science at Georgia Institute of Technology");
    expect(text).not.toMatch(/years of experience/i);
  });

  it("says plainly when there is no current role", () => {
    const content = fixture();
    content.computed.currentRoleId = null;
    const profile = section(buildBundle(content, docs).text, "doc:profile");
    expect(profile).toContain("Current role: none in progress");
    expect(profile).not.toContain("Current role: Full Stack Developer");
  });

  it("quotes Yash's own first-person words instead of presenting them as the assistant's", () => {
    const profile = section(buildBundle(fixture(), docs).text, "doc:profile");
    expect(profile).toContain('"I build interfaces people enjoy and the systems behind them."');
    expect(profile).toMatch(/Yash's own words/);
  });

  it("renders docs with their related refs and trimmed body", () => {
    const doc = section(buildBundle(fixture(), docs).text, "project:assistant");
    expect(doc).toBe(
      "## project:assistant — This assistant\nRelated: Magenta Connect · Full Stack Developer (role:magenta), LLMs (skill:llms)\nAn AI assistant.\n",
    );
  });

  it("gives every ref a title", () => {
    const { refs, titles } = buildBundle(fixture(), docs);
    expect(Object.keys(titles).sort()).toEqual(refs);
    expect(titles["role:magenta"]).toBe("Magenta Connect · Full Stack Developer");
    expect(titles["skill:react"]).toBe("React");
    expect(titles["project:assistant"]).toBe("This assistant");
    expect(titles["doc:resume"]).toBe("Resume");
  });

  it("collects deduplicated keyterms for names, capped at 40", () => {
    const { keyterms } = buildBundle(fixture(), docs);
    expect(keyterms).toEqual([
      "Yash",
      "Yash Patel",
      "Magenta Connect",
      "Magenta",
      "University of Alberta",
      "UAlberta",
      "Georgia Institute of Technology",
      "Georgia Tech",
      "Field operations platform",
    ]);

    const many = fixture();
    many.projects = Array.from({ length: 50 }, (_, i) => ({ ...fixture().projects[0]!, id: `p${i}`, name: `Project ${i}` }));
    expect(buildBundle(many, []).keyterms).toHaveLength(40);
  });

  it("estimates tokens as characters / 4, rounded up", () => {
    const bundle = buildBundle(fixture(), docs);
    expect(bundle.tokenEstimate).toBe(Math.ceil(bundle.text.length / 4));
  });

  it("rejects a doc that cites an unknown ref", () => {
    const bad: Doc = { ...docs[0]!, refs: ["role:google"] };
    expect(() => buildBundle(fixture(), [bad])).toThrow(/project:assistant.*unknown ref "role:google"/);
  });

  it("rejects a doc whose ref is malformed or already taken", () => {
    expect(() => buildBundle(fixture(), [{ ...docs[0]!, ref: "Assistant" }])).toThrow(/invalid ref "Assistant"/);
    expect(() => buildBundle(fixture(), [{ ...docs[0]!, ref: "role:magenta" }])).toThrow(/duplicate ref "role:magenta"/);
  });

  it("rejects a doc body with a top-level header, which would break the section structure", () => {
    const bad: Doc = { ...docs[0]!, body: "Intro\n## Details\nMore" };
    expect(() => buildBundle(fixture(), [bad])).toThrow(/project:assistant.*### or deeper/);
  });

  it("hashes non-ASCII text the same way as node:crypto", () => {
    const content = fixture();
    content.profile.summary = "Résumé — naïve café, 日本語, emoji 🚀, and a long line. ".repeat(40);
    const bundle = buildBundle(content, docs);
    expect(bundle.hash).toBe(createHash("sha256").update(bundle.text, "utf8").digest("hex"));
  });
});

describe("docFromMarkdown", () => {
  it("reads ref, title, refs and body from frontmatter", () => {
    const md = "---\nref: project:assistant\ntitle: This assistant\nrefs: [role:magenta, skill:llms]\n---\nBody\n";
    expect(docFromMarkdown(md, "assistant.md")).toEqual({
      ref: "project:assistant",
      title: "This assistant",
      refs: ["role:magenta", "skill:llms"],
      body: "Body\n",
    });
  });

  it("normalises CRLF so a Windows checkout builds the same bundle", () => {
    const lf = "---\nref: story:x\ntitle: X\n---\nLine one\nLine two\n";
    expect(docFromMarkdown(lf.replace(/\n/g, "\r\n"), "x.md")).toEqual(docFromMarkdown(lf, "x.md"));
  });

  it("defaults refs to none", () => {
    expect(docFromMarkdown("---\nref: story:x\ntitle: X\n---\nBody", "x.md").refs).toEqual([]);
  });

  it("names the file when ref or title is missing", () => {
    expect(() => docFromMarkdown("---\ntitle: X\n---\nBody", "x.md")).toThrow(/x\.md.*ref/);
    expect(() => docFromMarkdown("No frontmatter", "y.md")).toThrow(/y\.md/);
  });
});

describe("sha256Hex", () => {
  it("matches node:crypto across padding boundaries and multi-byte text", () => {
    for (let n = 0; n <= 130; n++) {
      const input = "a".repeat(n);
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    }
    const mixed = "é—🚀日本".repeat(37);
    expect(sha256Hex(mixed)).toBe(createHash("sha256").update(mixed, "utf8").digest("hex"));
  });
});
