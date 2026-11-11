export const REF_KINDS = ["role", "project", "skill", "edu", "story", "policy", "doc"] as const;

export type RefKind = (typeof REF_KINDS)[number];

/** A citation into the knowledge bundle, e.g. `role:magenta`. */
export type Ref = `${RefKind}:${string}`;

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function isRefKind(s: string): s is RefKind {
  return (REF_KINDS as readonly string[]).includes(s);
}

export function parseRef(s: string): { kind: RefKind; id: string } | null {
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const kind = s.slice(0, colon);
  const id = s.slice(colon + 1);
  return isRefKind(kind) && ID.test(id) ? { kind, id } : null;
}
