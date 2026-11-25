import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Removes // and block comments from JSONC, leaving anything inside a string alone. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const config = JSON.parse(stripComments(readFileSync("wrangler.jsonc", "utf8"))) as {
  routes: unknown;
  workers_dev: unknown;
  preview_urls: unknown;
  env: { staging: { routes: unknown; workers_dev: unknown } };
};

/**
 * Production is reachable only through one route on the site's zone; the site's own Worker serves
 * everything else. Staging is a separate Worker on workers.dev, so it must not inherit the route.
 */
describe("wrangler.jsonc", () => {
  it("serves production only on yashos.dev/assistant/*, with no workers.dev or preview URLs", () => {
    expect(config.routes).toEqual([{ pattern: "yashos.dev/assistant/*", zone_name: "yashos.dev" }]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });

  it("gives staging no route and a workers.dev address", () => {
    expect(config.env.staging.routes).toEqual([]);
    expect(config.env.staging.workers_dev).toBe(true);
  });
});
