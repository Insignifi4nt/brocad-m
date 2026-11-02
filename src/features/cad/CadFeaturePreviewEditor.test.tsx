import { act, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadBuildResult, CadDocument, CadFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { cadGeneratorRemovals, cadGeneratorRemovalText } from './cadGeneratorRemovals';
import { CadFeatureEditor } from './CadFeatureEditor';
import { CadSession } from './cadSession';
import { cadFeatureCandidateEdits, cadFeatureCandidateKey, type CadFeaturePreviewCommand, type CadFeaturePreviewState } from './cadFeaturePreview';
import { applyCadEdits } from '@/domain/cad/cadOperations';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const part: CadDocument = { ...createCadDocument('Preview block', 'preview_block'), parameters: { depth: 10 }, features: [
  { kind: 'sketch', id: 'outline', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [{ id: 'rectangle', name: 'Rectangle', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] },
  { kind: 'extrude', id: 'pad', name: 'Pad', suppressed: false, sketchId: 'outline', distance: 'depth', symmetric: false, operation: 'new', targetId: null }
] };
async function changeLength(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Length mm"]'), setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing Length field');
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function changeLengthExpression(value: string) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Length relation"]'); if (!trigger) throw new Error('Missing expression control');
  await act(async () => trigger.click());
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Length expression"]'), setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing expression field');
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const keep = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Keep relation'); if (!keep) throw new Error('Missing relation action');
  await act(async () => keep.click());
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Length relation help"]'); if (!close) throw new Error('Missing relation close');
  await act(async () => close.click());
}
it('shows the current native preview solid count while keeping old, failed and unknown preview facts distinct from Apply eligibility', async () => {
  const session = new CadSession(part), before = session.getSnapshot(), preview = vi.fn<(command: CadFeaturePreviewCommand) => void>();
  let publish: ((state: CadFeaturePreviewState) => void) | undefined;
  function Harness() {
    const [state, setState] = useState<CadFeaturePreviewState>({ kind: 'idle' }); publish = setState;
    return <CadFeatureEditor feature={before.document.features[1]} document={before.document} isNew={false} documentVersion={before.version}
      featurePreview={state} onFeaturePreview={preview} onApply={vi.fn()} onCancel={vi.fn()} onPendingChange={session.setWorkflowOpen} />;
  }
  await act(async () => root.render(<Harness />)); await changeLength('20');
  const command = preview.mock.calls.at(-1)?.[0]; if (!command || command.kind !== 'candidate') throw new Error('Expected candidate');
  const mesh = { featureId: 'pad', name: 'Pad', positions: [], normals: [], indices: [], edges: [], faceGroups: [], edgeGroups: [], volume: 4000,
    bounds: { min: [0, 0, 0] as const, max: [20, 10, 20] as const } };
  const result: CadBuildResult = { buildId: 'current', meshes: [{ ...mesh, solidCount: 2 }], diagnostics: [], durationMs: 1 };
  const ready: Extract<CadFeaturePreviewState, { kind: 'ready' }> = { kind: 'ready', owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad', candidateId: 'current',
    definitionKey: cadFeatureCandidateKey(command.edits), document: applyCadEdits(before.document, command.edits), result };
  await act(async () => publish?.(ready));
  // The panel stays quiet: Apply alone says whether the current draft has a valid preview.
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const apply = container.querySelector<HTMLButtonElement>('button[type="submit"]'); if (!apply) throw new Error('Apply missing'); expect(apply.disabled).toBe(false);
  await changeLength('21');
  expect(apply.disabled).toBe(true);
  const next = preview.mock.calls.at(-1)?.[0]; if (!next || next.kind !== 'candidate') throw new Error('Expected next candidate');
  await act(async () => publish?.({ ...ready, kind: 'waiting', definitionKey: cadFeatureCandidateKey(next.edits), candidateId: 'next', lastValid: ready }));
  expect(apply.disabled).toBe(true);
  await act(async () => publish?.({ ...ready, kind: 'error', definitionKey: cadFeatureCandidateKey(next.edits), candidateId: 'next', stage: 'kernel', message: 'Join could not be built', diagnostics: [], lastValid: ready }));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Join could not be built'); expect(apply.disabled).toBe(true);
  await act(async () => publish?.({ ...ready, candidateId: 'unknown', definitionKey: cadFeatureCandidateKey(next.edits), document: applyCadEdits(before.document, next.edits),
    result: { ...result, meshes: [mesh] } }));
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(apply.disabled).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: false });
});
it('edits a displayed Pad depth through its exact named driver, previews all dependents and commits the correlated batch as one reversible history step', async () => {
  const outline = part.features[0], pad = part.features[1]; if (outline.kind !== 'sketch' || pad.kind !== 'extrude') throw new Error('Expected sources');
  const document = { ...part, features: [outline, { ...pad, distance: ' depth ' },
    { ...outline, id: 'follower', name: 'Following sketch', offset: 'depth / 2' },
    { ...pad, id: 'secondary', name: 'Secondary Pad', sketchId: 'follower', distance: 'depth * 3' }
  ] }, session = new CadSession(document), before = session.getSnapshot(), preview = vi.fn<(command: CadFeaturePreviewCommand) => void>();
  let publish: ((state: CadFeaturePreviewState) => void) | undefined;
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), [state, setState] = useState<CadFeaturePreviewState>({ kind: 'idle' }); publish = setState;
    return <CadFeatureEditor feature={snapshot.document.features[1]} document={snapshot.document} isNew={false} documentVersion={snapshot.version}
      featurePreview={state} onFeaturePreview={preview} onApply={(feature, parameters) => session.edit(cadFeatureCandidateEdits({ feature, isNew: false, parameters }))}
      onCancel={vi.fn()} onPendingChange={session.setWorkflowOpen} />;
  }
  await act(async () => root.render(<Harness />));
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Length mm"]')?.value).toBe('10');
  await changeLength('20');
  const command = preview.mock.calls.at(-1)?.[0]; if (!command || command.kind !== 'candidate') throw new Error('Expected correlated candidate');
  expect(command.edits).toEqual([{ kind: 'update-feature', feature: before.document.features[1] }, { kind: 'set-parameter', name: 'depth', value: 20 }]);
  const candidate = applyCadEdits(before.document, command.edits);
  expect(candidate.features).toEqual(before.document.features); expect(candidate.parameters.depth).toBe(20);
  expect(session.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: false, workflowOpen: true });
  const apply = container.querySelector<HTMLButtonElement>('button[type="submit"]'); if (!apply) throw new Error('Apply missing'); expect(apply.disabled).toBe(true);
  await act(async () => publish?.({ kind: 'ready', owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad', candidateId: 'depth_20',
    definitionKey: cadFeatureCandidateKey(command.edits), document: candidate, result: { buildId: 'depth_20', meshes: [], diagnostics: [], durationMs: 1 } }));
  await act(async () => apply.click());
  const accepted = session.getSnapshot(); expect(accepted).toMatchObject({ canUndo: true, workflowOpen: false }); expect(accepted.document).toEqual(candidate);
  const follower = accepted.document.features[2], secondary = accepted.document.features[3]; if (follower.kind !== 'sketch' || secondary.kind !== 'extrude') throw new Error('Expected dependents');
  expect(evaluateCadScalar(follower.offset, accepted.document.parameters)).toBe(10); expect(evaluateCadScalar(secondary.distance, accepted.document.parameters)).toBe(60);
  await act(async () => session.undo()); expect(session.getSnapshot().document).toEqual(before.document); expect(session.getSnapshot().canUndo).toBe(false);
});
it('emits provisional native preview commands for expression edits and clears its own preview on Cancel without touching the shared part', async () => {
  const session = new CadSession(part), before = session.getSnapshot(), preview = vi.fn();
  function Harness() {
    const [visible, setVisible] = useState(true);
    return visible ? <CadFeatureEditor feature={before.document.features[1]} document={before.document} isNew={false}
      {...{ documentVersion: before.version, onFeaturePreview: preview }} onApply={feature => session.edit([{ kind: 'update-feature', feature }])}
      onPendingChange={session.setWorkflowOpen} onCancel={() => setVisible(false)} /> : null;
  }
  await act(async () => root.render(<Harness />)); preview.mockClear();
  await changeLengthExpression('depth * 2');
  expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'candidate', owner: expect.any(String), expectedVersion: before.version,
    edits: [{ kind: 'update-feature', feature: expect.objectContaining({ id: 'pad', distance: 'depth * 2' }) }] }));
  expect(session.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: false, workflowOpen: true });
  const owner = preview.mock.calls.at(-1)?.[0].owner;
  const cancel = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel'); if (!cancel) throw new Error('Missing Cancel');
  await act(async () => cancel.click());
  expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner });
  expect(session.getSnapshot().document).toBe(before.document); expect(session.getSnapshot().version).toBe(before.version); expect(session.getSnapshot().canUndo).toBe(false);
});

