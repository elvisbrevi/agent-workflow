import { Fragment, useMemo } from "react";
import { markdownBlocks, type Inline } from "../lib/markdown.ts";
import { readResult, type PlannedTicketView, type PublishedItemView, type ResultPart } from "../lib/output.ts";
import type { RunState } from "../lib/runs.ts";

function InlineText({ inline }: { inline: readonly Inline[] }) {
  return (
    <>
      {inline.map((part, index) =>
        part.kind === "strong" ? <strong key={index}>{part.text}</strong>
          : part.kind === "code" ? <code key={index}>{part.text}</code>
            : <Fragment key={index}>{part.text}</Fragment>)}
    </>
  );
}

/** What an agent wrote for a person, drawn as the page draws its own text. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return <h4 key={index}><InlineText inline={block.inline} /></h4>;
          case "paragraph":
            return <p key={index}><InlineText inline={block.inline} /></p>;
          case "code":
            return <pre key={index}><code>{block.text}</code></pre>;
          case "list": {
            const items = block.items.map((item, position) => <li key={position}><InlineText inline={item} /></li>);
            return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
        }
      })}
    </div>
  );
}

const usd = new Intl.NumberFormat("es-CL", { style: "currency", currency: "USD", currencyDisplay: "code", maximumFractionDigits: 2 });

function sessionMeta(cost: number | null, outputTokens: number | null): string | null {
  const parts = [
    ...(cost !== null ? [`costo ${usd.format(cost)}`] : []),
    ...(outputTokens !== null ? [`${outputTokens.toLocaleString("es-CL")} tokens de salida`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}

function hours(estimate: number | null): string | null {
  return estimate === null ? null : `${estimate.toLocaleString("es-CL")} h`;
}

/** One ticket of a plan: published when it has an id, proposed when it does not yet. */
function TicketItem({ title, planned, published }: { title: string; planned: PlannedTicketView | undefined; published?: PublishedItemView }) {
  const estimate = hours(planned?.estimate ?? null);
  return (
    <li className="result-ticket">
      {(published || estimate) && (
        <div className="entry-line">
          {published && <span className="entry-id">#{published.id}</span>}
          {published?.type && <span className="kind-chip">{published.type}</span>}
          {published?.created === true && <span className="state-chip ok">Creado</span>}
          {published?.created === false && <span className="state-chip">Ya existía</span>}
          {estimate && <span className="state-chip">{estimate}</span>}
        </div>
      )}
      <strong className="entry-title">{title}</strong>
      {planned && planned.blockedBy.length > 0 && <p className="muted small">Bloqueado por: {planned.blockedBy.join(", ")}</p>}
      {planned?.body && (
        <details className="ticket-body">
          <summary>Descripción</summary>
          <Markdown text={planned.body} />
        </details>
      )}
    </li>
  );
}

function Publication({ part, plan }: { part: Extract<ResultPart, { kind: "publication" }>; plan: ReadonlyMap<string, PlannedTicketView> }) {
  const noun = part.tracker === "azure" ? "Tickets publicados" : "Issues publicados";
  return (
    <section className="panel-section" aria-label={noun}>
      <h3>{noun}{part.parent ? ` en la ${part.parent}` : ""}</h3>
      <ul className="task-list">
        {part.items.map((item) => <TicketItem key={item.id} title={item.title} published={item} planned={plan.get(item.title.trim())} />)}
      </ul>
      {part.blockingLinks > 0 && <p className="muted small">{part.blockingLinks} relación(es) de bloqueo registradas.</p>}
    </section>
  );
}

function AgentSummary({ part, published }: { part: Extract<ResultPart, { kind: "agent" }>; published: boolean }) {
  const meta = sessionMeta(part.cost, part.outputTokens);
  return (
    <>
      <section className="result-summary" aria-label="Resumen del agente">
        <h3>Resumen</h3>
        {part.summary ? <Markdown text={part.summary} /> : <p className="muted">La sesión no dejó un resumen.</p>}
        {meta && <p className="muted small">{meta}</p>}
      </section>
      {/* A plan nobody published yet — its publication failed, or it is still under way — is shown as proposed. */}
      {part.plan && !published && (
        <section className="panel-section" aria-label="Plan propuesto">
          <h3>Plan propuesto</h3>
          {part.plan.length === 0
            ? <p className="muted">El plan no requiere tickets de entrega.</p>
            : <ul className="task-list">{part.plan.map((ticket) => <TicketItem key={ticket.title} title={ticket.title} planned={ticket} />)}</ul>}
        </section>
      )}
    </>
  );
}

/** What the run answered on stdout, read for a person; the documents as printed stay one click away. */
export function RunResult({ run }: { run: RunState }) {
  const { parts, documents } = useMemo(() => readResult(run.stdout), [run.stdout]);
  const published = parts.some((part) => part.kind === "publication");
  const plan = useMemo(() => new Map(parts.flatMap((part) =>
    part.kind === "agent" && part.plan ? part.plan.map((ticket) => [ticket.title.trim(), ticket] as const) : [])), [parts]);
  if (parts.length === 0 && documents.length === 0) return null;
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case "agent":
            return <AgentSummary key={index} part={part} published={published} />;
          case "publication":
            return <Publication key={index} part={part} plan={plan} />;
          case "text":
            return <section key={index} className="result-text" aria-label="Resultado"><h3>Resultado</h3><Markdown text={part.text} /></section>;
        }
      })}
      {documents.length > 0 && (
        <details className="result-json">
          <summary>Resultado técnico</summary>
          <pre>{documents.map((document) => JSON.stringify(document, null, 2)).join("\n\n")}</pre>
        </details>
      )}
    </>
  );
}
