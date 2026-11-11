import { parseRef } from "../protocol/refs";
import type { Content } from "./content-schema";
import { parseFrontmatter } from "./frontmatter";
import type { Bundle } from "./types";

/** A markdown doc from knowledge/docs: a story, policy or note Yash writes. */
export type Doc = { ref: string; title: string; refs: string[]; body: string };

const MAX_KEYTERMS = 40;
/** Contact goes through Messages, so the bundle never carries an address or a link. */
const CONTACT = /@|http|linkedin/i;
const DOC_KEYS = new Set(["ref", "title", "refs"]);

type Section = { ref: string; title: string; header: string[]; lines: string[] };

/**
 * Renders the knowledge as one markdown text, each section headed `## <ref> — <title> · …`.
 * Pure and deterministic: the same content and docs give the same text and hash, so the
 * prompt prefix stays byte-identical. Throws on a doc that cites an unknown ref, a duplicate or
 * malformed ref, or any section that carries contact details.
 */
export function buildBundle(content: Content, docs: Doc[]): Bundle {
  const { profile, computed } = content;
  const domainLabel = new Map(content.domains.map((d) => [d.id, d.label]));
  const role = content.roles.find((r) => r.id === computed.currentRoleId);
  const study = content.education.find((e) => e.id === computed.currentStudyId);

  const titles = new Map<string, string>([
    ["doc:profile", "Profile"],
    ["doc:resume", "Resume"],
    ["doc:skills", "Skills"],
  ]);
  for (const r of content.roles) titles.set(`role:${r.id}`, `${r.company} · ${r.title}`);
  for (const p of content.projects) titles.set(`project:${p.id}`, p.name);
  for (const e of content.education) titles.set(`edu:${e.id}`, `${e.school} · ${e.degree}`);
  for (const s of content.skills) titles.set(`skill:${s.id}`, s.label);

  for (const doc of docs) {
    if (!parseRef(doc.ref)) throw new Error(`knowledge doc: invalid ref "${doc.ref}"`);
    if (titles.has(doc.ref)) throw new Error(`knowledge doc: duplicate ref "${doc.ref}"`);
    titles.set(doc.ref, doc.title);
  }
  for (const doc of docs) {
    for (const ref of doc.refs) {
      if (!titles.has(ref)) throw new Error(`${doc.ref}: unknown ref "${ref}"`);
    }
    if (/^#{1,2}(\s|$)/m.test(doc.body)) {
      throw new Error(`${doc.ref}: use ### or deeper for headings inside a doc`);
    }
  }

  const cite = (ref: string) => `${titles.get(ref) ?? ref} (${ref})`;
  const citeAll = (label: string, refs: string[]) => (refs.length ? [`${label}: ${refs.map(cite).join(", ")}`] : []);
  const skillRefs = (ids: readonly string[]) => [...new Set(ids)].map((id) => `skill:${id}`);
  const alias = (full: string, short: string) => (short !== full ? [`Also called: ${short}`] : []);

  const sections: Section[] = [
    {
      ref: "doc:profile",
      title: "Profile",
      header: [profile.fullName, profile.role],
      lines: [
        `Name: ${profile.fullName}${profile.name !== profile.fullName ? `, known as ${profile.name}` : ""}`,
        `Role: ${profile.role}`,
        `Based in: ${profile.location} (time zone ${profile.timeZone})`,
        ...(profile.availability ? [`Availability: ${profile.availability.label}`] : []),
        `Shipping since ${computed.shippingSince}, the year ${profile.name}'s earliest listed role began.`,
        role
          ? `Current role: ${role.title} at ${role.company} (role:${role.id}), ${role.period}`
          : "Current role: none in progress",
        study
          ? `Current study: ${study.degree} at ${study.school} (edu:${study.id}), ${study.period}`
          : "Current study: none in progress",
        ...citeAll("Leads with", skillRefs(Object.values(profile.headline).flat())),
        `In ${profile.name}'s own words: "${profile.pitch}" "${profile.summary}"`,
      ],
    },
    {
      ref: "doc:resume",
      title: "Resume",
      header: [],
      lines: [
        `${profile.name}'s resume, a PDF that YashOS can open for the visitor.`,
        "The roles, projects, skills and education in this knowledge are adapted from it.",
      ],
    },
    ...content.roles.map((r) => ({
      ref: `role:${r.id}`,
      title: `${r.company} · ${r.title}`,
      header: [r.period],
      lines: [
        ...alias(r.company, r.short),
        `Location: ${r.location}`,
        `Summary: ${r.summary}`,
        "Highlights:",
        ...r.highlights.map((h) => `- ${h}`),
        ...citeAll("Skills", skillRefs(r.skills)),
      ],
    })),
    ...content.projects.map((p) => ({
      ref: `project:${p.id}`,
      title: p.name,
      header: [p.kind, ...(p.year ? [p.year] : [])],
      lines: [
        `Summary: ${p.summary}`,
        `Problem: ${p.problem}`,
        `Approach: ${p.approach}`,
        `Result: ${p.result}`,
        `Stack: ${p.stack.join(", ")}`,
      ],
    })),
    ...content.education.map((e) => ({
      ref: `edu:${e.id}`,
      title: `${e.school} · ${e.degree}`,
      header: [e.period],
      lines: [
        ...alias(e.school, e.short),
        `Focus: ${e.focus}`,
        `Location: ${e.location}`,
        ...citeAll("Skills", skillRefs(e.skills)),
      ],
    })),
    {
      ref: "doc:skills",
      title: "Skills",
      header: [],
      lines: [
        `Each skill is cited by its own ref. A note says where the skill did real work; a skill without a note is part of ${profile.name}'s everyday toolkit.`,
        "Domains:",
        ...content.domains.map((d) => `- ${d.label}: ${d.summary}`),
        "Skills:",
        ...content.skills.map(
          (s) => `- skill:${s.id} — ${s.label} (${domainLabel.get(s.domain) ?? s.domain})${s.note ? `: ${s.note}` : ""}`,
        ),
      ],
    },
    ...[...docs]
      .sort((a, b) => compare(a.ref, b.ref))
      .map((d) => ({ ref: d.ref, title: d.title, header: [], lines: [...citeAll("Related", d.refs), d.body.trim()] })),
  ];

  const rendered = sections.map((s) => {
    const out = [`## ${s.ref} — ${[s.title, ...s.header].join(" · ")}`, ...s.lines].join("\n");
    if (CONTACT.test(out)) {
      throw new Error(`${s.ref}: contains contact details (@, http or linkedin); contact goes through Messages`);
    }
    return out;
  });
  const text = `${rendered.join("\n\n")}\n`;
  const hash = sha256Hex(text);
  const refs = [...titles.keys()].sort(compare);

  return {
    version: hash.slice(0, 12),
    hash,
    text,
    refs,
    titles: Object.fromEntries(refs.map((ref) => [ref, titles.get(ref) ?? ref])),
    keyterms: keyterms(content),
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

/** Reads a knowledge doc: frontmatter `ref`, `title` and optional `refs: [a, b]`, then the body. */
export function docFromMarkdown(md: string, source: string): Doc {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(md);
  } catch (e) {
    throw new Error(`${source}: ${(e as Error).message}`, { cause: e });
  }
  const { data, body } = parsed;
  for (const key of Object.keys(data)) {
    if (!DOC_KEYS.has(key)) throw new Error(`${source}: unknown frontmatter key "${key}"`);
  }
  const text = (key: string) => {
    const value = data[key];
    if (typeof value !== "string" || value === "") throw new Error(`${source}: frontmatter needs a "${key}" line`);
    return value;
  };
  const refs = data.refs ?? [];
  return {
    ref: text("ref"),
    title: text("title"),
    refs: typeof refs === "string" ? [refs] : refs,
    // Line endings must not change the hash, or a CRLF checkout would see a stale bundle.
    body: body.replace(/\r\n/g, "\n"),
  };
}

/** Names Flux should recognise: Yash, companies, schools and projects, deduplicated. */
function keyterms(content: Content): string[] {
  const names = [
    content.profile.name,
    content.profile.fullName,
    ...content.roles.flatMap((r) => [r.company, r.short]),
    ...content.education.flatMap((e) => [e.school, e.short]),
    ...content.projects.map((p) => p.name),
  ];
  const seen = new Set<string>();
  return names
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_KEYTERMS);
}

/** Locale-independent ordering, so the bundle is identical on every machine. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// SHA-256 (FIPS 180-4), synchronous so buildBundle stays a pure function. node:crypto is not
// available under the Workers types this folder is checked with; tests compare against it.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** SHA-256 of the UTF-8 bytes of `input`, as 64 lowercase hex characters. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      w[i] = w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!;
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => (h[i] = h[i]! + x));
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