it('does not authorize the current feature formula from a ready preview built with a different shared parameter batch', async () => {
  const session = new CadSession(part), before = session.getSnapshot(), preview = vi.fn<(command: CadFeaturePreviewCommand) => void>(), onApply = vi.fn();
  let publish: ((state: CadFeaturePreviewState) => void) | undefined;
  function Harness() {
    const [state, setState] = useState<CadFeaturePreviewState>({ kind: 'idle' }); publish = setState;
    return <CadFeatureEditor feature={before.document.features[1]} document={before.document} isNew={false} documentVersion={before.version}
      featurePreview={state} onFeaturePreview={preview} onApply={onApply} onCancel={vi.fn()} onPendingChange={session.setWorkflowOpen} />;
  }
  await act(async () => root.render(<Harness />)); await changeLengthExpression('depth * 2');
  const command = preview.mock.calls.at(-1)?.[0]; if (!command || command.kind !== 'candidate') throw new Error('Expected candidate');
  const wrongEdits = [command.edits[0], { kind: 'set-parameter', name: 'depth', value: 30 }] as const;
  await act(async () => publish?.({ kind: 'ready', owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad', candidateId: 'wrong_parameters',
    definitionKey: cadFeatureCandidateKey(wrongEdits), document: applyCadEdits(before.document, wrongEdits), result: { buildId: 'wrong', meshes: [], diagnostics: [], durationMs: 1 } }));
  const apply = container.querySelector<HTMLButtonElement>('button[type="submit"]'); if (!apply) throw new Error('Apply missing');
  expect(apply.disabled).toBe(true); await act(async () => apply.click()); expect(onApply).not.toHaveBeenCalled();
  await act(async () => publish?.({ kind: 'ready', owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad', candidateId: 'current',
    definitionKey: cadFeatureCandidateKey(command.edits), document: applyCadEdits(before.document, command.edits), result: { buildId: 'current', meshes: [], diagnostics: [], durationMs: 1 } }));
  expect(apply.disabled).toBe(false);
});

