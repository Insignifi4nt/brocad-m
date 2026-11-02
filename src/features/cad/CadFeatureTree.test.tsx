import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadDocument } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { CAD_INPUT_BLOCKED, cadBuildIssues } from '@/domain/cad/cadBuildIssues';
import { CadFeatureTree, type CadFeatureTreeProps } from './CadFeatureTree';
import { CadParametersPanel } from './CadParametersPanel';

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sample = (): CadDocument => parseCadDocument({ ...createCadDocument('Bracket'), features: [
  { id: 'plane', name: 'Mounting plane', kind: 'datum-plane', suppressed: false, definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, 0], rotation: [0, 0, 0] } },
  { id: 'sketch', name: 'Outline', kind: 'sketch', suppressed: false, plane: { kind: 'datum-plane', featureId: 'plane' }, offset: 0,
    profiles: [{ id: 'rectangle', name: 'Boundary', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] },
  { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null },
  { id: 'move', name: 'Moved body', kind: 'transform', suppressed: false, sourceId: 'pad', translation: [5, 0, 0], rotation: [0, 0, 0] },
  { id: 'curve', name: 'Guide', kind: 'curve', suppressed: false, plane: 'XY', offset: 0, segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }] }
] });
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Button ${label} missing`); return found;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function menuAction(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label);
  if (!found) throw new Error(`Action ${label} missing`);
  await act(async () => found.click());
}
function renameInput(label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Input ${label} missing`);
  return input;
}
async function inputName(label: string, name: string) {
  const input = renameInput(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function props(overrides: Partial<CadFeatureTreeProps> = {}): CadFeatureTreeProps {
  return { document: sample(), selectedId: null, selectedProfileId: null, locked: false, onSelect: vi.fn(), onEditSketch: vi.fn(), onEditCurve: vi.fn(), onSelectProfile: vi.fn(), ...overrides };
}

describe('unified feature history and dependency tree', () => {
  it('opens real parameters within the specification tree and keeps their active editor owned', async () => {
    const cadDocument = parseCadDocument({ ...sample(), parameters: { width: 20 } });
    const callbacks = props({ document: cadDocument }), onEditMany = vi.fn();
    function Harness() {
      const [pending, setPending] = useState(false);
      return <CadFeatureTree {...callbacks} locked={pending} parameterContent={<CadParametersPanel document={cadDocument}
        onEditMany={onEditMany} onInspectParameter={() => undefined} onPendingChange={setPending} interactionLocked={false} cancelSignal={0} />} />;
    }
    await act(async () => root.render(<Harness />));
    expect(container.querySelector('[aria-label="Edit parameter width"]')?.closest('[hidden]')).not.toBeNull();
    await click('Expand Parameters');
    expect(button('Collapse Parameters').getAttribute('aria-expanded')).toBe('true');
    await act(async () => button('Edit parameter width').focus());
    await click('Edit parameter width');
    expect(document.querySelector('[role="dialog"][aria-label="Edit width"]')).not.toBeNull();
    expect(button('Collapse Parameters').disabled).toBe(true);
    await click('Collapse Parameters');
    expect(document.querySelector('[role="dialog"][aria-label="Edit width"]')).not.toBeNull();
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close parameter editor"]');
    if (!close) throw new Error('Missing parameter editor close action');
    await act(async () => close.click());
    expect(document.activeElement).toBe(button('Edit parameter width'));
    await click('Collapse Parameters');
    expect(container.querySelector('[aria-label="Edit parameter width"]')?.closest('[hidden]')).not.toBeNull();
    expect(onEditMany).not.toHaveBeenCalled();
    expect(callbacks.document).toBe(cadDocument);
  });
  it('organizes the real model under its part root and opens sketches from reference planes', async () => {
    const callbacks = props(), onCreateSketch = vi.fn();
    const original = JSON.stringify(callbacks.document);
    await act(async () => root.render(<CadFeatureTree {...callbacks} onCreateSketch={onCreateSketch} />));
    expect(button('Collapse part Bracket').getAttribute('aria-expanded')).toBe('true');
    await click('Collapse Body');
    expect(container.querySelector('[aria-label="Feature history and dependencies"]')).toBeNull();
    await click('Expand Body');
    expect(button('Select Pad in history')).toBeTruthy();
    await click('Expand Reference');
    await click('Create sketch on XZ plane');
    expect(onCreateSketch).toHaveBeenCalledExactlyOnceWith('XZ');
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(JSON.stringify(callbacks.document)).toBe(original);
    await click('Collapse part Bracket');
    expect(container.querySelector('[aria-label="Feature history and dependencies"]')).toBeNull();
    await click('Expand part Bracket');
    expect(button('Select Pad in history')).toBeTruthy();
    expect(button('Collapse Reference')).toBeTruthy();
  });
  it('reveals a newly selected feature through collapsed parent branches without editing the part', async () => {
    const callbacks = props();
    await act(async () => root.render(<CadFeatureTree {...callbacks} />));
    await click('Collapse Body');
    await act(async () => root.render(<CadFeatureTree {...callbacks} selectedId="pad" />));
    expect(button('Select Pad in history').getAttribute('aria-pressed')).toBe('true');
    await click('Collapse part Bracket');
    await act(async () => root.render(<CadFeatureTree {...callbacks} selectedId="move" />));
    expect(button('Select Moved body in history').getAttribute('aria-pressed')).toBe('true');
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
  it('renames the right-clicked feature without selecting it or changing its references', async () => {
    const callbacks = props({ selectedId: 'pad' }), onRename = vi.fn(), onPendingChange = vi.fn();
    await act(async () => root.render(<CadFeatureTree {...callbacks} onRename={onRename} onRenamePendingChange={onPendingChange} />));
    await act(async () => button('Select Outline in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    await menuAction('Rename feature');
    expect(document.activeElement).toBe(renameInput('Feature name'));
    expect(renameInput('Feature name').value).toBe('Outline');
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(button('Select Pad in history').disabled).toBe(true);
    await inputName('Feature name', '  Gear and bore  ');
    await click('Apply name');
    expect(onRename).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'sketch', name: 'Outline' }), 'Gear and bore', undefined, expect.any(AbortSignal));
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onEditSketch).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(button('Select Outline in history'));
  });
  it('renames a keyboard-targeted profile and cancels with focus restored to that profile', async () => {
    const callbacks = props({ selectedId: 'sketch', selectedProfileId: 'rectangle' }), onRename = vi.fn();
    await act(async () => root.render(<CadFeatureTree {...callbacks} onRename={onRename} />));
    await act(async () => button('Boundary profile').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    expect(document.activeElement).toBe(renameInput('Profile name'));
    await inputName('Profile name', 'Unaccepted name');
    await act(async () => renameInput('Profile name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Boundary profile'));
    await act(async () => button('Boundary profile').dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })));
    await menuAction('Rename profile');
    await inputName('Profile name', 'Shaft bore');
    await click('Apply name');
    expect(onRename).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'sketch' }), 'Shaft bore', 'rectangle', expect.any(AbortSignal));
    expect(callbacks.onSelectProfile).not.toHaveBeenCalled();
    expect(callbacks.onEditSketch).not.toHaveBeenCalled();
  });
  it('rejects invalid names and preserves the rename draft when the guarded edit fails', async () => {
    const callbacks = props(), original = JSON.stringify(callbacks.document);
    const onRename = vi.fn(() => { throw new Error('The part changed before this edit was accepted.'); });
    await act(async () => root.render(<CadFeatureTree {...callbacks} onRename={onRename} />));
    await act(async () => button('Select Guide in history').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    await inputName('Feature name', '  ');
    await click('Apply name');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a name of 1 to 160 characters.');
    expect(onRename).not.toHaveBeenCalled();
    await inputName('Feature name', 'Tool path');
    await click('Apply name');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The part changed before this edit was accepted.');
    expect(renameInput('Feature name').value).toBe('Tool path');
    expect(JSON.stringify(callbacks.document)).toBe(original);
    await click('Cancel rename');
    expect(document.activeElement).toBe(button('Select Guide in history'));
    await act(async () => button('Select Guide in history').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    await click('Apply name');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input')).toBeNull();
  });
  it('keeps an async rename draft on rejection and prevents a cancelled result from closing a new editor', async () => {
    let reject: (error: Error) => void = () => { throw new Error('No rename'); };
    let resolve: () => void = () => { throw new Error('No retry'); };
    const first = new Promise<void>((_accept, fail) => { reject = fail; });
    const retry = new Promise<void>(accept => { resolve = accept; });
    void first.catch(() => undefined);
    const onRename = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(retry);
    const callbacks = props({ onRename });
    await act(async () => root.render(<CadFeatureTree {...callbacks} />));
    await act(async () => button('Select Guide in history').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    await inputName('Feature name', 'Rail'); await click('Apply name');
    expect(renameInput('Feature name').value).toBe('Rail');
    await act(async () => reject(new Error('Relation preparation failed.')));
    expect(renameInput('Feature name').value).toBe('Rail');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Relation preparation failed.');
    await click('Apply name');
    const signal: unknown = onRename.mock.calls[1]?.[3];
    await click('Cancel rename');
    expect(signal instanceof AbortSignal && signal.aborted).toBe(true);
    await act(async () => button('Select Guide in history').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    await inputName('Feature name', 'New owner');
    await act(async () => resolve());
    expect(renameInput('Feature name').value).toBe('New owner');
  });
  it.each(['document', 'lock', 'reference picker', 'cancel'] as const)('cancels a stale rename when the %s owner changes', async ownership => {
    const callbacks = props({ selectedId: 'sketch' }), onRename = vi.fn(), onPendingChange = vi.fn();
    await act(async () => root.render(<CadFeatureTree {...callbacks} onRename={onRename} onRenamePendingChange={onPendingChange} cancelSignal={0} />));
    await act(async () => button('Boundary profile').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    await inputName('Profile name', 'Draft name');
    const changed = ownership === 'document' ? { document: parseCadDocument({ ...callbacks.document, name: 'A different revision' }) }
      : ownership === 'lock' ? { locked: true } : ownership === 'reference picker' ? { selectionOnly: true } : { cancelSignal: 1 };
    await act(async () => root.render(<CadFeatureTree {...callbacks} onRename={onRename} onRenamePendingChange={onPendingChange} cancelSignal={0} {...changed} />));
    expect(container.querySelector('input')).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    await act(async () => root.render(<CadFeatureTree {...callbacks} onRename={onRename} onRenamePendingChange={onPendingChange} cancelSignal={0} />));
    expect(container.querySelector('input')).toBeNull();
    expect(button('Boundary profile').textContent).toBe('Boundary');
  });
  it('picks feature references without opening editors or profile actions while an inspector owns selection', async () => {
    const callbacks = props({ selectedId: 'sketch' }), onSuppress = vi.fn();
    await act(async () => root.render(<CadFeatureTree {...callbacks} onSuppress={onSuppress} />));
    await act(async () => button('Select Outline in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => root.render(<CadFeatureTree {...callbacks} selectionOnly selectableFeatureIds={['sketch', 'curve']} onSuppress={onSuppress} />));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click('Select Outline in history');
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith('sketch');
    expect(button('Select Pad in history').disabled).toBe(true);
    expect(button('Select Mounting plane in history').disabled).toBe(true);
    await click('Select Pad in history');
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
    expect(button('Boundary profile').disabled).toBe(true);
    await click('Boundary profile');
    await act(async () => {
      button('Select Outline in history').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      button('Select Guide in history').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      button('Select Outline in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      button('Select Guide in history').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(callbacks.onEditSketch).not.toHaveBeenCalled();
    expect(callbacks.onEditCurve).not.toHaveBeenCalled();
    expect(callbacks.onSelectProfile).not.toHaveBeenCalled();
    expect(onSuppress).not.toHaveBeenCalled();
  });
  it('opens target-specific actions by right click and executes only the chosen current feature', async () => {
    const callbacks = props({ selectedId: 'pad' }), onSuppress = vi.fn();
    await act(async () => root.render(<CadFeatureTree {...callbacks} onSuppress={onSuppress} />));
    await act(async () => button('Select Outline in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 140 })));
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    const edit = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Edit sketch');
    if (!edit) throw Error('Missing sketch action');
    await act(async () => edit.click());
    expect(callbacks.onEditSketch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'sketch' }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => button('Select Pad in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 170 })));
    const suppress = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Suppress feature');
    if (!suppress) throw Error('Missing suppression action');
    await act(async () => suppress.click());
    expect(onSuppress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'pad' }), true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it('supports keyboard context menus and cancels stale targets or locked workflows without an action', async () => {
    const callbacks = props();
    await act(async () => root.render(<CadFeatureTree {...callbacks} />));
    await act(async () => button('Select Guide in history').focus());
    await act(async () => button('Select Guide in history').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button('Select Guide in history'));
    await act(async () => button('Select Guide in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    await act(async () => root.render(<CadFeatureTree {...callbacks} document={parseCadDocument({ ...callbacks.document, name: 'Changed' })} />));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(callbacks.onEditCurve).not.toHaveBeenCalled();
    await act(async () => root.render(<CadFeatureTree {...callbacks} locked />));
    await act(async () => button('Select Guide in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it('retains exact document order and history positions with independent disclosures', async () => {
    const callbacks = props(); await act(async () => root.render(<CadFeatureTree {...callbacks} />));
    const rows = () => [...container.querySelectorAll<HTMLElement>('[data-cad-feature-id]')].map(row => [row.dataset.cadFeatureId, row.dataset.cadHistoryPosition]);
    expect(rows()).toEqual([['plane', '1'], ['pad', '3'], ['move', '4'], ['curve', '5']]);
    await click('Expand Pad');
    expect(rows()).toEqual([['plane', '1'], ['pad', '3'], ['sketch', '2'], ['move', '4'], ['curve', '5']]);
    expect(button('Expand Outline').getAttribute('aria-expanded')).toBe('false');
    await click('Expand Outline');
    expect(button('Collapse Outline').getAttribute('aria-expanded')).toBe('true'); expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(button('Boundary profile')).toBeTruthy();
    await click('Collapse Outline'); expect(container.querySelector('[aria-label="Boundary profile"]')).toBeNull();
    await click('Select Outline in history'); expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith('sketch');
    expect(button('Select Outline in history').getAttribute('aria-description')).toBe('Sketch · Outline');
  });
  it('nests a consumed sketch under its first solid feature and links later consumers', async () => {
    const base = sample(), document = parseCadDocument({ ...base, features: [...base.features,
      { id: 'tall', name: 'Tall pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 9, symmetric: false, operation: 'new', targetId: null }] });
    const onSelect = vi.fn(), callbacks = props({ document, selectedId: 'sketch', onSelect });
    await act(async () => root.render(<CadFeatureTree {...callbacks} />));
    const definition = container.querySelector('[data-cad-feature-id="pad"] [aria-label="Pad definition"]');
    expect(definition?.querySelector('[data-cad-feature-id="sketch"]')).not.toBeNull();
    expect(container.querySelector('[data-cad-feature-id="move"]')?.parentElement?.getAttribute('aria-label')).toBe('Feature history and dependencies');
    expect(container.querySelectorAll('[aria-label="Select Outline in history"]')).toHaveLength(1);
    await click('Expand Tall pad'); await click('Select shared Outline');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('sketch');
    await act(async () => root.render(<CadFeatureTree {...callbacks} locked />));
    expect([...container.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    await click('Select shared Outline'); expect(onSelect).toHaveBeenCalledTimes(1);
    await click('Collapse Pad'); expect(button('Collapse Pad').getAttribute('aria-expanded')).toBe('true');
  });
  it('opens a selected feature once, lets it collapse independently and preserves other expanded branches', async () => {
    const callbacks = props();
    function Harness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <CadFeatureTree {...callbacks} selectedId={selectedId} onSelect={setSelectedId} />;
    }
    await act(async () => root.render(<Harness />));
    await click('Expand Pad'); await click('Expand Outline'); await click('Select Pad in history');
    expect(button('Collapse Outline')).toBeTruthy(); expect(button('Collapse Pad')).toBeTruthy();
    await click('Collapse Outline'); expect(button('Expand Outline').getAttribute('aria-expanded')).toBe('false');
    expect(button('Select Pad in history').getAttribute('aria-pressed')).toBe('true');
    await click('Collapse Pad'); await click('Expand Pad');
    expect(button('Expand Outline').getAttribute('aria-expanded')).toBe('false');
  });
  it('selects nested sketch profiles and edits sketches or curves only through their typed callbacks', async () => {
    const onEditSketch = vi.fn(), onEditCurve = vi.fn(), onSelectProfile = vi.fn();
    await act(async () => root.render(<CadFeatureTree {...props({ selectedId: 'sketch', selectedProfileId: 'rectangle', onEditSketch, onEditCurve, onSelectProfile })} />));
    expect(button('Boundary profile').getAttribute('aria-pressed')).toBe('true');
    expect(button('Select Outline in history').getAttribute('aria-pressed')).toBe('false');
    await click('Boundary profile'); expect(onSelectProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'sketch' }), 'rectangle');
    await act(async () => button('Select Outline in history').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await act(async () => button('Select Guide in history').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await act(async () => button('Select Pad in history').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onEditSketch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'sketch' }));
    expect(onEditCurve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'curve' }));
  });
  it('presents build issues, suppression and parameter highlights without changing model data', async () => {
    const document = sample(), source = JSON.stringify(document);
    const issues = cadBuildIssues(document, { diagnostics: [{ code: 'example', featureId: 'pad', message: 'Cannot build this body.' }] }, 'v1', true);
    await act(async () => root.render(<CadFeatureTree {...props({ document, highlightedFeatureIds: ['pad'], issues })} />));
    expect(button('Select Pad in history').getAttribute('aria-description')).toBe('Pad / pocket · Pad · Cannot build this body.');
    expect(button('Select Pad in history').classList.contains('has-error')).toBe(true);
    const diagnostic = button('Select Pad in history').querySelector('.cad-tree-error');
    expect(diagnostic?.getAttribute('aria-label')).toBe('Cannot build this body.');
    expect(diagnostic?.querySelector('svg[data-workbench-icon="warning"][aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[data-cad-feature-id="pad"]')?.classList.contains('is-parameter-related')).toBe(true);
    // The feature that reads the failed result is marked as blocked, naming what it waits on.
    const blocked = button('Select Moved body in history'), mark = blocked.querySelector('.cad-tree-blocked');
    expect([blocked.classList.contains('is-blocked'), blocked.classList.contains('has-error'), blocked.querySelector('.cad-tree-error')]).toEqual([true, false, null]);
    expect(blocked.getAttribute('aria-description')).toBe(`Move / rotate · Moved body · ${CAD_INPUT_BLOCKED} · Cause: Pad`);
    expect([mark?.getAttribute('aria-label'), mark?.getAttribute('data-cad-issue-code')]).toEqual([`${CAD_INPUT_BLOCKED} · Cause: Pad`, 'input-blocked']);
    expect(mark?.querySelector('svg[data-workbench-icon="info"][aria-hidden="true"]')).not.toBeNull();
    expect(JSON.stringify(document)).toBe(source);
    const suppressed = parseCadDocument({ ...document, features: document.features.map(feature => feature.id === 'move' ? { ...feature, suppressed: true } : feature) });
    await act(async () => root.render(<CadFeatureTree {...props({ document: suppressed, selectedId: 'pad' })} />));
    expect(button('Select Moved body in history').classList.contains('is-suppressed')).toBe(true);
  });
});
