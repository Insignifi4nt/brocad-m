import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCacheAdapter } from '@/domain/storage/browserCacheAdapter';
import { installCadPlugin, listCadPlugins } from '@/domain/cad/plugins/cadPluginStorage';
import { CAD_STAR_PLUGIN } from '@/domain/cad/plugins/cadPlugins';
import { createCadDocument } from '@/domain/cad/cadSchema';
import { CadPluginsPanel } from './CadPluginsPanel';
import { CadWorkbench } from './CadWorkbench';
import { CadSession } from './cadSession';
import { cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

vi.mock('./CadViewport', () => ({ CadViewport: ({ hidden }: { hidden?: boolean }) => hidden ? <div className="cad-viewport" hidden /> : <div>Native viewport is verified in browser tests</div> }));
let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native setter');
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
describe('CAD plugin UI operations', () => {
  it('filters real packages and keeps authoring separate from adding profiles', async () => {
    await act(async () => root.render(<CadPluginsPanel onClose={vi.fn()} onAdd={vi.fn()} />));
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]');
    if (!search) throw new Error('Missing plugin search');
    expect(document.activeElement).toBe(search); expect(container.querySelector('textarea')).toBeNull();
    await input(search, 'star');
    expect(container.querySelectorAll('.cad-plugin-list article')).toHaveLength(1);
    expect(container.querySelector('.cad-plugin-list')?.textContent).toContain('Star profile');
    await click('Author or install a plugin'); expect(container.querySelector('.cad-plugin-list')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    await click('Profiles'); expect(document.activeElement).toBe(container.querySelector('input[aria-label="Search plugins"]'));
    expect(container.querySelector('textarea')).toBeNull();
  });
  it('reviews and installs an edited recipe with real storage, preserving its source and version', async () => {
    const adapter = createBrowserCacheAdapter(localStorage), add = vi.fn();
    const source = JSON.stringify({ ...CAD_STAR_PLUGIN, id: 'user.flange', name: 'Flange profile' }, null, 2);
    await act(async () => root.render(<CadPluginsPanel onClose={vi.fn()} onAdd={add} onListPlugins={() => listCadPlugins(adapter)} onInstallPlugin={text => installCadPlugin(adapter, text)} />));
    await click('Author or install a plugin'); await click('Load recipe example');
    const textarea = container.querySelector('textarea'); if (!textarea) throw new Error('Missing authoring editor');
    await input(textarea, source); await click('Validate package'); await click('Install validated package');
    expect(await adapter.readText('cad/plugins/user.flange/1.0.0.cad-plugin.json')).toBe(source);
    await click('Add Flange profile'); expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: 'user.flange', version: '1.0.0' }));
  });
  it('invalidates package review after source edits and reports invalid geometry without writes', async () => {
    const install = vi.fn();
    await act(async () => root.render(<CadPluginsPanel onClose={vi.fn()} onAdd={vi.fn()} onInstallPlugin={install} />));
    await click('Author or install a plugin'); await click('Load recipe example'); await click('Validate package');
    const textarea = container.querySelector('textarea'); if (!textarea) throw new Error('Missing editor');
    await input(textarea, '{invalid');
    expect(container.textContent).not.toContain('Install validated package');
    await click('Validate package'); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(install).not.toHaveBeenCalled();
  });
  it('adds a real parametric plugin profile, applies expressions and blocks invalid tooth counts before applying', async () => {
    const session = new CadSession({ ...createCadDocument(), parameters: { chosenModule: 4 } });
    function Harness() {
      const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
      return <CadWorkbench document={state.document} documentVersion={state.version} buildVersion={null} build={null} buildState="idle" dirty={state.dirty} canUndo={state.canUndo} canRedo={state.canRedo}
        onEditMany={edits => { session.edit(edits); }} onEdit={edit => session.edit([edit])} onUndo={() => session.undo()} onRedo={() => session.redo()} onWorkflowChange={session.setWorkflowOpen}
        onBack={vi.fn()} onSave={async () => undefined} onOpenDocument={vi.fn()} onNewDocument={vi.fn()} onImportDocument={async () => undefined} onExportDocument={vi.fn()}
        onExportSolid={async () => undefined} onOpenDxfExport={async () => undefined} onSendToCam={async () => undefined} />;
    }
    await act(async () => root.render(<Harness />));
    await click('Plugins'); expect(session.getSnapshot().workflowOpen).toBe(true); await click('Add Spur gear');
    expect(session.getSnapshot().workflowOpen).toBe(false);
    const module = Array.from(container.querySelectorAll('label')).find(label => label.querySelector('span')?.childNodes[0]?.textContent === 'Module')?.querySelector('input');
    if (!module) throw new Error('Missing Module input'); expect(module.value).toBe('3');
    await click('Edit Module relation');
    const expression = document.querySelector<HTMLInputElement>('input[aria-label="Module expression"]');
    if (!expression) throw new Error('Missing Module expression'); await input(expression, 'chosenModule');
    const keep = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button => button.textContent === 'Keep relation');
    if (!keep) throw new Error('Missing relation action'); await act(async () => keep.click());
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Module relation help"]');
    if (!close) throw new Error('Missing relation close'); await act(async () => close.click()); await click('Apply');
    const feature = session.getSnapshot().document.features[0];
    // The gear is a generator: the sketch keeps its record, with no saved profile, and the panel edits it as it did the profile.
    const gear = feature.kind === 'sketch' ? cadSketchProfileViews(feature)[0]?.geometry : undefined;
    expect(feature.kind === 'sketch' && feature.profiles).toEqual([]);
    expect(gear?.kind === 'plugin' && gear.inputs.module).toBe('chosenModule');
    const before = session.getSnapshot().document;
    const teeth = Array.from(container.querySelectorAll('label')).find(label => label.querySelector('span')?.childNodes[0]?.textContent === 'Teeth')?.querySelector('input');
    if (!teeth) throw new Error('Missing Teeth input'); await input(teeth, '301'); await click('Apply');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('integer'); expect(session.getSnapshot().document).toBe(before);
  });
});
