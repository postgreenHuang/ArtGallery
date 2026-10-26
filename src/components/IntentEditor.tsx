import { useState, type FormEvent } from "react";
import type { SearchCriteria } from "../types";
import { criteriaGroups, normalizeIntentEdit, type CriteriaGroup } from "../domain/intentEdit";

export default function IntentEditor({ query, criteria, targetArtist, disabled, onApply, onCancel }: {
  query: string;
  criteria: SearchCriteria;
  targetArtist?: string;
  disabled: boolean;
  onApply: (query: string, criteria: SearchCriteria) => void;
  onCancel: () => void;
}) {
  const [draftQuery, setDraftQuery] = useState(query);
  const [draft, setDraft] = useState<SearchCriteria>({ ...criteria, required: [...criteria.required], preferred: [...criteria.preferred], excluded: [...criteria.excluded] });
  const [inputs, setInputs] = useState({ required: "", preferred: "", excluded: "" });
  const [error, setError] = useState("");
  const add = (group: CriteriaGroup) => {
    const value = inputs[group].trim();
    if (!value) return;
    if (value.length > 80 || draft[group].length >= 8) { setError("每类最多 8 项，单项最多 80 个字符。"); return; }
    setDraft((current) => ({ ...current, [group]: [...current[group], value] }));
    setInputs((current) => ({ ...current, [group]: "" }));
    setError("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = normalizeIntentEdit(draftQuery, draft);
      if (criteriaGroups.some(({ key }) => inputs[key].trim())) { setError("请先添加输入框中的条件。"); return; }
      onApply(next.query, next.criteria);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "条件格式不正确。"); }
  };
  return <form className="intent-editor" onSubmit={submit}>
    <label>检索词<input aria-label="编辑检索词" value={draftQuery} maxLength={160} onChange={(event) => setDraftQuery(event.target.value)} /></label>
    {targetArtist && <small>指定作者仍为 {targetArtist}；如要更换作者，请在对话框中提出。</small>}
    {criteriaGroups.map(({ key, label }) => <div className="intent-editor-row" key={key}>
      <strong>{label}</strong>
      <div className="intent-editor-items">{draft[key].map((value, index) => <button type="button" className="intent-chip" key={`${value}-${index}`}
        aria-label={`移除${label}条件 ${value}`} onClick={() => setDraft((current) => ({ ...current, [key]: current[key].filter((_, at) => at !== index) }))}>{value} ×</button>)}</div>
      <input aria-label={`添加${label}条件`} value={inputs[key]} maxLength={80} placeholder={`添加${label}条件`}
        onChange={(event) => setInputs((current) => ({ ...current, [key]: event.target.value }))}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(key); } }} />
      <button type="button" onClick={() => add(key)} disabled={disabled}>添加</button>
    </div>)}
    <label className="intent-image-check"><input type="checkbox" checked={draft.requiresImage} onChange={(event) => setDraft((current) => ({ ...current, requiresImage: event.target.checked }))} />需要结合画面核实</label>
    {error && <p role="alert">{error}</p>}
    <div className="intent-editor-actions"><button type="button" onClick={onCancel}>取消</button><button type="submit" disabled={disabled}>按新条件重新找</button></div>
  </form>;
}