it('never promotes an unfinished feature draft to a replacement document version', async () => {
  const session = new CadSession(part), before = session.getSnapshot(), preview = vi.fn<(command: CadFeaturePreviewCommand) => void>();
  let refresh: (() => void) | undefined;
  function Harness() {
    const [version, setVersion] = useState(before.version);
    refresh = () => setVersion(session.getSnapshot().version);
    return <CadFeatureEditor feature={before.document.features[1]} document={session.getSnapshot().document} isNew={false}
      documentVersion={version} onFeaturePreview={preview} onApply={feature => session.edit([{ kind: 'update-feature', feature }])}
      onPendingChange={session.setWorkflowOpen} onCancel={() => undefined} />;
  }
  await act(async () => root.render(<Harness />));
  await changeLengthExpression('depth * 2');
  const candidate = preview.mock.calls.at(-1)?.[0];
  if (!candidate || candidate.kind !== 'candidate') throw new Error('Expected preview candidate.');
  preview.mockClear();
  await act(async () => { session.replace({ ...part, name: 'Replaced accepted part' }); refresh?.(); });
  expect(preview.mock.calls.some(([command]) => command.kind === 'candidate')).toBe(false);
  expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: candidate.owner });
  expect([...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Apply')?.disabled).toBe(true);
  expect(container.textContent).toContain('The part changed');
  expect(session.getSnapshot().document.features[1]).toMatchObject({ distance: 'depth' });
});

