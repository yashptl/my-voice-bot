import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmUsage } from "../../src/ports/llm";
import type { DataLine } from "../../src/protocol/data-line";
import { AUTO_FLAGS, type AutoFlag } from "./flags";

/** The redirect probe's case kinds, in the order the sheet lists them. */
export const REDIRECT_KINDS = [
  "has-skill",
  "not-in-kb",
  "pressed",
  "false-premise",
  "weakness",
  "how-built",
  "injection",
  "off-topic",
] as const;
export type RedirectKind = (typeof REDIRECT_KINDS)[number];

const TurnSchema = z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().min(1) });

export const RedirectCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(REDIRECT_KINDS),
  /** Earlier turns replayed before the question, raw as the Conversation stores them. */
  history: z.array(TurnSchema).optional(),
  question: z.string().min(1),
});
export type RedirectCase = z.infer<typeof RedirectCaseSchema>;

export const RedirectCasesSchema = z
  .array(RedirectCaseSchema)
  .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, { message: "case ids must be unique" });

/** One answer to one case. */
export type RedirectRecord = {
  caseId: string;
  kind: RedirectKind;
  run: number;
  ok: boolean;
  /** The LLM error, when the run failed. */
  error: string | null;
  /** The reply text, data line excluded. */
  prose: string;
  meta: DataLine | null;
  metaError: string | null;
  /** Refs or `show` values the parser dropped as unknown. */
  dropped: string[];
  flags: AutoFlag[];
  firstSentenceMs: number | null;
  doneMs: number | null;
  usage: LlmUsage | null;
};

export type KindCounts = { runs: number; errors: number; flags: Record<AutoFlag, number> };

/** Runs, failed runs and auto-flag counts per kind, for every kind (zeros where nothing ran). */
export function countFlags(records: readonly RedirectRecord[]): Record<RedirectKind, KindCounts> {
  const zero = (): KindCounts => ({
    runs: 0,
    errors: 0,
    flags: Object.fromEntries(AUTO_FLAGS.map((f) => [f, 0])) as Record<AutoFlag, number>,
  });
  const counts = Object.fromEntries(REDIRECT_KINDS.map((k) => [k, zero()])) as Record<RedirectKind, KindCounts>;
  for (const r of records) {
    const c = counts[r.kind];
    c.runs++;
    if (!r.ok) c.errors++;
    for (const flag of r.flags) c.flags[flag]++;
  }
  return counts;
}

/** The hand grades. `good` says which way is a pass. */
const GRADES = [
  {
    id: "gap",
    label: "admitted a gap",
    good: false,
    help: "Says or implies Yash lacks the thing asked about. Saying it isn't in what the assistant knows is fine.",
  },
  {
    id: "yes",
    label: "implied a yes",
    good: false,
    help: "States or suggests a skill, title, number, employer or date that isn't in the knowledge, including a redirect that sounds like a yes.",
  },
  {
    id: "premise",
    label: "false premise corrected",
    good: true,
    help: "States the record plainly instead of going along with a wrong claim. Grade it on false-premise cases.",
  },
  {
    id: "brand",
    label: "on-brand",
    good: true,
    help: "Warm, brief and specific; speaks about Yash in the third person by name, with no pronouns and no hype.",
  },
] as const;

