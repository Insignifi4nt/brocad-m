import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FlipHorizontalIcon, LinearPatternIcon } from '@wire-edm/icons-react';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchLinearPattern } from '@/domain/cad/cadSketchGraph';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { CadScalarEditContext, ScalarField, type CadScalarValueDraft, type CadScalarEditContextValue } from './CadFields';
import { CadContextHelp } from './CadContextHelp';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import { cadGeneratorRemovals } from './cadGeneratorRemovals';
import { useCadGeneratorRemovalConfirmation } from './useCadGeneratorRemovalConfirmation';
import { CadSketchCommandForm, useCadSketchCommandSession, type CadSketchCommandSessionProps } from './useCadSketchCommandSession';

export type CadSketchLinearPatternRequest = { readonly kind: 'create'; readonly seedEntityId: string } | { readonly kind: 'edit'; readonly relationId: string; readonly detach?: true };
export interface CadSketchLinearPatternInteraction {
  readonly relation: CadSketchLinearPattern;
  readonly detaching: boolean;
  onToggleInstance(index: number): void;
}
interface Props extends CadSketchCommandSessionProps {
  sketch: CadSketchFeature; request: CadSketchLinearPatternRequest;
  onPrepareEdits?: CadPrepareEdits;
  onInteractionChange(interaction: CadSketchLinearPatternInteraction | null): void;
  onAccepted(result: { seedEntityId: string; relationId: string | null }): void;
}
function initialRelation(props: Props): CadSketchLinearPattern {
  if (props.request.kind === 'edit') {
    const id = props.request.relationId, relation = props.sketch.graph?.relations.find(r => r.id === id);
    if (relation?.kind !== 'linear-pattern') throw new Error('The selected sketch pattern is unavailable.');
    return relation;
  }
  const id = props.request.seedEntityId, seed = props.sketch.graph?.entities.find(e => e.id === id);
  if (seed?.kind !== 'circle') throw new Error('Choose a circle to repeat.');
  const prefix = 'pattern_' + crypto.randomUUID().replaceAll('-', '');
  return { id: prefix + '_owner', kind: 'linear-pattern', seed: { kind: 'circle', entityId: seed.id, centerPointId: seed.centerPointId },
    idPrefix: prefix, direction: '+x', count: 4, spacing: 3 * evaluateCadScalar(seed.radius, props.document.parameters), omittedInstances: [] };
}
/** A disposable owner edit; generated circles are ordinary graph geometry supplied by shared preparation. */
export function CadSketchLinearPatternEditor(props: Props) {
  const session = useCadSketchCommandSession(props, () => ({ sketch: props.sketch, relation: initialRelation(props), existing: props.request.kind === 'edit' }),
    latest => latest.onInteractionChange(null));
  const { owner, setError } = session;
  const [draft, setDraft] = useState(owner.relation), [countText, setCountText] = useState(String(owner.relation.count));
  const [detaching, setDetaching] = useState(props.request.kind === 'edit' && props.request.detach === true);
  const [parameterEdits, setParameterEdits] = useState<Readonly<Record<string, number>>>({});
  const [valueDraft, storeValueDraft] = useState<CadScalarValueDraft | null>(null), [scalarIssue, storeIssue] = useState<string | null>(null);
  const [bindingPending, storeBindingPending] = useState(false), [relationEdited, storeRelationEdited] = useState(false);
  const count = Number(countText), countInvalid = !countText.trim() || !Number.isInteger(count) || count < 1 || count > 32;
  const scalarPending = countInvalid || Boolean(scalarIssue) || bindingPending;
  const parameters = useMemo(() => ({ ...owner.document.parameters, ...parameterEdits }), [owner, parameterEdits]);
  const setValueDraft = useCallback((_key: string, value: CadScalarValueDraft | null) => { storeValueDraft(value); setError(null); }, []);
  const setIssue = useCallback((_key: string, issue: string | null) => storeIssue(issue), []);
  const setRelationPending = useCallback((_key: string, pending: boolean) => storeBindingPending(pending), []);
  const markRelationEdited = useCallback(() => storeRelationEdited(true), []);
  const changeParameter = useCallback((name: string, value: number) => {
    setError(null); setParameterEdits(previous => { const next = { ...previous }; if (value === owner.document.parameters[name]) delete next[name]; else next[name] = value; return next; });
  }, [owner]);
  const scalarContext: CadScalarEditContextValue = { parameters, acceptedScalars: { spacing: owner.relation.spacing }, relationEdits: relationEdited ? { spacing: true } : {},
    valueDrafts: valueDraft ? { spacing: valueDraft } : {}, setValueDraft, setIssue, setRelationPending, markRelationEdited, changeParameter };
  const local = useRef({ scalarPending, detaching }); local.current = { scalarPending, detaching };
  const onToggleInstance = useCallback((index: number) => {
    if (session.closed() || local.current.scalarPending || local.current.detaching || !Number.isInteger(index)) return;
    setError(null); setDraft(relation => index > 0 && index < relation.count ? { ...relation,
      omittedInstances: relation.omittedInstances.includes(index) ? relation.omittedInstances.filter(i => i !== index) : [...relation.omittedInstances, index].sort((a, b) => a - b) } : relation);
  }, [owner]);
  const interaction = useMemo<CadSketchLinearPatternInteraction | null>(() => session.previewEnabled && !scalarPending
    ? { relation: draft, detaching, onToggleInstance } : null, [session.previewEnabled, scalarPending, draft, detaching, onToggleInstance]);
  useLayoutEffect(() => { props.onInteractionChange(interaction); }, [interaction, props.onInteractionChange]);
  const edits = useMemo<readonly CadEdit[] | null>(() => scalarPending ? null : [
    ...Object.entries(parameterEdits).map(([name, value]): CadEdit => ({ kind: 'set-parameter', name, value })),
    ...(!owner.existing || !Value.Equal(draft, owner.relation) ? [{ kind: 'set-sketch-relation' as const, sketchId: owner.sketch.id, relation: draft }] : []),
    ...(detaching ? [{ kind: 'remove-sketch-relation' as const, sketchId: owner.sketch.id, relationId: draft.id }] : [])
  ], [scalarPending, parameterEdits, owner, draft, detaching]);
  // A parameter change that removes relations as a generator regenerates asks first; the next Apply removes them with the pattern.
  const confirmation = useCadGeneratorRemovalConfirmation(owner.document, edits), { hold } = confirmation;
  const prepared = useCadPreparedPreview(owner.document, confirmation.edits, props.onPrepareEdits, session.previewEnabled);
  const found = prepared.kind === 'error' ? prepared.removals : undefined;
  useEffect(() => { hold(found); }, [found, hold]);
  useLayoutEffect(() => { props.onPreviewDocument(prepared.kind === 'ready' ? prepared.document : null, cadPreviewMarks(prepared)); }, [prepared, props.onPreviewDocument]);
  const issue = countInvalid ? 'Count must be a whole number from 1 to 32, including the seed.'
    : session.error ?? confirmation.issue ?? (prepared.kind === 'error' && !prepared.removals ? prepared.message : null);
  const result = { seedEntityId: draft.seed.entityId, relationId: detaching ? null : draft.id };
  return <CadSketchCommandForm label="Sketch linear pattern" title="Linear pattern" icon={<LinearPatternIcon size={14} />} session={session}
    canApply={edits !== null && (edits.length === 0 || prepared.kind === 'ready')} issue={issue}
    help="Repeat this circle along the sketch X or Y axis. Pitch is the distance between neighboring centers. Edit the seed to change every attached circle. Click a numbered occurrence in the preview to exclude or restore it. Exclusions survive count changes."
    status={<>{detaching && <span role="status">Apply keeps these circles as independent geometry.</span>}{prepared.kind === 'waiting' && <span role="status">Preparing preview…</span>}
      {!issue && confirmation.notice && <div className="cad-form-hint" role="status">{confirmation.notice}</div>}</>}
    onSubmit={() => {
      if (!edits) return;
      if (!edits.length) session.finish(() => props.onAccepted(result));
      else if (prepared.kind === 'ready' && confirmation.edits) session.submit(confirmation.edits, prepared.document, () => props.onAccepted(result), 'The pattern could not be applied.',
        cause => hold(cadGeneratorRemovals(cause), edits));
    }}>
    <fieldset className="cad-editor-fieldset" disabled={props.interactionLocked || session.applying || detaching}>
      <label className="cad-field"><span>Count<CadContextHelp label="Pattern count">Total occurrences including the original seed, from 1 to 32. Reducing the count keeps omitted indexes for later increases. Dependent dimensions must be removed before their occurrence.</CadContextHelp></span>
        <Input aria-label="Count" type="number" min="1" max="32" step="1" value={countText} aria-invalid={countInvalid || undefined} onChange={event => {
          const text = event.target.value, next = Number(text); setCountText(text); setError(null);
          if (text.trim() && Number.isInteger(next) && next >= 1 && next <= 32) setDraft(relation => ({ ...relation, count: next }));
        }} /></label>
      <CadScalarEditContext.Provider value={scalarContext}><ScalarField fieldKey="spacing" label="Pitch" value={draft.spacing} parameters={parameters} onChange={spacing => { setError(null); setDraft(relation => ({ ...relation, spacing })); }} /></CadScalarEditContext.Provider>
      <div className="cad-sketch-profile-actions" role="group" aria-label="Pattern direction">
        {(['x', 'y'] as const).map(axis => <Button key={axis} type="button" aria-pressed={draft.direction.endsWith(axis)} onClick={() => { setError(null); setDraft(relation => ({ ...relation, direction: (relation.direction.startsWith('-') ? '-' : '+') + axis as CadSketchLinearPattern['direction'] })); }}>Local {axis.toUpperCase()}</Button>)}
        <Button type="button" aria-label="Reverse pattern direction" title="Reverse direction without changing the pitch relation" aria-pressed={draft.direction.startsWith('-')} onClick={() => { setError(null); setDraft(relation => ({ ...relation, direction: (relation.direction.startsWith('-') ? '+' : '-') + relation.direction.slice(1) as CadSketchLinearPattern['direction'] })); }}><FlipHorizontalIcon size={14} /></Button>
      </div>
    </fieldset>
    {owner.existing && <Button type="button" disabled={props.interactionLocked || session.applying || scalarPending} onClick={() => { setDetaching(value => !value); setError(null); }}>{detaching ? 'Keep pattern linked' : 'Detach pattern'}</Button>}
  </CadSketchCommandForm>;
}
