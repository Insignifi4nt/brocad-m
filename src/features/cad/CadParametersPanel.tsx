import { userFacingMessage } from '@/lib/userMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, ConfirmIcon, DeleteIcon, LinkIcon, PluginIcon, RenameIcon } from '@wire-edm/icons-react';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { inspectCadParameters, type CadParameterUsage } from '@/domain/cad/cadParameters';
import { formatCadLocalizedQuantity } from './cadDisplayQuantity';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { cadGeneratorRemovalIds, cadGeneratorRemovalText } from './cadGeneratorRemovals';
import './cad-parameters.css';

// A parameter's removals are the relations its new value removes as generators regenerate, which the next Apply confirms.
type Editor = { kind: 'parameter'; originalName: string | null; name: string; value: string; groupId: string; error: string; removals?: readonly string[] }
  | { kind: 'group'; originalId: string | null; name: string; error: string };
/** Commands the tree's Parameters menu sends; each is ignored while the panel is locked or already editing. */
export interface CadParametersPanelControls { create(kind: 'parameter' | 'group'): void }
export interface CadParametersPanelProps {
  controls?: Ref<CadParametersPanelControls>;
  document: CadDocument;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  onInspectParameter(name: string | null): void;
  onInspectUsage?(usage: Pick<CadParameterUsage, 'featureId' | 'profileId' | 'inputName'>): void;
  onPendingChange(pending: boolean): void;
  interactionLocked: boolean;
  cancelSignal: number;
}
const numericValue = (value: number) => formatCadLocalizedQuantity(value, 8, false);
export function CadParametersPanel({ controls, document: cadDocument, onEditMany, onInspectParameter, onInspectUsage, onPendingChange, interactionLocked, cancelSignal }: CadParametersPanelProps) {
  const inspection = useMemo(() => inspectCadParameters(cadDocument), [cadDocument]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const submission = useCadEditSubmission();
  const [position, setPosition] = useState({ left: 240, top: 100, width: 310 });
  const host = useRef<HTMLDivElement>(null), floating = useRef<HTMLDivElement>(null), previous = useRef<HTMLElement | null>(null);
  const editorDocument = useRef<CadDocument | null>(null);
  const pendingCallback = useRef(onPendingChange);
  const previousCancel = useRef(cancelSignal);
  const close = () => { submission.cancel(); setEditor(null); editorDocument.current = null; onInspectParameter(null); };
  useLayoutEffect(() => { pendingCallback.current = onPendingChange; onPendingChange(editor !== null); if (!editor) { previous.current?.focus(); previous.current = null; } }, [editor !== null, onPendingChange]);
  useEffect(() => () => pendingCallback.current(false), []);
  useEffect(() => { if (cancelSignal !== previousCancel.current) { previousCancel.current = cancelSignal; close(); } }, [cancelSignal]);
  useLayoutEffect(() => {
    if (!editor) return;
    const place = () => {
      const rect = host.current?.getBoundingClientRect();
      const width = Math.min(310, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min((rect?.right ?? 220) + 8, window.innerWidth - width - 12)), top: Math.max(12, Math.min((rect?.top ?? 80) + 4, window.innerHeight - 240)), width });
    };
    place(); floating.current?.querySelector<HTMLInputElement>('input')?.focus();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (host.current) observer?.observe(host.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [editor?.kind, editor?.kind === 'parameter' ? editor.originalName : editor?.originalId]);
  const begin = (next: Editor) => {
    if (interactionLocked || editor) return;
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editorDocument.current = cadDocument;
    setEditor(next); onInspectParameter(next.kind === 'parameter' ? next.originalName : null);
  };
  useImperativeHandle(controls, () => ({ create: kind => begin(kind === 'group' ? { kind: 'group', originalId: null, name: '', error: '' }
    : { kind: 'parameter', originalName: null, name: '', value: '', groupId: '', error: '' }) }));
  const update = (values: Partial<Pick<Editor, 'name' | 'error'>>) => setEditor(current => current ? { ...current, ...values, ...current.kind === 'parameter' ? { removals: undefined } : {} } : current);
  const report = (error: unknown) => {
    const removals = cadGeneratorRemovalIds(error);
    if (removals) setEditor(current => current?.kind === 'parameter' ? { ...current, removals, error: '' } : current);
    else update({ error: userFacingMessage(error, 'Unable to apply this change.') });
  };
  const assertCurrent = () => { if (editorDocument.current !== cadDocument) throw new Error('The part changed while this editor was open. Cancel and reopen it to edit the current values.'); };
  const apply = () => {
    if (!editor || interactionLocked || submission.applying) return;
    try {
      assertCurrent();
      const edits: CadEdit[] = [];
      const name = editor.name.trim();
      if (editor.kind === 'group') {
        if (!name || name.length > 160) throw new Error('Give this group a name of up to 160 characters.');
        if (inspection.groups.some(group => group.id !== editor.originalId && group.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'))) throw new Error('A group with this name already exists.');
        edits.push({ kind: 'set-parameter-group', group: { id: editor.originalId ?? `pg_${crypto.randomUUID()}`, name } });
      } else {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Use a letter or underscore first, then letters, digits or underscores (up to 64 characters).');
        if (name !== editor.originalName && Object.hasOwn(cadDocument.parameters, name)) throw new Error(`Parameter "${name}" already exists. Choose another name.`);
        const value = Number(editor.value);
        if (!editor.value.trim() || !Number.isFinite(value) || Math.abs(value) > 1e9) throw new Error('Enter a finite value between −1,000,000,000 and 1,000,000,000.');
        if (editor.originalName && editor.originalName !== name) edits.push({ kind: 'rename-parameter', name: editor.originalName, newName: name });
        if (!editor.originalName || cadDocument.parameters[editor.originalName] !== value) edits.push({ kind: 'set-parameter', name, value, ...editor.removals ? { removedRelationIds: [...editor.removals] } : {} });
        const originalGroupId = editor.originalName ? inspection.parameters.find(parameter => parameter.name === editor.originalName)?.groupId ?? '' : '';
        if (originalGroupId !== editor.groupId) edits.push({ kind: 'move-parameter', name, groupId: editor.groupId || null });
      }
      submission.submit(signal => onEditMany(edits, signal), close, report);
    } catch (error) { report(error); }
  };
  const selected = editor?.kind === 'parameter' ? inspection.parameters.find(parameter => parameter.name === editor.originalName) : undefined;
  const remove = () => {
    if (!editor || interactionLocked || submission.applying) return;
    try {
      assertCurrent();
      const edit: CadEdit | null = editor.kind === 'group' && editor.originalId ? { kind: 'remove-parameter-group', groupId: editor.originalId }
        : editor.kind === 'parameter' && editor.originalName ? { kind: 'remove-parameter', name: editor.originalName } : null;
      if (edit) submission.submit(signal => onEditMany([edit], signal), close, report);
    } catch (error) { report(error); }
  };
  const pluginLabel = (parameter: typeof inspection.parameters[number]) => {
    if (parameter.source.kind !== 'plugin') return parameter.name;
    const source = parameter.source;
    return inspection.pluginInputs.find(input => input.featureId === source.featureId && input.profileId === source.profileId && input.inputName === source.inputName)?.label ?? parameter.name;
  };
  const rows = (groupId: string | null) => inspection.parameters.filter(parameter => parameter.groupId === groupId).map(parameter => {
    const activeUses = parameter.usages.filter(usage => usage.active).length;
    return <Button type="button" key={parameter.name} className={`cad-parameter-list-row ${editor?.kind === 'parameter' && editor.originalName === parameter.name ? 'is-selected' : ''} ${activeUses ? '' : 'is-unused'}`} aria-label={`Edit parameter ${parameter.name}`} aria-pressed={editor?.kind === 'parameter' && editor.originalName === parameter.name} disabled={interactionLocked || editor !== null} title={`${parameter.name}: ${activeUses} active dimensions, ${parameter.usages.length} stored references${parameter.source.kind === 'plugin' ? '; plugin origin' : '; document parameter'}`} onClick={() => begin({ kind: 'parameter', originalName: parameter.name, name: parameter.name, value: String(parameter.value), groupId: parameter.groupId ?? '', error: '' })}>
      <span className="cad-parameter-origin">{parameter.source.kind === 'plugin' ? <PluginIcon size={11} /> : <LinkIcon size={11} />}</span><span className="cad-parameter-row-name">{pluginLabel(parameter)}</span><span className="cad-parameter-use-count" aria-label={`${activeUses} active uses`}>{activeUses || (parameter.usages.length ? 'Inactive' : 'Unused')}</span><output>{numericValue(parameter.value)}</output>
    </Button>;
  });
  const localInputs = inspection.pluginInputs.filter(input => !input.linked);
  return <div ref={host} className="cad-parameters-panel">
    <div className="cad-parameter-list">
      {inspection.groups.map(group => <details key={group.id} className="cad-parameter-group" open><summary>{inspection.parameters.some(parameter => parameter.groupId === group.id && parameter.source.kind === 'plugin') && <PluginIcon size={10} aria-label="Plugin parameters" />}<span>{group.name}</span><small>{inspection.parameters.filter(parameter => parameter.groupId === group.id).length}</small><Button type="button" aria-label={`Rename parameter group ${group.name}`} disabled={interactionLocked || editor !== null} onClick={event => { event.preventDefault(); begin({ kind: 'group', originalId: group.id, name: group.name, error: '' }); }}><RenameIcon size={10} /></Button></summary>{rows(group.id)}</details>)}
      {inspection.parameters.some(parameter => parameter.groupId === null) && <details className="cad-parameter-group" open><summary><span>{inspection.groups.length ? 'Ungrouped' : 'Parameters'}</span></summary>{rows(null)}</details>}
      {localInputs.length > 0 && <details className="cad-parameter-group cad-local-inputs"><summary><span>Local profile inputs</span><small>{localInputs.length}</small></summary>{localInputs.map(input => <Button type="button" className="cad-local-input-row" key={`${input.featureId}/${input.profileId}/${input.inputName}`} disabled={!onInspectUsage || interactionLocked || editor !== null} aria-label={`Inspect ${input.profileName} ${input.label}`} title={`${input.featureName} / ${input.profileName}. Configure this value in its profile.`} onClick={() => onInspectUsage?.(input)}><PluginIcon size={10} /><span>{input.label}<small>{input.profileName}</small></span><output>{input.appliedValue === undefined ? '—' : numericValue(input.appliedValue)}</output><small>{!input.effective ? 'auto' : !input.editable ? 'locked' : 'local'}</small></Button>)}</details>}
    </div>
    {editor && createPortal(<div ref={floating} className="cad-parameter-editor" role="dialog" aria-label={editor.kind === 'group' ? editor.originalId ? 'Edit parameter group' : 'New parameter group' : editor.originalName ? `Edit ${editor.originalName}` : 'New parameter'} style={{ ...position, maxHeight: window.innerHeight - position.top - 12 }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header><strong>{editor.kind === 'group' ? 'Parameter group' : selected ? pluginLabel(selected) : editor.kind === 'parameter' && editor.originalName ? editor.originalName : 'New parameter'}</strong><Button type="button" aria-label="Close parameter editor" onClick={close}><CloseIcon size={14} /></Button></header>
      <form aria-busy={submission.applying || undefined} onSubmit={event => { event.preventDefault(); apply(); }}>
        <fieldset disabled={interactionLocked || submission.applying}>
          <label><span>{editor.kind === 'group' ? 'Group name' : 'Name'}</span><Input aria-label={editor.kind === 'group' ? 'Group name' : 'Parameter name'} value={editor.name} spellCheck={false} autoComplete="off" onChange={event => update({ name: event.target.value, error: '' })} /></label>
          {editor.kind === 'parameter' && <><label><span>Value</span><Input aria-label="Parameter value" inputMode="decimal" value={editor.value} onChange={event => setEditor(current => current?.kind === 'parameter' ? { ...current, value: event.target.value, error: '', removals: undefined } : current)} /></label><label><span>Group</span><Select aria-label="Parameter group" value={editor.groupId} onChange={event => setEditor(current => current?.kind === 'parameter' ? { ...current, groupId: event.target.value, error: '' } : current)}><option value="">Ungrouped</option>{inspection.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></label></>}
          {selected && <details className="cad-parameter-usage" open><summary>{selected.usages.length ? `Used by ${selected.usages.length} dimension${selected.usages.length === 1 ? '' : 's'}` : 'Unused'}</summary>{selected.usages.map((usage, index) => <div key={`${usage.featureId}/${usage.path}/${index}`} className={usage.active ? '' : 'is-inactive'}><Button type="button" disabled={!onInspectUsage} aria-label={`Inspect ${usage.featureName}${usage.inputName ? ` ${usage.inputName}` : ''}`} onClick={() => onInspectUsage?.(usage)}>{usage.featureName}{usage.inputName ? ` · ${usage.inputName}` : ''}</Button><code>{usage.expression}</code>{!usage.active && <small>{usage.reason ?? 'Inactive'}</small>}</div>)}</details>}
          {editor.error && <p className="cad-parameter-error" role="alert">{editor.error}</p>}
          {editor.kind === 'parameter' && editor.removals && <p className="cad-form-hint" role="status">{cadGeneratorRemovalText(cadDocument, editor.removals)} Apply removes {editor.removals.length === 1 ? 'it' : 'them'}, or Cancel keeps {editor.removals.length === 1 ? 'it' : 'them'}.</p>}
        </fieldset>
        <footer>{(editor.kind === 'parameter' && editor.originalName || editor.kind === 'group' && editor.originalId) && <Button variant="danger" type="button" className="cad-parameter-delete" aria-label={editor.kind === 'group' ? 'Remove parameter group' : 'Remove parameter'} disabled={interactionLocked || submission.applying || editor.kind === 'parameter' && Boolean(selected?.usages.length)} title={selected?.usages.length ? 'This parameter is referenced. Remove its links before deleting it.' : editor.kind === 'group' ? 'Keeps values and moves them to Ungrouped' : 'Remove this unused value'} onClick={remove}><DeleteIcon size={12} /></Button>}<Button type="button" onClick={close}>Cancel</Button><Button variant="primary" type="submit" className="cad-parameter-apply" disabled={interactionLocked || submission.applying}><ConfirmIcon size={12} /> Apply</Button></footer>
      </form>
    </div>, document.body)}
  </div>;
}
