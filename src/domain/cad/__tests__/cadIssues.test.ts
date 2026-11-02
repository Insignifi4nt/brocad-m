import { describe, expect, it } from 'vitest';
import type { CadBuildResult, CadDocument, CadFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { CadError } from '../cadError';
import type { CadBodyKey } from '../cadBodies';
import { CAD_ISSUE_DIGEST_NAMED, cadBlockedFeatures, cadIssueDigest, cadIssueListProblems, cadIssueRootCauses, createCadIssue, createCadIssueList, preparedCadIssueRepair,
  type CadIssue, type CadIssueRepair } from '../cadIssues';
import { CAD_INPUT_BLOCKED, cadBuildIssues } from '../cadBuildIssues';

const base = (id: string, suppressed = false) => ({ id, name: `${id} feature`, suppressed });
const sketch = (id: string, x = 0, width = 40): CadFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset: 0,
  profiles: [{ id: `${id}_profile`, name: 'Profile', construction: false, geometry: { kind: 'rectangle', x, y: 0, width, height: 20, cornerRadius: 0 } }] });
const pad = (id: string, sketchId: string, operation: 'new' | 'join' | 'cut' = 'new', targetId: string | null = null, suppressed = false): CadFeature =>
  ({ ...base(id, suppressed), kind: 'extrude', sketchId, distance: 10, symmetric: false, operation, targetId });
const fillet = (id: string, targetId: string, suppressed = false): CadFeature => ({ ...base(id, suppressed), kind: 'fillet', targetId, radius: 1 });
const join = (id: string, targetId: string, toolId: string): CadFeature => ({ ...base(id), kind: 'boolean', targetId, toolId, operation: 'union' });
const document = (features: readonly CadFeature[]): CadDocument => parseCadDocument({ ...createCadDocument('Issues'), features });
const stopped = (featureId: string) => ({ code: 'rebuild-stopped', featureId, message: 'Rebuild stopped here. The preview shows the preceding valid features; downstream features have not been evaluated.' });
const failed = (featureId: string, code = 'kernel-operation-failed', message = 'The fillet could not be applied.') => ({ code, featureId, message });
const build = (diagnostics: CadBuildResult['diagnostics'], bodyIssues: CadBuildResult['bodyIssues'] = []) => ({ diagnostics, bodyIssues });
const summary = (issue: CadIssue) => ({ key: issue.key, namespace: issue.namespace, code: issue.code, severity: issue.severity, state: issue.state, subject: issue.subject, causes: issue.causes });
const keys = (issues: readonly CadIssue[]) => issues.map(issue => issue.key);
// A pad and a chain of fillets, each rounding the last: one failure of the pad blocks every fillet.
const chained = (count: number) => document([sketch('s'), pad('p', 's'), ...Array.from({ length: count }, (_, at) => fillet(`f${at}`, at ? `f${at - 1}` : 'p'))]);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// A box, a peg beside it, a fillet of the box, the peg joined to the filleted box, a fillet of the peg, and a second box with its own fillet.
const history = [sketch('box_sketch'), pad('box', 'box_sketch'), sketch('peg_sketch', 60, 10), pad('peg', 'peg_sketch'), fillet('round', 'box'),
  sketch('rib_sketch', 0, 4), pad('rib', 'rib_sketch', 'join', 'round'), fillet('peg_round', 'peg'), sketch('other_sketch', 100), pad('other', 'other_sketch'), fillet('other_round', 'other')];