it('asks before a Pad parameter removes relations as a generator regenerates, applies the confirmed removal as one step, and Cancel keeps the part', async () => {
  // n sizes the Pad and the polygon's sides; a user point on the fifth corner loses its "c4" when n becomes 4.
  const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
    geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
  const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'g-poly_v4')!.position;
  const source = parseCadDocument({ ...createCadDocument('Polygon block', 'polygon_block'), schemaVersion: 2, parameters: { n: 5 }, features: [
    { kind: 'sketch', id: 'outline', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [],
      graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [polygon, { id: 'c4', kind: 'coincident', pointIds: ['u', 'g-poly_v4'] }] } },
    { kind: 'extrude', id: 'pad', name: 'Pad', suppressed: false, sketchId: 'outline', distance: 'n', symmetric: false, operation: 'new', targetId: null }] });
  const relationIds = (document: CadDocument) => { const sketch = document.features[0]; return sketch.kind === 'sketch' ? sketch.graph?.relations.map(relation => relation.id) : undefined; };
  const prompt = /^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*\. Apply removes it, or Cancel keeps it\.$/;
  const asked = () => container.querySelector('.cad-form-hint[role="status"]')?.textContent ?? null;
  const session = new CadSession(source), before = session.getSnapshot(), preview = vi.fn<(command: CadFeaturePreviewCommand) => void>(), cancelled = vi.fn();
  const onApply = vi.fn((feature: CadFeature, parameters: Readonly<Record<string, number>>, _signal?: AbortSignal, removedRelationIds?: readonly string[]) =>
    session.edit(cadFeatureCandidateEdits({ feature, isNew: false, parameters, removedRelationIds })));
  let publish: ((state: CadFeaturePreviewState) => void) | undefined;
  function Harness({ previewing = true, opening }: { previewing?: boolean; opening?: Readonly<Record<string, number>> }) {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), [state, setState] = useState<CadFeaturePreviewState>({ kind: 'idle' }); publish = setState;
    return <CadFeatureEditor feature={snapshot.document.features[1]} document={snapshot.document} isNew={false} documentVersion={previewing ? snapshot.version : undefined}
      featurePreview={state} onFeaturePreview={previewing ? preview : undefined} onApply={onApply} onCancel={cancelled} onPendingChange={session.setWorkflowOpen} initialParameters={opening} />;
  }
  /** Publishes what the coordinator would for the latest candidate: its unconfirmed removals, or the document it makes. */
  async function answer() {
    const command = preview.mock.calls.at(-1)?.[0]; if (!command || command.kind !== 'candidate') throw new Error('Expected candidate');
    const identity = { owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad', candidateId: `c${preview.mock.calls.length}`, definitionKey: cadFeatureCandidateKey(command.edits) };
    try {
      const document = applyCadEdits(before.document, command.edits);
      await act(async () => publish?.({ ...identity, kind: 'ready', document, result: { buildId: identity.candidateId, meshes: [], diagnostics: [], durationMs: 1 } }));
    } catch (error) {
      const removals = cadGeneratorRemovals(error); if (!removals) throw error;
      await act(async () => publish?.({ ...identity, kind: 'error', stage: 'validation', message: cadGeneratorRemovalText(before.document, removals), removals, diagnostics: [] }));
    }
    return command;
  }
  const apply = () => { const found = container.querySelector<HTMLButtonElement>('button[type="submit"]'); if (!found) throw new Error('Apply missing'); return found; };
  await act(async () => root.render(<Harness />)); await changeLength('4');
  const first = await answer();
  expect(first.edits).toEqual([{ kind: 'update-feature', feature: before.document.features[1] }, { kind: 'set-parameter', name: 'n', value: 4 }]);
  // The preview's removals ask in the editor's words, never as an error, and the confirmed candidate previews next.
  expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(apply().disabled).toBe(true);
  const confirmed = await answer();
  expect(confirmed.edits).toEqual([first.edits[0], { kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }]);
  expect(asked()).toMatch(prompt); expect(apply().disabled).toBe(false); expect(session.getSnapshot().document).toBe(before.document);
  await act(async () => apply().click());
  expect(onApply).toHaveBeenLastCalledWith(before.document.features[1], { n: 4 }, expect.any(AbortSignal), ['c4']);
  expect(session.getSnapshot()).toMatchObject({ canUndo: true }); expect(session.getSnapshot().document.parameters.n).toBe(4);
  expect(relationIds(session.getSnapshot().document)?.filter(id => !id.startsWith('g-poly_'))).toEqual(['poly']);
  await act(async () => session.undo()); expect(session.getSnapshot().document).toEqual(before.document); expect(session.getSnapshot().canUndo).toBe(false);
  // Cancel drops the question with the change, and the part keeps the relation.
  await act(async () => root.render(<></>)); await act(async () => root.render(<Harness />)); await changeLength('4'); await answer();
  expect(asked()).toMatch(prompt);
  const cancel = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel'); if (!cancel) throw new Error('Missing Cancel');
  await act(async () => cancel.click());
  expect(cancelled).toHaveBeenCalledTimes(1); expect(onApply).toHaveBeenCalledTimes(1); expect(relationIds(session.getSnapshot().document)).toEqual(relationIds(before.document));
  // Opened with a dragged Length and no preview, Apply's refusal asks in the same words, and the next Apply confirms it.
  await act(async () => root.render(<></>)); await act(async () => root.render(<Harness previewing={false} opening={{ n: 4 }} />));
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Length mm"]')?.value).toBe('4');
  const version = session.getSnapshot().version;
  await act(async () => apply().click());
  expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(onApply).toHaveBeenLastCalledWith(expect.anything(), { n: 4 }, expect.any(AbortSignal)); expect(session.getSnapshot().version).toBe(version);
  await act(async () => apply().click());
  expect(onApply).toHaveBeenLastCalledWith(expect.anything(), { n: 4 }, expect.any(AbortSignal), ['c4']);
  expect(session.getSnapshot().document.parameters.n).toBe(4); expect(relationIds(session.getSnapshot().document)?.includes('c4')).toBe(false);
});
