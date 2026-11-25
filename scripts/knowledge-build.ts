/**
 * Builds knowledge/bundle.json from knowledge/content.json and knowledge/docs/*.md.
 *
 *   npm run knowledge:build   # writes the bundle
 *   npm run knowledge:check   # rebuilds in memory; fails if bundle.json is stale (CI)
 *
 * Both fail on an unknown ref in a doc, contact details in the text, or more than 60 000
 * estimated tokens (the point where the whole-bundle prompt should give way to search), and on any
 * section sentence the output gate would drop (a link-like name, say), which would otherwise vanish
 * from answers without a trace.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildBundle, docFromMarkdown } from "../src/knowledge/build";
import { gateSentence } from "../src/core/output-gate";
import { SentenceSplitter } from "../src/core/sentences";
import { ContentSchema } from "../src/knowledge/content-schema";

const TOKEN_LIMIT = 60_000;
const root = join(import.meta.dirname, "..");
const docsDir = join(root, "knowledge/docs");
const out = join(root, "knowledge/bundle.json");

/** Every sentence of every section that the output gate would block, with its section ref and reasons. */
function gateFailures(text: string): string[] {
  const failures: string[] = [];
  for (const section of text.split(/\n\n(?=## )/)) {
    const ref = /^## (\S+)/.exec(section)?.[1] ?? "?";
    const splitter = new SentenceSplitter();
    for (const sentence of [...splitter.push(section), ...splitter.flush()]) {
      const { blocked } = gateSentence(sentence, "");
      if (blocked.length > 0) failures.push(`${ref}: ${blocked.join(", ")}: ${sentence}`);
    }
  }
  return failures;
}

function main(check: boolean): number {
  const parsed = ContentSchema.safeParse(JSON.parse(readFileSync(join(root, "knowledge/content.json"), "utf8")));
  if (!parsed.success) {
    console.error(`knowledge/content.json does not match ContentSchema:\n${z.prettifyError(parsed.error)}`);
    return 1;
  }
  const docs = readdirSync(docsDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => docFromMarkdown(readFileSync(join(docsDir, file), "utf8"), `knowledge/docs/${file}`));

  const bundle = buildBundle(parsed.data, docs);
  const json = `${JSON.stringify(bundle, null, 2)}\n`;

  console.log(`bundle: ${bundle.tokenEstimate} tokens (limit ${TOKEN_LIMIT})`);
  if (bundle.tokenEstimate > TOKEN_LIMIT) {
    console.error("knowledge bundle is over the token limit");
    return 1;
  }
  const failures = gateFailures(bundle.text);
  if (failures.length > 0) {
    console.error(`the output gate would drop these knowledge sentences:\n${failures.join("\n")}`);
    return 1;
  }
  if (check) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== json) {
      console.error("knowledge/bundle.json is stale: run npm run knowledge:build");
      return 1;
    }
    console.log(`knowledge/bundle.json is up to date (version ${bundle.version}, ${bundle.refs.length} refs)`);
    return 0;
  }
  writeFileSync(out, json);
  console.log(`wrote knowledge/bundle.json (version ${bundle.version}, ${bundle.refs.length} refs)`);
  return 0;
}

try {
  process.exitCode = main(process.argv.includes("--check"));
} catch (error) {
  console.error(`knowledge build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
