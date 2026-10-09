import { useState } from "react";
import { openUrl } from "../lib/platform.ts";

/** A collapsible tree; long arrays and objects open collapsed past the second level. */
export function JsonView({ value }: { readonly value: unknown }) {
  return (
    <div className="json mono">
      <JsonNode value={value} depth={0} name={null} />
    </div>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) {
      return (
        <a className="json-string link" href={value} onClick={(event) => { event.preventDefault(); void openUrl(value); }}>
          "{value}"
        </a>
      );
    }
    return <span className="json-string">"{value}"</span>;
  }
  if (typeof value === "number") return <span className="json-number">{value}</span>;
  if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function JsonNode({ value, depth, name }: { value: unknown; depth: number; name: string | null }) {
  const container = typeof value === "object" && value !== null;
  const entries = container ? (Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)) : [];
  const [open, setOpen] = useState(depth < 2 || entries.length <= 4);
  const label = name !== null ? <span className="json-key">{name}: </span> : null;
  if (!container) {
    return <div className="json-line">{label}<Scalar value={value} /></div>;
  }
  const [opening, closing] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return <div className="json-line">{label}{opening}{closing}</div>;
  return (
    <div>
      <div className="json-line clickable" onClick={() => setOpen(!open)}>
        <span className="json-toggle">{open ? "▾" : "▸"}</span>
        {label}
        {opening}
        {!open && <span className="muted"> {entries.length} {Array.isArray(value) ? "elementos" : "claves"} {closing}</span>}
      </div>
      {open && (
        <div className="json-children">
          {entries.map(([key, child]) => <JsonNode key={key} value={child} depth={depth + 1} name={Array.isArray(value) ? null : key} />)}
          <div className="json-line">{closing}</div>
        </div>
      )}
    </div>
  );
}
