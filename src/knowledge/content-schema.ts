import { z } from "zod";

/**
 * The facts synced from YashOS (lib/content) into knowledge/content.json. Objects are strict and
 * list only what the assistant may repeat: contact details (email, LinkedIn, the resume link) are
 * left out on purpose, because contact goes through Messages, so adding a field here is a choice.
 */

/** Ids become refs (`role:<id>`), so they follow the ref id rule in src/protocol/refs.ts. */
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "ids are lowercase letters, digits and dashes");
const Text = z.string().min(1);

export const ProfileSchema = z.strictObject({
  name: Text,
  fullName: Text,
  role: Text,
  /** Yash's own first-person words. */
  pitch: Text,
  /** Yash's own first-person words. */
  summary: Text,
  location: Text,
  timeZone: Text,
  /** null means say nothing about availability. */
  availability: z.strictObject({ open: z.boolean(), label: Text }).nullable(),
  /** The skills Yash leads with, in named groups (skill ids). */
  headline: z.record(z.string(), z.array(Id)),
});

export const DomainSchema = z.strictObject({ id: Id, label: Text, summary: Text });

export const RoleSchema = z.strictObject({
  id: Id,
  company: Text,
  short: Text,
  title: Text,
  location: Text,
  /** As on the resume: "Jun 2023 - Jan 2024", or "Aug 2025 - now" while current. */
  period: Text,
  summary: Text,
  highlights: z.array(Text),
  skills: z.array(Id),
});

export const ProjectSchema = z.strictObject({
  id: Id,
  name: Text,
  kind: Text,
  year: Text.optional(),
  summary: Text,
  problem: Text,
  approach: Text,
  result: Text,
  /** Free-text technology names, not skill ids. */
  stack: z.array(Text),
});

export const SkillSchema = z.strictObject({
  id: Id,
  label: Text,
  domain: Id,
  /** Where the skill did real work; skills without one are part of the everyday toolkit. */
  note: Text.optional(),
});

export const EducationSchema = z.strictObject({
  id: Id,
  school: Text,
  short: Text,
  degree: Text,
  focus: Text,
  location: Text,
  period: Text,
  skills: z.array(Id),
});

/** Facts YashOS derives from the lists, synced as values so the bundle never computes dates. */
export const ComputedSchema = z.strictObject({
  /** The year the earliest role began. */
  shippingSince: z.number().int().min(1900).max(2100),
  currentRoleId: Id.nullable(),
  currentStudyId: Id.nullable(),
});

export const ContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    profile: ProfileSchema,
    domains: z.array(DomainSchema),
    roles: z.array(RoleSchema),
    projects: z.array(ProjectSchema),
    skills: z.array(SkillSchema),
    education: z.array(EducationSchema),
    computed: ComputedSchema,
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const ids = (list: { id: string }[], path: string) => {
      const seen = new Set<string>();
      list.forEach((item, i) => {
        if (seen.has(item.id)) issue(`duplicate id "${item.id}"`, [path, i, "id"]);
        seen.add(item.id);
      });
      return seen;
    };

    const domains = ids(c.domains, "domains");
    const skills = ids(c.skills, "skills");
    const roles = ids(c.roles, "roles");
    const study = ids(c.education, "education");
    ids(c.projects, "projects");

    const knownSkills = (list: string[], path: (string | number)[]) =>
      list.forEach((id, i) => {
        if (!skills.has(id)) issue(`unknown skill "${id}"`, [...path, i]);
      });
    c.skills.forEach((s, i) => {
      if (!domains.has(s.domain)) issue(`unknown domain "${s.domain}"`, ["skills", i, "domain"]);
    });
    c.roles.forEach((r, i) => knownSkills(r.skills, ["roles", i, "skills"]));
    c.education.forEach((e, i) => knownSkills(e.skills, ["education", i, "skills"]));
    Object.entries(c.profile.headline).forEach(([group, list]) => knownSkills(list, ["profile", "headline", group]));

    const { currentRoleId, currentStudyId } = c.computed;
    if (currentRoleId !== null && !roles.has(currentRoleId)) {
      issue(`unknown role "${currentRoleId}"`, ["computed", "currentRoleId"]);
    }
    if (currentStudyId !== null && !study.has(currentStudyId)) {
      issue(`unknown degree "${currentStudyId}"`, ["computed", "currentStudyId"]);
    }
  });

export type Content = z.infer<typeof ContentSchema>;
