import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The browser client is copied, unedited, into other repos and bundled there (with src/protocol).
 * This guards what that needs: nothing bundler-specific, and no import outside the files that
 * travel together.
 */
const ROOT = resolve(import.meta.dirname, "..");
const CLIENT = resolve(ROOT, "src/client");
const PROTOCOL_FILES = ["sse.ts", "version.ts", "audio.ts", "limits.ts"].map((f) => resolve(ROOT, "src/protocol", f));

interface Import {
  specifier: string;
  /** False for `import type` and for a declaration whose named specifiers are all `type`. */
  value: boolean;
}

function importsOf(file: string): Import[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Import[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)));
      found.push({ specifier: node.moduleSpecifier.text, value: !typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((e) => e.isTypeOnly));
      found.push({ specifier: node.moduleSpecifier.text, value: !typeOnly });
    }
  }
  return found;
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const clientEntries = readdirSync(CLIENT)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && f !== "testing.ts")
  .map((f) => resolve(CLIENT, f));

/**
 * Every file reachable from the client's own files through value imports, with each file's
 * imports. Type imports are erased at build, so they pull nothing into the host's bundle.
 */
function walk() {
  const seen = new Map<string, Import[]>();
  const queue = [...clientEntries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !file.endsWith(".ts")) continue;
    const imports = importsOf(file);
    seen.set(file, imports);
    for (const i of imports) {
      if (!i.value || !i.specifier.startsWith(".")) continue;
      const target = resolveRelative(file, i.specifier.replace(/\?.*$/, ""));
      if (target) queue.push(target);
    }
  }
  return seen;
}

const rel = (f: string) => relative(ROOT, f);

describe("the client can be copied into another bundler", () => {
  const files = walk();

  it("finds the client's files", () => {
    expect(files.size).toBeGreaterThan(5);
  });

  it("uses no bundler-specific import (a query in the specifier)", () => {
    const bad = [...files].flatMap(([file, imports]) => imports.filter((i) => i.specifier.includes("?")).map((i) => `${rel(file)}: ${i.specifier}`));
    expect(bad).toEqual([]);
  });

  it("imports values only from src/client, three protocol files, and react (in react.ts)", () => {
    const bad: string[] = [];
    for (const [file, imports] of files) {
      for (const i of imports.filter((x) => x.value)) {
        if (!i.specifier.startsWith(".")) {
          if (!(i.specifier === "react" && file === resolve(CLIENT, "react.ts"))) bad.push(`${rel(file)}: ${i.specifier}`);
          continue;
        }
        const target = resolveRelative(file, i.specifier);
        const allowed = target !== null && (dirname(target) === CLIENT || PROTOCOL_FILES.includes(target));
        if (!allowed) bad.push(`${rel(file)}: ${i.specifier}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the protocol files the client uses free of package imports", () => {
    const bad = PROTOCOL_FILES.flatMap((file) =>
      importsOf(file)
        .filter((i) => i.value && !i.specifier.startsWith("."))
        .map((i) => `${rel(file)}: ${i.specifier}`),
    );
    expect(bad).toEqual([]);
  });
});
