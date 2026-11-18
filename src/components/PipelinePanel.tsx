import { Eye, EyeOff, Lightbulb, Plus, Redo2, Search, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { engine } from "../engine/client";
import { ADD_ORDER, STEP_DEFS, type Field } from "../steps";
import { useLab } from "../store";
import type { BadSuggestion, RecordingInfo, Step, StepType } from "../types";

type Editing = { type: StepType; id: string | null; params: Record<string, unknown> } | null;

export function PipelinePanel() {
  const info = useLab((s) => s.info)!;
  const steps = useLab((s) => s.steps);
  const past = useLab((s) => s.past);
  const future = useLab((s) => s.future);
  const busy = useLab((s) => s.busy);
  const { addStep, updateStep, toggleStep, removeStep, undo, redo, setTab } = useLab.getState();
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); void undo(); }
      else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) { e.preventDefault(); void redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const open = (type: StepType, step?: Step) => {
    setError(null);
    setEditing({ type, id: step?.id ?? null, params: { ...STEP_DEFS[type].defaults(info), ...(step?.params ?? {}) } });
  };

  const apply = async () => {
    if (!editing) return;
    const def = STEP_DEFS[editing.type];
    const problem = def.validate?.(editing.params, info) ?? null;
    if (problem) return setError(problem);
    const ok = editing.id
      ? await updateStep(editing.id, editing.params, def.verb)
      : await addStep(editing.type, editing.params, def.verb);
    if (ok) {
      setEditing(null);
      if (editing.type === "ica" && !editing.id) setTab("components");
    }
  };

  return (
    <aside className="side" data-tour="pipeline">
      <header className="side-head">
        <h2>Pipeline</h2>
        <div className="row">
          <button className="icon" title="Undo (Ctrl+Z)" disabled={!past.length || !!busy} onClick={() => void undo()}><Undo2 size={15} /></button>
          <button className="icon" title="Redo (Ctrl+Y)" disabled={!future.length || !!busy} onClick={() => void redo()}><Redo2 size={15} /></button>
        </div>
      </header>

      <ol className="steps">
        <li className="step fixed">
          <span className="step-n">0</span>
          <div className="step-body">
            <strong>Recording loaded</strong>
            <span>{info.channels.length} channels · {info.sfreq} Hz{info.montage ? " · standard positions" : ""}</span>
          </div>
        </li>
        {steps.map((s, i) => {
          const def = STEP_DEFS[s.type];
          return (
            <li key={s.id} className={`step ${s.enabled ? "" : "off"} ${editing?.id === s.id ? "active" : ""}`}>
              <span className="step-n">{i + 1}</span>
              <button className="step-body" onClick={() => (s.type === "ica" ? setTab("components") : open(s.type, s))} title="Edit this step">
                <strong>{def.label}</strong>
                <span>{def.summary(s.params)}</span>
              </button>
              <button className="icon" title={s.enabled ? "Turn off" : "Turn on"} disabled={!!busy} onClick={() => void toggleStep(s.id)}>
                {s.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button className="icon" title="Remove" disabled={!!busy} onClick={() => void removeStep(s.id)}><Trash2 size={14} /></button>
            </li>
          );
        })}
      </ol>
      {!steps.length && !editing && (
        <p className="hint">Each cleaning step you add appears here. Steps can be switched off, edited or undone at any time, and the whole list exports as Python code.</p>
      )}

      {editing ? (
        <StepForm
          editing={editing}
          info={info}
          error={error}
          busy={!!busy}
          onChange={(params) => { setError(null); setEditing({ ...editing, params }); }}
          onCancel={() => setEditing(null)}
          onApply={() => void apply()}
        />
      ) : (
        <div className="add" data-tour="add-step">
          <h3><Plus size={13} /> Add a step</h3>
          <div className="add-grid">
            {ADD_ORDER.map((t) => (
              <button key={t} disabled={!!busy} onClick={() => open(t)} data-step={t}>{STEP_DEFS[t].label}</button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function StepForm(props: {
  editing: NonNullable<Editing>;
  info: RecordingInfo;
  error: string | null;
  busy: boolean;
  onChange: (p: Record<string, unknown>) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { editing, info } = props;
  const def = STEP_DEFS[editing.type];
  const p = editing.params;
  const set = (k: string, v: unknown) => props.onChange({ ...p, [k]: v });
  const [found, setFound] = useState<BadSuggestion[] | null>(null);
  const [searching, setSearching] = useState(false);

  const detect = async () => {
    setSearching(true);
    try {
      const r = await engine.call<{ bads: BadSuggestion[] }>("detect_bads");
      setFound(r.bads);
      const merged = new Set([...(p.channels as string[]), ...r.bads.map((b) => b.name)]);
      set("channels", [...merged]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); props.onApply(); }}>
      <div className="form-head">
        <h3>{editing.id ? "Edit" : "Add"}: {def.label}</h3>
        <button type="button" className="icon" onClick={props.onCancel} title="Close"><X size={15} /></button>
      </div>
      <p className="explain">{def.explain}</p>
      {def.tip && <p className="tip"><Lightbulb size={13} /> <span>{def.tip}</span></p>}

      {def.presets && (
        <div className="chips">
          {def.presets.map((pr) => (
            <button type="button" key={pr.label} className="chip" onClick={() => props.onChange({ ...p, ...pr.params })}>{pr.label}</button>
          ))}
        </div>
      )}

      {editing.type === "bads" && (
        <>
          <button type="button" className="btn ghost wide" onClick={() => void detect()} disabled={searching}>
            <Search size={14} /> {searching ? "Checking every channel…" : "Find bad channels for me"}
          </button>
          {found && (
            <ul className="found">
              {found.length ? found.map((b) => <li key={b.name}><b>{b.name}</b> {b.reason}</li>) : <li>No problem channels found.</li>}
            </ul>
          )}
        </>
      )}

      {def.fields.map((f) => <FieldInput key={f.key} field={f} params={p} set={set} info={info} />)}

      {props.error && <p className="error">{props.error}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={props.onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={props.busy} data-tour="apply">{editing.id ? "Update" : "Apply"}</button>
      </div>
    </form>
  );
}

function FieldInput({ field, params, set, info }: {
  field: Field; params: Record<string, unknown>; set: (k: string, v: unknown) => void; info: RecordingInfo;
}) {
  const v = params[field.key];
  if (field.kind === "number") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <div className="input-unit">
          <input
            type="number" inputMode="decimal" value={v == null ? "" : String(v)} min={field.min} max={field.max} step="any"
            placeholder={field.optional ? field.hint ?? "none" : ""}
            onChange={(e) => set(field.key, e.target.value === "" ? null : Number(e.target.value))}
          />
          {field.unit && <em>{field.unit}</em>}
        </div>
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select
          value={String(v)}
          onChange={(e) => {
            const opt = field.options.find((o) => String(o.value) === e.target.value);
            set(field.key, opt ? opt.value : e.target.value);
          }}
        >
          {field.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  if (field.kind === "toggle") {
    return (
      <label className="field check">
        <input type="checkbox" checked={!!v} onChange={(e) => set(field.key, e.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.showIf && !field.showIf(params)) return null;
  const chosen = new Set((v as string[]) ?? []);
  return (
    <div className="field">
      <span>{field.label} <em className="count">{chosen.size} chosen</em></span>
      <div className="chan-grid">
        {info.channels.filter((c) => c.type === "eeg").map((c) => (
          <button
            type="button" key={c.name} className={chosen.has(c.name) ? "on" : ""}
            onClick={() => {
              const next = new Set(chosen);
              if (next.has(c.name)) next.delete(c.name); else next.add(c.name);
              set(field.key, [...next]);
            }}
          >{c.name}</button>
        ))}
      </div>
    </div>
  );
}
