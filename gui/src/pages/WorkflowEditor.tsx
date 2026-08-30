import { useState } from "react";
import { useT, type TFn } from "../i18n/shared";
import { IconCheck, IconX } from "../icons";
import type { WorkflowDefinition, WorkflowPhase } from "./Workflows";

export type { WorkflowDefinition, WorkflowPhase };

let phaseCounter = 0;

export interface WorkflowEditorProps {
  /** The draft being edited (may be a copy of a built-in). */
  draft: WorkflowDefinition;
  /** True when the id was set by the caller and must not change (override flow). */
  idLocked?: boolean;
  /** Shown when the draft overrides a built-in definition. */
  overridesBuiltin?: boolean;
  saving: boolean;
  errors: string[] | null;
  onSave: (draft: WorkflowDefinition) => void;
  onClose: () => void;
}

export default function WorkflowEditor({
  draft,
  idLocked,
  overridesBuiltin,
  saving,
  errors,
  onSave,
  onClose,
}: WorkflowEditorProps) {
  const t: TFn = useT();
  const [def, setDef] = useState<WorkflowDefinition>({ ...draft, phases: draft.phases.map(p => ({ ...p })) });
  const [clientErrors, setClientErrors] = useState<string[]>([]);

  const patchPhase = (index: number, patch: Partial<WorkflowPhase>) => {
    setDef(prev => ({
      ...prev,
      phases: prev.phases.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  };

  const movePhase = (index: number, delta: -1 | 1) => {
    setDef(prev => {
      const phases = [...prev.phases];
      const target = index + delta;
      if (target < 0 || target >= phases.length) return prev;
      [phases[index], phases[target]] = [phases[target], phases[index]];
      return { ...prev, phases };
    });
  };

  const removePhase = (index: number) => {
    setDef(prev => ({ ...prev, phases: prev.phases.filter((_, i) => i !== index) }));
  };

  const addPhase = (gate: boolean) => {
    phaseCounter += 1;
    setDef(prev => ({
      ...prev,
      phases: [
        ...prev.phases,
        gate
          ? { id: `gate-${phaseCounter}`, gate: { id: `gate-${phaseCounter}` } }
          : { id: `phase-${phaseCounter}`, mode: "chat" as const },
      ],
    }));
  };

  const roleKeys = new Set<string>(Object.keys(def.defaults ?? {}));
  for (const phase of def.phases) {
    if (phase.modelRef?.startsWith("role:")) roleKeys.add(phase.modelRef.slice(5));
  }

  const validate = (): string[] => {
    const problems: string[] = [];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(def.id)) problems.push(t("workflows.editor.errId"));
    if (def.phases.length === 0) problems.push(t("workflows.editor.errPhaseRequired"));
    const ids = new Set<string>();
    for (const phase of def.phases) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(phase.id)) problems.push(t("workflows.editor.errPhaseId", { id: phase.id }));
      if (ids.has(phase.id)) problems.push(t("workflows.editor.errDuplicate", { id: phase.id }));
      ids.add(phase.id);
    }
    if (def.phases[0]?.gate) problems.push(t("workflows.editor.errFirstGate"));
    return problems;
  };

  const save = () => {
    const problems = validate();
    setClientErrors(problems);
    if (problems.length === 0) onSave(def);
  };

  const allErrors = [...(clientErrors ?? []), ...(errors ?? [])];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container workflows-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-row">
            <h3 className="modal-title">{overridesBuiltin ? t("workflows.editor.customize", { id: draft.id }) : idLocked ? t("workflows.editor.edit") : t("workflows.editor.new")}</h3>
          </div>
          <button type="button" className="btn-icon-close" onClick={onClose}><IconX /></button>
        </div>

        <div className="modal-body">
          {overridesBuiltin && (
            <div className="workflows-editor-note">
              {t("workflows.editor.overrideNote")}
            </div>
          )}
          {allErrors.length > 0 && (
            <div className="workflows-editor-errors">
              {allErrors.map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}

          <div className="workflows-editor-grid">
            <label className="workflows-field">
              {t("workflows.editor.id")}
              <input
                type="text"
                className="mono"
                value={def.id}
                disabled={idLocked}
                onChange={e => setDef(prev => ({ ...prev, id: e.target.value }))}
              />
            </label>
            <label className="workflows-field">
              {t("workflows.editor.title")}
              <input
                type="text"
                value={def.title ?? ""}
                onChange={e => setDef(prev => ({ ...prev, title: e.target.value }))}
              />
            </label>
          </div>
          <label className="workflows-field">
            {t("workflows.editor.description")}
            <input
              type="text"
              value={def.description ?? ""}
              onChange={e => setDef(prev => ({ ...prev, description: e.target.value }))}
            />
          </label>

          <div className="workflows-editor-section">{t("workflows.editor.defaults")}</div>
          {Array.from(roleKeys).map(role => (
            <div key={role} className="workflows-editor-role-row">
              <span className="mono">{role}</span>
              <input
                type="text"
                className="mono"
                placeholder={t("workflows.editor.defaultsPlaceholder")}
                value={def.defaults?.[role] ?? ""}
                onChange={e =>
                  setDef(prev => ({
                    ...prev,
                    defaults: { ...(prev.defaults ?? {}), [role]: e.target.value },
                  }))
                }
              />
            </div>
          ))}
          {roleKeys.size === 0 && <p className="workflows-editor-hint">{t("workflows.editor.noRoles")}</p>}

          <div className="workflows-editor-section">{t("workflows.editor.phases")}</div>
          {def.phases.map((phase, i) => (
            <div key={i} className="workflows-editor-phase">
              <div className="workflows-editor-phase-row">
                <input
                  type="text"
                  className="mono workflows-editor-phase-id"
                  value={phase.id}
                  placeholder={t("workflows.editor.phaseIdPlaceholder")}
                  onChange={e => patchPhase(i, { id: e.target.value })}
                />
                <select
                  className="workflows-editor-phase-kind"
                  value={phase.gate ? "gate" : phase.mode ?? "chat"}
                  onChange={e => {
                    const v = e.target.value;
                    if (v === "gate") {
                      patchPhase(i, { gate: { id: phase.gate?.id || `${phase.id}-gate` }, modelRef: undefined });
                    } else {
                      const { gate: _g, ...rest } = phase;
                      patchPhase(i, { ...rest, mode: v as "chat" | "agent" });
                    }
                  }}
                >
                  <option value="chat">chat</option>
                  <option value="agent">agent</option>
                  <option value="gate">gate</option>
                </select>
                {!phase.gate && (
                  <input
                    type="text"
                    className="mono"
                    placeholder={t("workflows.editor.modelRefPlaceholder")}
                    value={phase.modelRef ?? ""}
                    onChange={e => patchPhase(i, { modelRef: e.target.value })}
                  />
                )}
                <div className="workflows-editor-phase-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => movePhase(i, -1)} disabled={i === 0}>↑</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => movePhase(i, 1)} disabled={i === def.phases.length - 1}>↓</button>
                  <button type="button" className="btn btn-ghost btn-sm workflows-abort" onClick={() => removePhase(i)}><IconX /></button>
                </div>
              </div>
              {phase.gate ? (
                <div className="workflows-editor-phase-row">
                  <input
                    type="text"
                    className="mono"
                    placeholder={t("workflows.editor.gateIdPlaceholder")}
                    value={phase.gate.id}
                    onChange={e => patchPhase(i, { gate: { ...phase.gate!, id: e.target.value } })}
                  />
                  <select
                    value={phase.gate.rejectTo ?? ""}
                    onChange={e => patchPhase(i, { gate: { ...phase.gate!, rejectTo: e.target.value || undefined } })}
                  >
                    <option value="">{t("workflows.editor.rejectNearest")}</option>
                    {def.phases.filter(p => !p.gate && p.id !== phase.id).map(p => (
                      <option key={p.id} value={p.id}>{t("workflows.editor.rejectTo", { phase: p.id })}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="workflows-editor-phase-detail">
                  <input
                    type="text"
                    placeholder={t("workflows.editor.promptPlaceholder")}
                    value={phase.prompt ?? ""}
                    onChange={e => patchPhase(i, { prompt: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder={t("workflows.editor.inputsPlaceholder")}
                    value={(phase.inputs ?? []).join(", ")}
                    onChange={e => patchPhase(i, {
                      inputs: e.target.value.split(",").map(x => x.trim()).filter(Boolean),
                    })}
                  />
                </div>
              )}
            </div>
          ))}
          <div className="workflows-editor-add-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => addPhase(false)}>{t("workflows.editor.addPhase")}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => addPhase(true)}>{t("workflows.editor.addGate")}</button>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t("workflows.editor.cancel")}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            <IconCheck /> {saving ? t("workflows.editor.saving") : t("workflows.editor.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