describe('causal blocking', () => {
  it('blocks the later features that read a failed feature, through a slot or the body it changes, and leaves the others', () => {
    const parsed = document(history);
    // The rib joins the fillet's body by its target slot; nothing else reads the fillet.
    expect(cadBlockedFeatures(parsed, ['round'])).toEqual([{ featureId: 'rib', inputs: ['round'] }]);
    // The box's body is the one the fillet changes: the fillet reads it by slot, and the rib through the fillet it blocks.
    expect(cadBlockedFeatures(parsed, ['box'])).toEqual([{ featureId: 'round', inputs: ['box'] }, { featureId: 'rib', inputs: ['round'] }]);
    // A failed sketch blocks its pad, and through the pad's body everything that changes it.
    expect(cadBlockedFeatures(parsed, ['other_sketch'])).toEqual([{ featureId: 'other', inputs: ['other_sketch'] }, { featureId: 'other_round', inputs: ['other'] }]);
    expect(cadBlockedFeatures(parsed, ['missing'])).toEqual([]);
  });

  it('blocks no suppressed feature, and what reads one is left to the document check', () => {
    // The suppressed fillet passes the box on, so the later fillet names the box, which it reads whatever the suppressed one does.
    const parsed = document([sketch('box_sketch'), pad('box', 'box_sketch'), fillet('quiet', 'box', true), fillet('loud', 'box')]);
    expect(cadBlockedFeatures(parsed, ['box'])).toEqual([{ featureId: 'loud', inputs: ['box'] }]);
    expect(cadBlockedFeatures(parsed, ['box_sketch'])).toEqual([{ featureId: 'box', inputs: ['box_sketch'] }, { featureId: 'loud', inputs: ['box'] }]);
  });

  it('lists every failed or blocked input a feature reads, in history order, and a failed feature that reads one', () => {
    const parsed = document([sketch('a_sketch'), pad('a', 'a_sketch'), sketch('b_sketch', 60, 10), pad('b', 'b_sketch'), join('merge', 'b', 'a')]);
    expect(cadBlockedFeatures(parsed, ['a', 'b'])).toEqual([{ featureId: 'merge', inputs: ['a', 'b'] }]);
    expect(cadBlockedFeatures(parsed, ['a_sketch', 'a'])).toEqual([{ featureId: 'a', inputs: ['a_sketch'] }, { featureId: 'merge', inputs: ['a'] }]);
  });
});

