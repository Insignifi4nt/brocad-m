import { describe, expect, it } from 'vitest';
import type { CadBuildResult, CadDocument, CadFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { CadError } from '../cadError';
import type { CadBodyKey } from '../cadBodies';
import { cadBlockedFeatures, cadIssueRootCauses, preparedCadIssueRepair, type CadIssue, type CadIssueRepair } from '../cadIssues';
import { CAD_INPUT_BLOCKED, cadBuildIssues } from '../cadBuildIssues';

const base = (id: string, suppressed = false) => ({ id, name: `${id} feature`, suppressed });
const sketch = (id: string, x = 0, width = 40): CadFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset: 0,
  profiles: [{ id: `${id}_profile`, name: 'Profile', construction: false, geometry: { kind: 'rectangle', x, y: 0, width, height: 20, cornerRadius: 0 } }] });
const pad = (id: string, sketchId: string, operation: 'new' | 'join' | 'cut' = 'new', targetId: string | null = null, suppressed = false): CadFeature =>
  ({ ...base(id, suppressed), kind: 'extrude', sketchId, distance: 10, symmetric: false, operation, targetId });
const fillet = (id: string, targetId: string, suppressed = false): CadFeature => ({ ...base(id, suppressed), kind: 'fillet', targetId, radius: 1 });
const document = (features: readonly CadFeature[]): CadDocument => parseCadDocument({ ...createCadDocument('Issues'), features });
const stopped = (featureId: string) => ({ code: 'rebuild-stopped', featureId, message: 'Rebuild stopped here. The preview shows the preceding valid features; downstream features have not been evaluated.' });
const failed = (featureId: string, code = 'kernel-operation-failed', message = 'The fillet could not be applied.') => ({ code, featureId, message });
const build = (diagnostics: CadBuildResult['diagnostics'], bodyIssues: CadBuildResult['bodyIssues'] = []) => ({ diagnostics, bodyIssues });
const summary = (issue: CadIssue) => ({ key: issue.key, namespace: issue.namespace, code: issue.code, severity: issue.severity, state: issue.state, subject: issue.subject, causes: issue.causes });

// A box, a peg beside it, a fillet of the box, the peg joined to the filleted box, a fillet of the peg, and a second box with its own fillet.
const history = [sketch('box_sketch'), pad('box', 'box_sketch'), sketch('peg_sketch', 60, 10), pad('peg', 'peg_sketch'), fillet('round', 'box'),
  sketch('rib_sketch', 0, 4), pad('rib', 'rib_sketch', 'join', 'round'), fillet('peg_round', 'peg'), sketch('other_sketch', 100), pad('other', 'other_sketch'), fillet('other_round', 'other')];

describe('causal blocking', () => {
  it('blocks the later features that read a failed feature, through a slot or the body it changes, and leaves the others', () => {
    const parsed = document(history);
    // The rib joins the fillet's body by its target slot; nothing else reads the fillet.
    expect(cadBlockedFeatures(parsed, 'round')).toEqual([{ featureId: 'rib', by: 'round' }]);
    // The box's body is the one the fillet changes: the fillet reads it by slot, and the rib through the fillet it blocks.
    expect(cadBlockedFeatures(parsed, 'box')).toEqual([{ featureId: 'round', by: 'box' }, { featureId: 'rib', by: 'round' }]);
    // A failed sketch blocks its pad, and through the pad's body everything that changes it.
    expect(cadBlockedFeatures(parsed, 'other_sketch')).toEqual([{ featureId: 'other', by: 'other_sketch' }, { featureId: 'other_round', by: 'other' }]);
    expect(cadBlockedFeatures(parsed, 'missing')).toEqual([]);
  });

  it('blocks no suppressed feature, and what reads one is left to the document check', () => {
    // The suppressed fillet passes the box on, so the later fillet names the box, which it reads whatever the suppressed one does.
    const parsed = document([sketch('box_sketch'), pad('box', 'box_sketch'), fillet('quiet', 'box', true), fillet('loud', 'box')]);
    expect(cadBlockedFeatures(parsed, 'box')).toEqual([{ featureId: 'loud', by: 'box' }]);
    expect(cadBlockedFeatures(parsed, 'box_sketch')).toEqual([{ featureId: 'box', by: 'box_sketch' }, { featureId: 'loud', by: 'box' }]);
  });
});

