import { useEffect, useRef, useState } from "react";
import { errorText, webTransport } from "../lib/backend.ts";
import type { QuestionRound } from "../../../src/interaction/question-round.ts";

export function WebInterview({ path }: { path: string }) {
  const [round, setRound] = useState<QuestionRound | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentRound = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await webTransport.request<{ status: string; round?: QuestionRound }>(`${path}/round`);
        if (cancelled) return;
        const next = result.round ?? null;
        if (currentRound.current !== (next?.round ?? null)) setAnswers(Object.fromEntries(next?.questions.map((q) => [q.id, q.recommended]) ?? []));
        currentRound.current = next?.round ?? null;
        setRound(next);
        setError(null);
      } catch (error) { if (!cancelled) setError(errorText(error)); }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [path]);
  return <form className="stack web-interview" onSubmit={(event) => {
    event.preventDefault(); if (!round) return; setBusy(true);
    void webTransport.request(`${path}/answers`, { round: round.round, answers: round.questions.map((q) => ({ id: q.id, answer: answers[q.id] ?? q.recommended })) })
      .then(() => setRound(null), (error) => setError(errorText(error))).finally(() => setBusy(false));
  }}>
    {error && <div className="callout error" role="alert">{error}</div>}
    {!round && <div>Esperando la siguiente ronda…</div>}
    {round?.questions.map((question) => <label className="stack" key={question.id}>
      <strong>{question.question}</strong><span className="muted small">{question.rationale}</span>
      {question.options?.length ? <select className="input" value={question.options.includes(answers[question.id] ?? "") ? answers[question.id] : ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}><option value="">Respuesta libre…</option>{question.options.map((option) => <option key={option}>{option}</option>)}</select> : null}
      <textarea className="input" value={answers[question.id] ?? question.recommended} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
    </label>)}
    {round && <button type="submit" className="button primary" disabled={busy}>Enviar respuestas</button>}
  </form>;
}