describe('build issues', () => {
  it('link the stop and every blocked feature to the failure they come from', () => {
    const parsed = document(history), issues = cadBuildIssues(parsed, build([failed('round'), stopped('round')]), 'v7', true);
    expect(issues.items.map(summary)).toEqual([
      { key: 'kernel:0:kernel-operation-failed', namespace: 'kernel', code: 'kernel-operation-failed', severity: 'error', state: 'failed', subject: { kind: 'feature', featureId: 'round' }, causes: [] },
      { key: 'kernel:1:rebuild-stopped', namespace: 'kernel', code: 'rebuild-stopped', severity: 'info', state: 'blocked', subject: { kind: 'feature', featureId: 'round' }, causes: ['kernel:0:kernel-operation-failed'] },
      { key: 'feature:blocked:rib', namespace: 'feature', code: 'input-blocked', severity: 'warning', state: 'blocked', subject: { kind: 'feature', featureId: 'rib' }, causes: ['kernel:0:kernel-operation-failed'] }
    ]);
    expect(issues.items[2]).toMatchObject({ message: CAD_INPUT_BLOCKED, details: { inputs: ['round'] } });
    expect(issues.byFeature.get('round')?.state).toBe('failed');
    expect(issues.byFeature.get('rib')?.state).toBe('blocked');
    expect(issues.byFeature.has('peg_round')).toBe(false);
  });

  it('chain a blocked feature to the blocked input it reads, back to the root failure', () => {
    const issues = cadBuildIssues(document(history), build([failed('box', 'empty-solid', 'The operation produced no solid.'), stopped('box')]), 'v7', true);
    const rib = issues.items.find(issue => issue.key === 'feature:blocked:rib')!;
    expect(rib.causes).toEqual(['feature:blocked:round']);
    expect(keys(cadIssueRootCauses(issues.items, rib.key).roots)).toEqual(['kernel:0:empty-solid']);
  });

  it('link what reads a feature that failed on its own to that failure, which lists its own failed input as a cause too', () => {
    // A sketch, its pad and a fillet of the pad, where the sketch and the pad both fail.
    const chain = document([sketch('s'), pad('p', 's'), fillet('f', 'p')]);
    const issues = cadBuildIssues(chain, build([failed('s', 'empty-sketch', 'Empty.'), failed('p', 'empty-solid', 'No solid.')]), 'v7', true);
    expect(issues.items.map(summary)).toEqual([
      { key: 'kernel:0:empty-sketch', namespace: 'kernel', code: 'empty-sketch', severity: 'error', state: 'failed', subject: { kind: 'feature', featureId: 's' }, causes: [] },
      // The pad is reported once, as its own failure, and names the sketch's failure as a cause.
      { key: 'kernel:1:empty-solid', namespace: 'kernel', code: 'empty-solid', severity: 'error', state: 'failed', subject: { kind: 'feature', featureId: 'p' }, causes: ['kernel:0:empty-sketch'] },
      { key: 'feature:blocked:f', namespace: 'feature', code: 'input-blocked', severity: 'warning', state: 'blocked', subject: { kind: 'feature', featureId: 'f' }, causes: ['kernel:1:empty-solid'] }
    ]);
    expect(cadIssueListProblems(issues.items)).toEqual([]);
    expect(keys(cadIssueRootCauses(issues.items, 'feature:blocked:f').roots)).toEqual(['kernel:0:empty-sketch']);
  });

  it('link a feature that reads several failed inputs to every one of them', () => {
    const parsed = document([sketch('a_sketch'), pad('a', 'a_sketch'), sketch('b_sketch', 60, 10), pad('b', 'b_sketch'), join('merge', 'b', 'a'), fillet('round', 'merge')]);
    const issues = cadBuildIssues(parsed, build([failed('a', 'empty-solid', 'No solid.'), failed('b', 'invalid-solid', 'Invalid.')]), 'v7', true);
    const merge = issues.byFeature.get('merge')!;
    expect(merge).toMatchObject({ code: 'input-blocked', causes: ['kernel:0:empty-solid', 'kernel:1:invalid-solid'], details: { inputs: ['a', 'b'] } });
    expect(keys(cadIssueRootCauses(issues.items, 'feature:blocked:round').roots)).toEqual(['kernel:0:empty-solid', 'kernel:1:invalid-solid']);
    expect(cadIssueListProblems(issues.items)).toEqual([]);
  });

  it('keep the kernel\'s message, step and input, and its own words only as a detail', () => {
    const diagnostic = { ...failed('round'), details: { operation: 'fillet' as const, input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' } };
    const [issue] = cadBuildIssues(document(history), build([diagnostic, stopped('round')]), 'v7', true).items;
    expect(issue).toMatchObject({ message: 'The fillet could not be applied.', subject: { kind: 'reference-slot', featureId: 'round', field: 'targetId', inputId: 'box' },
      details: { operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' } });
    // Without details, the step is the feature's own operation.
    expect(cadBuildIssues(document(history), build([failed('rib', 'cut-erased', 'Erased.')]), 'v7', true).items[0].details).toEqual({ operation: 'extrude', input: null, kernelMessage: null });
  });

  it('report a code no registry lists as kernel-unrecognised, keeping the code it gave', () => {
    const [issue] = cadBuildIssues(document(history), build([failed('round', 'new-dynamic-refusal', 'Failed.'), stopped('round')]), 'v7', true).items;
    expect(issue).toMatchObject({ key: 'kernel:0:kernel-unrecognised', namespace: 'kernel', code: 'kernel-unrecognised', state: 'failed', message: 'Failed.',
      details: { operation: 'fillet', input: null, kernelMessage: null, refusalCode: 'new-dynamic-refusal' } });
    expect(issue.repairs.map(repair => repair.label)).toEqual(['Edit feature']);
  });

  it('carry the facts a code gives, narrowed by its code', () => {
    const [issue] = cadBuildIssues(document(history), build([{ ...failed('round', 'selection-count-mismatch', 'Matched 3, requires 2.'), facts: { expected: 2, actual: 3 } }]), 'v7', true).items;
    if (issue.namespace !== 'kernel' || issue.code !== 'selection-count-mismatch') throw new Error('Expected a count mismatch.');
    // The code narrows the details to its facts; no message is read for them.
    const counts: { readonly expected: number; readonly actual: number } = issue.details;
    expect(counts).toEqual({ operation: 'fillet', input: null, kernelMessage: null, expected: 2, actual: 3 });
    expect(() => cadBuildIssues(document(history), build([failed('round', 'selection-count-mismatch', 'Matched 3.')]), 'v7', true)).toThrow('gives no facts');
  });

  it('offer the feature\'s editor, and choosing its edges again for a failed selection, prepared at the build\'s version', () => {
    const [selection] = cadBuildIssues(document(history), build([{ ...failed('round', 'selection-count-mismatch', 'Expected 2 edges.'), facts: { expected: 2, actual: 1 } }]), 'v7', true).items;
    expect(selection.repairs).toEqual([
      { id: 're-pick:round:selection', label: 'Choose edges again', preparedAt: 'v7', kind: 're-pick', featureId: 'round', field: 'selection' },
      { id: 'command:edit-feature:round', label: 'Edit feature', preparedAt: 'v7', kind: 'command', command: 'edit-feature', featureId: 'round' }]);
    const [sketched] = cadBuildIssues(document(history), build([failed('box_sketch', 'empty-sketch', 'Empty.')]), 'v7', true).items;
    expect(sketched.repairs.map(repair => repair.label)).toEqual(['Edit sketch']);
  });

  it('present every body issue with its body key, feature and the facts of its code', () => {
    const body = 'box' as CadBodyKey, issues = cadBuildIssues(document(history), build([], [
      { code: 'untracked-body-parts', featureId: 'round', body, pieces: [], reason: 'search-limit', message: 'Tracing the parts of body box after round takes more work than a rebuild allows.' },
      { code: 'lost-body-parts', featureId: 'rib', body, pieces: ['box/split(1)' as CadBodyKey], message: '1 piece of body box no longer exists.' },
      { code: 'more-body-issues', featureId: 'rib', body, pieces: [], omitted: 3, message: '3 more body issues, from feature rib on, are not listed.' }]), 'v7', true);
    expect(issues.items.map(issue => [issue.namespace, issue.code, issue.severity, issue.state, issue.subject, issue.details])).toEqual([
      ['body', 'untracked-body-parts', 'warning', 'failed', { kind: 'body', key: 'box', featureId: 'round' }, { reason: 'search-limit' }],
      ['body', 'lost-body-parts', 'warning', 'failed', { kind: 'body', key: 'box', featureId: 'rib' }, { pieces: ['box/split(1)'] }],
      ['body', 'more-body-issues', 'warning', 'failed', { kind: 'body', key: 'box', featureId: 'rib' }, { omittedCount: 3 }]]);
    expect(issues.byFeature.size).toBe(0);
  });

  it('are frozen as built', () => {
    const [issue] = cadBuildIssues(document(history), build([failed('round')]), 'v7', true).items;
    expect(Object.isFrozen(issue) && Object.isFrozen(issue.subject) && Object.isFrozen(issue.causes) && Object.isFrozen(issue.repairs[0])).toBe(true);
  });
});

describe('issue codes and details', () => {
  const common = { key: 'k', severity: 'warning', message: 'm', causes: [], repairs: [] } as const;
  it('tie each code to its details, subject and state', () => {
    const lost: CadIssue = { ...common, namespace: 'body', code: 'lost-body-parts', state: 'failed', subject: { kind: 'body', key: 'box' as CadBodyKey, featureId: 'f' }, details: { pieces: [] } };
    expect(lost.code).toBe('lost-body-parts');
    // @ts-expect-error A lost-parts issue carries pieces, not an untracked reason, about a body, and is never blocked.
    const contradictory: CadIssue = { ...common, namespace: 'body', code: 'lost-body-parts', state: 'blocked', subject: { kind: 'document' }, details: { reason: 'part-limit' } };
    // @ts-expect-error A code missing from its namespace's registry is no issue.
    const unknown: CadIssue = { ...common, namespace: 'kernel', code: 'no-such-code', state: 'failed', subject: { kind: 'document' }, details: { operation: 'check', input: null, kernelMessage: null } };
    // @ts-expect-error A count mismatch carries its counts.
    const countless: CadIssue = { ...common, namespace: 'kernel', code: 'selection-count-mismatch', state: 'failed', subject: { kind: 'document' }, details: { operation: 'check', input: null, kernelMessage: null } };
    // @ts-expect-error The kernel's own words are its only free text; a failure has no other text field.
    const worded: CadIssue = { ...common, namespace: 'kernel', code: 'empty-solid', state: 'failed', subject: { kind: 'document' }, details: { operation: 'check', input: null, kernelMessage: null, note: 'x' } };
    expect([contradictory, unknown, countless, worded]).toHaveLength(4);
  });

  it('give a feature issue the facts of a code that carries them, so reading them by code alone never gives undefined', () => {
    const feature = { ...common, namespace: 'feature', severity: 'error', state: 'failed', subject: { kind: 'feature', featureId: 'p' } } as const;
    // @ts-expect-error A feature issue with a count mismatch carries its counts too.
    const factless: CadIssue = { ...feature, code: 'selection-count-mismatch', details: {} };
    // @ts-expect-error Only a build reports a code no registry lists, so no feature issue has it.
    const unrecognised: CadIssue = { ...feature, code: 'kernel-unrecognised', details: { refusalCode: 'x' } };
    const counted = createCadIssue<CadIssue>({ ...feature, code: 'selection-count-mismatch', details: { expected: 2, actual: 3 } });
    // The code narrows every namespace that has it to its facts.
    const actual = (issue: CadIssue): number | null => issue.code === 'selection-count-mismatch' ? issue.details.actual : null;
    expect(actual(counted)).toBe(3);
    // @ts-expect-error A code that carries no facts has no details to read: its details have no index signature.
    const nothing = (issue: CadIssue) => issue.namespace === 'feature' && issue.code !== 'input-blocked' && issue.code !== 'selection-count-mismatch' && issue.code !== 'selection-empty' ? issue.details.actual : null;
    expect([factless, unrecognised, nothing]).toHaveLength(3);
  });
});

describe('issue lists', () => {
  const issue = (key: string, causes: readonly string[] = [], state: 'failed' | 'blocked' = causes.length ? 'blocked' : 'failed'): CadIssue => state === 'failed'
    ? { key, namespace: 'kernel', code: 'empty-solid', severity: 'error', state, subject: { kind: 'feature', featureId: key }, message: 'm', causes, repairs: [], details: { operation: 'check', input: null, kernelMessage: null } }
    : { key, namespace: 'feature', code: 'input-blocked', severity: 'warning', state, subject: { kind: 'feature', featureId: key }, message: 'm', causes, repairs: [], details: { inputs: [] } };
  it('are one causal graph: unique keys, causes in the list, a cause for each blocked issue and no cycle', () => {
    expect(cadIssueListProblems([issue('a'), issue('b', ['a']), issue('c', ['a', 'b'])])).toEqual([]);
    expect(cadIssueListProblems([issue('a'), issue('a')])).toEqual(['Issue key a is repeated.']);
    expect(cadIssueListProblems([issue('b', ['a'])])).toEqual(['Issue b names missing issue a as a cause.']);
    expect(cadIssueListProblems([issue('a', ['a'])])).toEqual(['Issue a names itself as a cause.']);
    expect(cadIssueListProblems([issue('a', [], 'blocked')])).toEqual(['Blocked issue a names no cause.']);
    expect(cadIssueListProblems([issue('a'), issue('b', ['a', 'a'])])).toEqual(['Issue b names a cause twice.']);
    expect(cadIssueListProblems([issue('a', ['b']), issue('b', ['a'])])).toEqual(['The causes of issue a lead back to it.']);
  });
  it('throw when one is made malformed in development and tests', () => {
    expect(createCadIssueList([issue('a'), issue('b', ['a'])], true)).toHaveLength(2);
    expect(() => createCadIssueList([issue('a', ['b']), issue('b', ['a'])], true)).toThrow('Malformed CAD issue list: The causes of issue a lead back to it.');
    expect(() => createCadIssueList([issue('b', ['a'])], true)).toThrow('names missing issue a');
  });

  it('name in production the issues whose causes resolve to no root, rather than fail or drop them', () => {
    // A root, a cycle, an issue reading the cycle, a self link, a missing cause, a blocked issue naming none, and one reading the root and the cycle.
    const list = createCadIssueList([issue('root'), issue('a', ['b']), issue('b', ['a']), issue('c', ['b']), issue('self', ['self']), issue('lost', ['gone']),
      issue('bare', [], 'blocked'), issue('mixed', ['root', 'a'])], false);
    expect(list).toHaveLength(8);
    const digest = cadIssueDigest(list);
    expect(digest.unresolved.count).toBe(7);
    expect(digest.unresolved.issues.map(({ key, causes }) => ({ key, causes }))).toEqual([{ key: 'a', causes: ['a', 'b'] }, { key: 'b', causes: ['a', 'b'] },
      { key: 'c', causes: ['a', 'b'] }, { key: 'self', causes: ['self'] }, { key: 'lost', causes: ['gone'] }, { key: 'bare', causes: ['bare'] }, { key: 'mixed', causes: ['a', 'b'] }]);
    expect(digest.unresolved.issues[0].subject).toEqual({ kind: 'feature', featureId: 'a' });
    expect([keys(digest.issues), digest.blocked, digest.omittedCount]).toEqual([['root'], [{ cause: 'root', count: 1, featureIds: ['mixed'] }], 0]);
    expect(cadIssueRootCauses(list, 'mixed')).toEqual({ roots: [list[0]], unresolved: ['a', 'b'] });
    expect(cadIssueRootCauses(list, 'nowhere')).toEqual({ roots: [], unresolved: ['nowhere'] });
  });

  it('count in production every issue of a long cycle and name the first, with a bounded digest', () => {
    const length = 6000, list = createCadIssueList(Array.from({ length }, (_, at) => issue(`c${at}`, [`c${(at + 1) % length}`])), false);
    const digest = cadIssueDigest(list);
    expect([digest.unresolved.count, digest.unresolved.issues.length, digest.omittedCount]).toEqual([length, CAD_ISSUE_DIGEST_NAMED, length - CAD_ISSUE_DIGEST_NAMED]);
    expect(digest.unresolved.issues[0].causes).toEqual(Array.from({ length: CAD_ISSUE_DIGEST_NAMED }, (_, at) => `c${at}`));
    expect(bytes(digest)).toBeLessThan(2048);
    expect(cadIssueListProblems(list)).toEqual(['The causes of issue c0 lead back to it.']);
  });
});

describe('long histories', () => {
  // A pad and 6,000 fillets, each rounding the last: the pad fails, and an early fillet and the last fail on their own as well.
  const long = () => [chained(6000), build([failed('p', 'empty-solid', 'No solid.'), failed('f10'), failed('f5999')])] as const;
  const first = Array.from({ length: CAD_ISSUE_DIGEST_NAMED }, (_, at) => `f${at}`);

  it('build, check and digest in development without recursion, whatever order the list is in', () => {
    const { items } = cadBuildIssues(...long(), 'v7', true);
    expect(items).toHaveLength(6001);
    expect(keys(cadIssueRootCauses(items, 'kernel:2:kernel-operation-failed').roots)).toEqual(['kernel:0:empty-solid']);
    const digest = cadIssueDigest(items);
    expect(digest.issues.map(({ key, causes }) => ({ key, causes }))).toEqual([{ key: 'kernel:0:empty-solid', causes: [] },
      { key: 'kernel:1:kernel-operation-failed', causes: ['kernel:0:empty-solid'] }, { key: 'kernel:2:kernel-operation-failed', causes: ['kernel:0:empty-solid'] }]);
    expect([digest.blocked, digest.unresolved, digest.omittedCount]).toEqual([[{ cause: 'kernel:0:empty-solid', count: 5998, featureIds: first }], { count: 0, issues: [] }, 5990]);
    // Reversed, the longest chain is entered first.
    const reversed = [...items].reverse();
    expect(cadIssueListProblems(reversed)).toEqual([]);
    expect(createCadIssueList(reversed, true)).toHaveLength(6001);
    expect(cadIssueDigest(reversed)).toMatchObject({ blocked: [{ cause: 'kernel:0:empty-solid', count: 5998 }], unresolved: { count: 0 }, omittedCount: 5990 });
  });

  it('build and digest in production the same way', () => {
    const { items } = cadBuildIssues(...long(), 'v7', false);
    expect(items).toHaveLength(6001);
    expect(cadIssueDigest([...items].reverse())).toMatchObject({ blocked: [{ cause: 'kernel:0:empty-solid', count: 5998 }], unresolved: { count: 0 }, omittedCount: 5990 });
  });
});

describe('issue digest', () => {
  it('gives the failures in full and the features they block by count, with a reply that does not grow with them', () => {
    const issues = cadBuildIssues(chained(1200), build([failed('p', 'empty-solid', 'The pad produced no solid.'), stopped('p')]), 'v7', true).items;
    const digest = cadIssueDigest(issues);
    expect(issues).toHaveLength(1202);
    expect(keys(digest.issues)).toEqual(['kernel:0:empty-solid', 'kernel:1:rebuild-stopped']);
    expect(digest.blocked).toEqual([{ cause: 'kernel:0:empty-solid', count: 1200, featureIds: Array.from({ length: CAD_ISSUE_DIGEST_NAMED }, (_, at) => `f${at}`) }]);
    expect(digest.omittedCount).toBe(1200 - CAD_ISSUE_DIGEST_NAMED);
    // Measured: the full list is 373,121 bytes of JSON, and the digest 947 however long the chain.
    expect([bytes(issues) > 360_000, bytes(digest) < 1024]).toEqual([true, true]);
    // A chain of 1,500 fillets gives the same digest but for its counts, which have as many digits.
    expect(bytes(cadIssueDigest(cadBuildIssues(chained(1500), build([failed('p', 'empty-solid', 'The pad produced no solid.'), stopped('p')]), 'v7', true).items))).toBe(bytes(digest));
  });
  it('names under each root the blocked features that lead back to it, and links each issue it keeps only to issues it keeps', () => {
    const parsed = document([sketch('a_sketch'), pad('a', 'a_sketch'), sketch('b_sketch', 60, 10), pad('b', 'b_sketch'), join('merge', 'b', 'a'), fillet('round', 'merge'), fillet('late', 'round')]);
    // The fillet fails on its own as well as reading the blocked join, so it is kept in full, linked to the roots it leads back to.
    const issues = cadBuildIssues(parsed, build([failed('a', 'empty-solid', 'No solid.'), failed('b', 'invalid-solid', 'Invalid.'), failed('round')]), 'v7', true).items;
    const digest = cadIssueDigest(issues, 1);
    expect(digest.issues.map(summary).map(({ key, causes }) => ({ key, causes }))).toEqual([
      { key: 'kernel:0:empty-solid', causes: [] }, { key: 'kernel:1:invalid-solid', causes: [] },
      { key: 'kernel:2:kernel-operation-failed', causes: ['kernel:0:empty-solid', 'kernel:1:invalid-solid'] }]);
    expect(digest.blocked).toEqual([
      { cause: 'kernel:0:empty-solid', count: 2, featureIds: ['merge'] }, { cause: 'kernel:1:invalid-solid', count: 2, featureIds: ['merge'] }]);
    expect(digest.omittedCount).toBe(1);
    const kept = new Set(keys(digest.issues));
    expect([...digest.issues.flatMap(issue => issue.causes), ...digest.blocked.map(entry => entry.cause)].every(cause => kept.has(cause))).toBe(true);
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

  it('keep the operation they were prepared with, whatever later happens to what built them', () => {
    const pointIds = ['p1'], edit = { kind: 'delete-sketch-elements' as const, sketchId: 's', pointIds, entityIds: [], relationIds: [], cascade: false }, edits = [edit];
    const pieces = ['box/split(0)' as CadBodyKey];
    const issue = createCadIssue<CadIssue>({ key: 'k', namespace: 'body', code: 'lost-body-parts', severity: 'warning', state: 'failed', subject: { kind: 'body', key: 'box' as CadBodyKey, featureId: 'f' },
      message: 'm', causes: [], details: { pieces }, repairs: [{ id: 'delete', label: 'Delete', preparedAt: 'v7', kind: 'edit', edits }] });
    edits.push({ ...edit, sketchId: 'other' }); pointIds.push('p2'); edit.sketchId = 'moved'; pieces.push('box/split(1)' as CadBodyKey);
    const prepared = preparedCadIssueRepair(issue.repairs[0], 'v7');
    expect(prepared).toEqual({ id: 'delete', label: 'Delete', preparedAt: 'v7', kind: 'edit', edits: [{ kind: 'delete-sketch-elements', sketchId: 's', pointIds: ['p1'], entityIds: [], relationIds: [], cascade: false }] });
    expect(issue.details).toEqual({ pieces: ['box/split(0)'] });
    expect(prepared.kind === 'edit' && Object.isFrozen(prepared.edits[0]) && Object.isFrozen((prepared.edits[0] as typeof edit).pointIds)).toBe(true);
  });
});