describe('build issues', () => {
  it('link the stop and every blocked feature to the failure they come from', () => {
    const parsed = document(history), issues = cadBuildIssues(parsed, build([failed('round'), stopped('round')]), 'v7');
    expect(issues.items.map(summary)).toEqual([
      { key: 'kernel:0:kernel-operation-failed', namespace: 'kernel', code: 'kernel-operation-failed', severity: 'error', state: 'failed', subject: { kind: 'feature', featureId: 'round' }, causes: [] },
      { key: 'kernel:1:rebuild-stopped', namespace: 'kernel', code: 'rebuild-stopped', severity: 'info', state: 'blocked', subject: { kind: 'feature', featureId: 'round' }, causes: ['kernel:0:kernel-operation-failed'] },
      { key: 'feature:blocked:rib', namespace: 'feature', code: 'input-blocked', severity: 'warning', state: 'blocked', subject: { kind: 'feature', featureId: 'rib' }, causes: ['kernel:0:kernel-operation-failed'] }
    ]);
    expect(issues.items[2]).toMatchObject({ message: CAD_INPUT_BLOCKED, details: { kind: 'blocked', by: 'round' } });
    expect(issues.byFeature.get('round')?.state).toBe('failed');
    expect(issues.byFeature.get('rib')?.state).toBe('blocked');
    expect(issues.byFeature.has('peg_round')).toBe(false);
  });

  it('chain a blocked feature to the blocked input it reads, back to the root failure', () => {
    const issues = cadBuildIssues(document(history), build([failed('box', 'empty-solid', 'The operation produced no solid.'), stopped('box')]), 'v7');
    const rib = issues.items.find(issue => issue.key === 'feature:blocked:rib')!;
    expect(rib.causes).toEqual(['feature:blocked:round']);
    expect(cadIssueRootCauses(issues.items, rib.key).map(issue => issue.key)).toEqual(['kernel:0:empty-solid']);
  });

  it('keep the kernel\'s message, step and input, and its own words only as a detail', () => {
    const diagnostic = { ...failed('round'), details: { operation: 'fillet' as const, input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' } };
    const [issue] = cadBuildIssues(document(history), build([diagnostic, stopped('round')]), 'v7').items;
    expect(issue).toMatchObject({ message: 'The fillet could not be applied.', subject: { kind: 'reference-slot', featureId: 'round', field: 'targetId', inputId: 'box' },
      details: { kind: 'kernel-failure', operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' } });
    // Without details, the step is the feature's own operation.
    expect(cadBuildIssues(document(history), build([failed('rib', 'cut-erased', 'Erased.')]), 'v7').items[0].details).toEqual({ kind: 'kernel-failure', operation: 'extrude', input: null, kernelMessage: null });
  });

  it('offer the feature\'s editor, and choosing its edges again for a failed selection, prepared at the build\'s version', () => {
    const [selection] = cadBuildIssues(document(history), build([failed('round', 'selection-count-mismatch', 'Expected 2 edges.')]), 'v7').items;
    expect(selection.repairs).toEqual([
      { id: 're-pick:round:selection', label: 'Choose edges again', preparedAt: 'v7', kind: 're-pick', featureId: 'round', field: 'selection' },
      { id: 'command:edit-feature:round', label: 'Edit feature', preparedAt: 'v7', kind: 'command', command: 'edit-feature', featureId: 'round' }]);
    const [sketched] = cadBuildIssues(document(history), build([failed('box_sketch', 'empty-sketch', 'Empty.')]), 'v7').items;
    expect(sketched.repairs.map(repair => repair.label)).toEqual(['Edit sketch']);
  });

  it('present every body issue with its body key, feature and cause', () => {
    const body = 'box' as CadBodyKey, issues = cadBuildIssues(document(history), build([], [
      { code: 'untracked-body-parts', featureId: 'round', body, pieces: [], reason: 'search-limit', message: 'Tracing the parts of body box after round takes more work than a rebuild allows.' },
      { code: 'lost-body-parts', featureId: 'rib', body, pieces: ['box/split(1)' as CadBodyKey], message: '1 piece of body box no longer exists.' }]), 'v7');
    expect(issues.items.map(issue => [issue.namespace, issue.code, issue.severity, issue.state, issue.subject, issue.details])).toEqual([
      ['body', 'untracked-body-parts', 'warning', 'failed', { kind: 'body', key: 'box', featureId: 'round' }, { kind: 'body', pieces: [], reason: 'search-limit' }],
      ['body', 'lost-body-parts', 'warning', 'failed', { kind: 'body', key: 'box', featureId: 'rib' }, { kind: 'body', pieces: ['box/split(1)'], reason: null }]]);
    expect(issues.byFeature.size).toBe(0);
  });

  it('are frozen as built', () => {
    const [issue] = cadBuildIssues(document(history), build([failed('round')]), 'v7').items;
    expect(Object.isFrozen(issue) && Object.isFrozen(issue.subject) && Object.isFrozen(issue.causes) && Object.isFrozen(issue.repairs[0])).toBe(true);
  });
});

describe('repairs', () => {
  const repair: CadIssueRepair = { id: 'remove:r1', label: 'Remove relation', preparedAt: 'v7', kind: 'edit', edits: [{ kind: 'remove-sketch-relation', sketchId: 's', relationId: 'r1' }] };
  it('apply at the version they were prepared against, and are refused at any other', () => {
    expect(preparedCadIssueRepair(repair, 'v7')).toBe(repair);
    expect(() => preparedCadIssueRepair(repair, 'v8')).toThrow(CadError);
    expect(() => preparedCadIssueRepair(repair, 'v8')).toThrow('prepared for an earlier version');
    try { preparedCadIssueRepair(repair, 'v8'); } catch (error) { expect((error as CadError).code).toBe('stale-repair'); }
  });
});