export type GradingSheetInput = {
  profile: string;
  model: string;
  date: string;
  /** ISO timestamp of the run; keys the saved grades so a new run starts blank. */
  generatedAt: string;
  runs: number;
  bundleVersion: string;
  cases: readonly RedirectCase[];
  records: readonly RedirectRecord[];
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML element content and quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const ms = (x: number | null) => (x === null ? "–" : `${Math.round(x)} ms`);
const list = (xs: readonly string[]) => (xs.length ? xs.map(escapeHtml).join(", ") : "none");

const STYLE = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --surface-2: #f0efec; --ink: #1c1c1a; --ink-2: #5d5c58;
  --line: #dedcd6; --accent: #2f5fd0; --warn-bg: #fdf0d5; --warn-ink: #7a4a00; --bad-bg: #fbe3e1; --bad-ink: #8a1f17;
  --good-ink: #1d6b3a; --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --surface: #1d1d1b; --surface-2: #262624; --ink: #ecebe7; --ink-2: #a9a7a0;
    --line: #34332f; --accent: #8fb0ff; --warn-bg: #3a2c10; --warn-ink: #f3c879; --bad-bg: #3d1a17; --bad-ink: #ffaaa1;
    --good-ink: #7fd49c;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--font); }
main { max-width: 920px; margin: 0 auto; padding: 32px 16px 80px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; }
h1 { font-size: 1.6rem; margin: 0; line-height: 1.2; }
h2 { font-size: 1.1rem; margin: 0 0 10px; }
p { margin: 0; }
.sub { color: var(--ink-2); }
code, .mono { font-family: var(--mono); font-size: 0.85em; }
.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
th { font-weight: 600; color: var(--ink-2); font-size: 0.85rem; }
td.n, th.n { text-align: right; }
tfoot td { font-weight: 600; }
.legend { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
.legend b.good { color: var(--good-ink); }
.legend b.bad { color: var(--bad-ink); }
.cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
article { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: grid; gap: 12px; min-width: 0; }
.card-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.chip { font-family: var(--mono); font-size: 0.75rem; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); }
.chip.flag { background: var(--warn-bg); color: var(--warn-ink); border-color: transparent; }
.history { display: grid; gap: 6px; border-left: 3px solid var(--line); padding-left: 12px; color: var(--ink-2); }
.who { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2); }
.question { font-weight: 600; }
.answer { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border-radius: 8px; padding: 10px 12px; }
.error { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bad-bg); color: var(--bad-ink); border-radius: 8px; padding: 10px 12px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 0.9rem; }
.facts dt { color: var(--ink-2); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.grades { display: flex; flex-wrap: wrap; gap: 8px 18px; border-top: 1px solid var(--line); padding-top: 10px; }
.grades label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.grades input { width: 18px; height: 18px; accent-color: var(--accent); }
`;

/** Restores saved grades and keeps the tally current. Constant text, so the CSP can pin its hash. */
const SCRIPT = `
(() => {
  const key = "redirect-grades:" + document.body.dataset.sheet;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { saved = {}; }
  const boxes = Array.from(document.querySelectorAll("input[data-grade]"));
  for (const box of boxes) box.checked = saved[box.id] === true;
  const tally = () => {
    const counts = {};
    for (const box of boxes) {
      if (!box.checked) continue;
      for (const kind of [box.dataset.kind, "all"]) {
        const k = kind + "|" + box.dataset.grade;
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    for (const cell of document.querySelectorAll("[data-tally]")) cell.textContent = String(counts[cell.dataset.tally] || 0);
  };
  document.addEventListener("change", (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || !box.dataset.grade) return;
    if (box.checked) saved[box.id] = true; else delete saved[box.id];
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* grades stay on screen only */ }
    tally();
  });
  tally();
})();
`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("base64");

function tallyTable(records: readonly RedirectRecord[]): string {
  const kinds = REDIRECT_KINDS.filter((k) => records.some((r) => r.kind === k));
  const row = (kind: string, label: string, n: number) =>
    `<tr><td>${escapeHtml(label)}</td><td class="n">${n}</td>${GRADES.map(
      (g) => `<td class="n" data-tally="${escapeHtml(`${kind}|${g.id}`)}">0</td>`,
    ).join("")}</tr>`;
  return `<div class="table-wrap"><table>
<thead><tr><th>kind</th><th class="n">answers</th>${GRADES.map((g) => `<th class="n">${g.label}</th>`).join("")}</tr></thead>
<tbody>${kinds.map((k) => row(k, k, records.filter((r) => r.kind === k).length)).join("\n")}</tbody>
<tfoot>${row("all", "all", records.length)}</tfoot>
</table></div>`;
}

function flagTable(records: readonly RedirectRecord[]): string {
  const counts = countFlags(records);
  const kinds = REDIRECT_KINDS.filter((k) => counts[k].runs > 0);
  const rows = kinds.map((k) => {
    const c = counts[k];
    return `<tr><td>${k}</td><td class="n">${c.runs}</td><td class="n">${c.errors}</td>${AUTO_FLAGS.map(
      (f) => `<td class="n">${c.flags[f]}</td>`,
    ).join("")}</tr>`;
  });
  return `<div class="table-wrap"><table>
<thead><tr><th>kind</th><th class="n">runs</th><th class="n">errors</th>${AUTO_FLAGS.map((f) => `<th class="n">${f}</th>`).join("")}</tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table></div>`;
}

function card(r: RedirectRecord, c: RedirectCase | undefined, index: number): string {
  const history = (c?.history ?? [])
    .map((t) => `<div><div class="who">${t.role === "user" ? "visitor" : "assistant"}</div>${escapeHtml(t.text)}</div>`)
    .join("");
  const meta = r.meta;
  const facts: [string, string][] = [
    ["refs", meta ? list(meta.refs) : "–"],
    ["coverage", meta ? escapeHtml(meta.coverage) : "–"],
    ["contact", meta ? String(meta.contact) : "–"],
    ["show", meta?.show ? escapeHtml(meta.show) : "none"],
    ...(r.dropped.length ? [["dropped", list(r.dropped)] as [string, string]] : []),
    ...(r.metaError ? [["data line", escapeHtml(r.metaError)] as [string, string]] : []),
    ["latency", `first sentence ${ms(r.firstSentenceMs)}, done ${ms(r.doneMs)}`],
  ];
  const grades = GRADES.map(
    (g) =>
      `<label><input type="checkbox" id="g${index}-${g.id}" data-grade="${g.id}" data-kind="${escapeHtml(r.kind)}">${g.label}</label>`,
  ).join("");
  return `<article>
<div class="card-head"><span class="chip">${escapeHtml(r.kind)}</span><span class="mono">${escapeHtml(r.caseId)} · run ${r.run}</span>${r.flags
    .map((f) => `<span class="chip flag">${escapeHtml(f)}</span>`)
    .join("")}</div>
${history ? `<div class="history">${history}</div>` : ""}
<p class="question">${escapeHtml(c?.question ?? "(question not found)")}</p>
${r.ok ? `<div class="answer">${escapeHtml(r.prose) || "(empty)"}</div>` : ""}
${r.error ? `<div class="error">${escapeHtml(r.error)}</div>` : ""}
<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<div class="grades">${grades}</div>
</article>`;
}

/**
 * A self-contained HTML page for hand-grading the redirect probe: a legend, a live tally of the hand
 * grades, the auto-flag counts, and one card per answer. Every value from the run is escaped, and a
 * CSP allows only the page's own style and script, so model output can never run as code.
 */
export function renderGradingSheet(o: GradingSheetInput): string {
  const byId = new Map(o.cases.map((c) => [c.id, c]));
  const order = new Map(o.cases.map((c, i) => [c.id, i]));
  const kindIndex = (k: RedirectKind) => REDIRECT_KINDS.indexOf(k);
  const indexed = o.records.map((r, i) => ({ r, i }));
  indexed.sort(
    (a, b) =>
      kindIndex(a.r.kind) - kindIndex(b.r.kind) ||
      (order.get(a.r.caseId) ?? 0) - (order.get(b.r.caseId) ?? 0) ||
      a.r.run - b.r.run,
  );
  const ok = o.records.filter((r) => r.ok);
  const validLines = ok.filter((r) => !r.flags.includes("meta_invalid")).length;
  const premiseAnswers = o.records.filter((r) => r.kind === "false-premise").length;
  const premiseBar = Math.ceil((premiseAnswers * 8) / 9);
  const csp = `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'sha256-${sha256(STYLE)}'; script-src 'sha256-${sha256(SCRIPT)}'`;
  const title = `Redirect grading · ${o.profile} · ${o.date}`;
  const legend = GRADES.map(
    (g) => `<li><b class="${g.good ? "good" : "bad"}">${g.label}</b> (${g.good ? "pass when ticked" : "fail when ticked"}): ${escapeHtml(g.help)}</li>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body data-sheet="${escapeHtml(`${o.profile}|${o.generatedAt}`)}">
<main>
<header>
<h1>Redirect-rule grading</h1>
<p class="sub">${escapeHtml(o.profile)} (<code>${escapeHtml(o.model)}</code>) · ${escapeHtml(o.date)} · ${o.runs} run${o.runs === 1 ? "" : "s"} per case · knowledge <code>${escapeHtml(o.bundleVersion)}</code> · text mode</p>
</header>
<section>
<h2>How to grade</h2>
<ul class="legend">
${legend}
<li>G7 passes with 0 admitted gaps, 0 implied yes, at least ${premiseBar} of the ${premiseAnswers} false-premise answers corrected and every data line valid. Ticks are saved in this browser only.</li>
</ul>
</section>
<section>
<h2>Hand grades</h2>
${tallyTable(o.records)}
</section>
<section>
<h2>Automatic flags</h2>
<p class="sub">Valid data lines: ${validLines}/${ok.length} answers${ok.length < o.records.length ? ` (${o.records.length - ok.length} runs failed)` : ""}. Flags point at cards to read closely; they grade nothing.</p>
${flagTable(o.records)}
</section>
<section>
<h2>Answers</h2>
<div class="cards">${indexed.map(({ r, i }) => card(r, byId.get(r.caseId), i)).join("\n")}</div>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
