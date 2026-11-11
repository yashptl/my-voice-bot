/**
 * The small subset of YAML frontmatter the knowledge docs use: `key: value` lines and
 * `key: [a, b]` lists between `---` fences. Anything else is an error, so a typo fails the build
 * instead of silently dropping a field.
 */
export function parseFrontmatter(md: string): { data: Record<string, string | string[]>; body: string } {
  const open = /^---\r?\n/.exec(md);
  if (!open) return { data: {}, body: md };

  const rest = md.slice(open[0].length);
  const close = /^---[ \t]*(\r?\n|$)/m.exec(rest);
  if (!close) throw new Error("frontmatter: missing closing --- fence");

  const data: Record<string, string | string[]> = {};
  const lines = rest.slice(0, close.index).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`frontmatter: line ${i + 1} is not "key: value"`);
    const [, key = "", raw = ""] = match;
    const value = raw.trim();
    data[key] = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").map(unquote).filter((item) => item !== "")
      : unquote(value);
  });

  return { data, body: rest.slice(close.index + close[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0] ? t.slice(1, -1) : t;
}
