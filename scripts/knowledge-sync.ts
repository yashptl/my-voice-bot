/**
 * Copies Yash's facts from the YashOS repo into knowledge/content.json. Knowledge flows one way:
 * YashOS (lib/content) is the source of truth, and this file is never edited by hand.
 *
 *   npm run knowledge:sync                    # reads ../portfolio-os
 *   PORTFOLIO_DIR=/path/to/repo npm run knowledge:sync
 *
 * Only the fields ContentSchema lists are copied, so a new field in YashOS (or its email and
 * LinkedIn) never reaches the assistant unless the schema adds it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  ContentSchema,
  DomainSchema,
  EducationSchema,
  ProfileSchema,
  ProjectSchema,
  RoleSchema,
  SkillSchema,
} from "../src/knowledge/content-schema";

type Row = Record<string, unknown>;

const root = join(import.meta.dirname, "..");
const portfolio = resolve(root, process.env.PORTFOLIO_DIR ?? "../portfolio-os");

async function load(name: string): Promise<Row> {
  return (await import(pathToFileURL(join(portfolio, "lib/content", `${name}.ts`)).href)) as Row;
}

function rows(mod: Row, name: string): unknown[] {
  const value = mod[name];
  if (!Array.isArray(value)) throw new Error(`lib/content: expected ${name} to be an array`);
  return value;
}

/** Copies the keys a schema lists, skipping undefined, so nothing unlisted is synced. */
function pick(row: unknown, schema: { shape: object }): Row {
  const source = (row ?? {}) as Row;
  return Object.fromEntries(
    Object.keys(schema.shape)
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

async function main(): Promise<number> {
  const [profile, experience, projects, skills, education] = await Promise.all([
    load("profile"),
    load("experience"),
    load("projects"),
    load("skills"),
    load("education"),
  ]);
  const PROFILE = (profile.PROFILE ?? {}) as Row;
  const current = (mod: Row, name: string) => ((mod[name] ?? null) as Row | null)?.id ?? null;

  const parsed = ContentSchema.safeParse({
    schemaVersion: 1,
    profile: pick(PROFILE, ProfileSchema),
    domains: rows(skills, "DOMAINS").map((d) => pick(d, DomainSchema)),
    roles: rows(experience, "ROLES").map((r) => pick(r, RoleSchema)),
    projects: rows(projects, "PROJECTS").map((p) => pick(p, ProjectSchema)),
    skills: rows(skills, "SKILLS").map((s) => pick(s, SkillSchema)),
    education: rows(education, "EDUCATION").map((e) => pick(e, EducationSchema)),
    computed: {
      shippingSince: PROFILE.shippingSince,
      currentRoleId: current(experience, "CURRENT_ROLE"),
      currentStudyId: current(education, "CURRENT_STUDY"),
    },
  });
  if (!parsed.success) {
    console.error(`knowledge:sync: ${portfolio}/lib/content does not match ContentSchema:\n${z.prettifyError(parsed.error)}`);
    return 1;
  }

  const content = parsed.data;
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge/content.json"), `${JSON.stringify(content, null, 2)}\n`);
  console.log(
    `content: ${content.roles.length} roles, ${content.projects.length} projects, ${content.skills.length} skills, ` +
      `${content.education.length} degrees -> knowledge/content.json`,
  );
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(`knowledge:sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
