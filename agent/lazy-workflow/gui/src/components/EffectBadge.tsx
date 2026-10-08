import type { CatalogEffect } from "../../../src/cli/command-catalog-schema.ts";

const LABELS: Record<CatalogEffect, { label: string; title: string }> = {
  read: { label: "Lectura", title: "Solo consulta; no cambia nada." },
  write: { label: "Escritura", title: "Modifica un tracker, un repositorio o los secretos." },
  session: { label: "Sesion de agente", title: "Abre sesiones del agente de codificacion; puede publicar, empujar y mergear." },
  maintenance: { label: "Mantenimiento", title: "Reinstala la herramienta." },
};

export function EffectBadge({ effect }: { readonly effect: CatalogEffect }) {
  const { label, title } = LABELS[effect];
  return <span className={`badge badge-${effect}`} title={title}>{label}</span>;
}

export const EFFECT_CONFIRMATION: Record<Exclude<CatalogEffect, "read">, string> = {
  write: "Este comando modifica un tracker, un repositorio o los secretos.",
  session: "Este comando abre sesiones del agente de codificacion y puede publicar, empujar y mergear.",
  maintenance: "Este comando reinstala lz y sus integraciones.",
};
