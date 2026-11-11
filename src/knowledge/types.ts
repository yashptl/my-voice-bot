/** The knowledge the model may cite, built by scripts/knowledge-build.ts into knowledge/bundle.json. */
export interface Bundle {
  /** First 12 hex characters of `hash`. */
  version: string;
  /** SHA-256 hex of `text`. */
  hash: string;
  text: string;
  /** Every citable ref, sorted. */
  refs: string[];
  titles: Record<string, string>;
  /** Names Flux should recognise (companies, schools, projects, "Yash"). */
  keyterms: string[];
  tokenEstimate: number;
}
