import type { DataLineStatus } from "../src/protocol/data-line";
import type { TurnRecord } from "../src/protocol/turn-record";

/** What a failed data line cost the answer; null for "ok", which the panel leaves out. */
const DATA_LINE_PROBLEMS: Record<DataLineStatus, string | null> = {
  ok: null,
  missing: "missing: the reply ended without one, so no sources and no contact flag",
  invalid: "invalid: it did not parse, so no coverage and no contact flag",
};

/**
 * "Under the hood" for one answer, collapsed until opened: what the server measured in the turn's
 * record, plus its data line and the refs its source chips show (from the data line, or from a bare
 * `<refs>` list when the data line failed). Everything here is diagnostics; nothing is visitor text.
 */
export function Inspector({
  record,
  coverage,
  refs,
}: {
  record: TurnRecord;
  coverage: string | null;
  refs: readonly string[];
}) {
  const { marks, tokens, gate, grounding } = record;
  // Null (the reply never finished) is left out too: the grounding row already says so.
  const dataLineProblem = record.dataLine ? DATA_LINE_PROBLEMS[record.dataLine] : null;
  return (
    <details className="inspector">
      <summary>Under the hood</summary>
      <dl>
        <dt>Model</dt>
        <dd>{record.model}</dd>

        {/* Non-breaking spaces keep each number with its label when the line wraps. */}
        <dt>Timings</dt>
        <dd className="num">
          first token&nbsp;{ms(marks.firstAnswerToken)} · first sentence&nbsp;{ms(marks.firstSentence)} ·
          done&nbsp;{ms(marks.done)}
        </dd>

        <dt>Tokens</dt>
        <dd className="num">
          {tokens.input}&nbsp;in · {tokens.cachedInput}&nbsp;cached · {tokens.output}&nbsp;out ·{" "}
          {tokens.reasoning}&nbsp;reasoning{tokens.reasoningEstimated ? " (estimated)" : ""}
        </dd>

        <dt>Cost</dt>
        <dd className="num">{record.costUsd === null ? "unknown (no prices for this model)" : `$${record.costUsd.toFixed(5)}`}</dd>

        <dt>Coverage</dt>
        <dd>{record.coverage ?? coverage ?? "none reported"}</dd>

        <dt>Refs</dt>
        <dd>{refs.length > 0 ? refs.join(", ") : "none"}</dd>

        {dataLineProblem && (
          <>
            <dt>Data line</dt>
            <dd className="error">{dataLineProblem}</dd>
          </>
        )}

        <dt>Output gate</dt>
        <dd>
          {gate.dropped === 0 ? "nothing dropped" : `${gate.dropped} dropped (${gate.reasons.join(", ")})`}
          {gate.flags.length > 0 && ` · flagged: ${gate.flags.join(", ")}`}
        </dd>

        <dt>Grounding</dt>
        <dd>
          <Grounding result={grounding} />
        </dd>

        {/* True but cited badly, so plain text: only an invented claim gets the highlight. */}
        {grounding && grounding.uncited.length > 0 && (
          <>
            <dt>Uncited</dt>
            <dd>{grounding.uncited.join(", ")} (in the knowledge, not in the refs cited)</dd>
          </>
        )}

        <dt>Hashes</dt>
        <dd className="hash">
          prompt <span title={record.promptHash}>{short(record.promptHash)}</span> · knowledge{" "}
          <span title={record.knowledgeHash}>{short(record.knowledgeHash)}</span>
        </dd>

        {record.error && (
          <>
            <dt>Error</dt>
            <dd className="error">{record.error}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

/** Unsupported (invented) claims, highlighted; uncited ones get their own quieter row. */
function Grounding({ result }: { result: TurnRecord["grounding"] }) {
  if (!result) return <>not checked (the answer did not finish)</>;
  const { checked, unsupported, uncited } = result;
  if (checked === 0) return <>no claims to check</>;
  if (unsupported.length === 0) {
    return <>{uncited.length === 0 ? `all ${checked} claims supported` : `none of ${checked} claims invented`}</>;
  }
  return (
    <>
      {unsupported.length} of {checked} claims unsupported:{" "}
      {unsupported.map((claim) => (
        <mark key={claim}>{claim}</mark>
      ))}
    </>
  );
}

function ms(value: number | undefined): string {
  return value === undefined ? "–" : `${Math.round(value)}\u00a0ms`;
}

function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}
