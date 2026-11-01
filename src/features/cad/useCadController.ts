import { userFacingMessage } from '@/lib/userMessage';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { useWorkbenchAppController } from '@/app/useWorkbenchAppController';
import type { CadBuildResult, CadDocument } from '@/domain/cad/cadDocument';
import { cadFeatureProducesBody, createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { archiveCadDocument, listCadDocuments, loadCadDocument, renameCadDocument, restoreCadDocument, saveCadDocument, type CadLibraryEntry } from '@/domain/cad/cadStorage';
import { readExactUtf8Blob } from '@/domain/storage/exactTextStream';
import { applyCadEdits, validateCadEditBatch, type CadEdit } from '@/domain/cad/cadOperations';
import { isCadSectionResult, parseCadSectionRequest, type CadSectionRequest } from '@/domain/cad/cadSection';
import type { DraftReadSnapshot } from '@/features/webmcp/workbenchSiteTools';
import { ToolError } from '@/features/webmcp/siteTools';
import { CadSession, hasUnsavedCadDraft } from './cadSession';
import { useCadUnloadGuard } from './useCadUnloadGuard';
import { installCadPlugin, listCadPlugins } from '@/domain/cad/plugins/cadPluginStorage';
import { cadViewportVisualIdentity, type CadViewportCommand, type CadWorkbenchViewportControls, type CadViewportState } from './cadViewportControls';
import { preparePreviewCapture, downloadPreviewCapture, type PreviewCaptureArtifact } from '@/features/webmcp/previewCapture';
import { createCadTopologyActions } from './cadTopologyActions';
import type { CadTopologyInspectRequest, CadTopologyResolvePicksRequest } from '@/domain/cad/cadTopology';
import type { CadTopologyAdjacencyRequest, CadTopologyTangentChainRequest } from '@/domain/cad/cadTopologyAdjacency';
import { createCadFeatureInputCoordinator } from './cadFeatureInput';
import { useOwnedDisposable } from '@/lib/useOwnedDisposable';
import { cadBytesToBase64, cadSolidImportByteLength, isCadSolidImportResult, parseCadSolidImportSource, type CadSolidImportSource } from '@/domain/cad/cadImports';
import { parseCadDxfImportSource, type CadDxfUnits } from '@/domain/cad/cadDxfSource';
import type { DxfUnitDeclaration } from '@/domain/dxf/types';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { createCadFeaturePreviewCoordinator, type CadFeaturePreviewState } from './cadFeaturePreview';
import { CadSketchRegionReadTargetSchema, type CadSketchRegionReadTarget, type CadSketchRegionInspectionInput, type CadSketchRegionProposal } from '@/domain/cad/cadSketchRegionInspection';
import { Value } from '@sinclair/typebox/value';
import { isCadImportData } from '@/domain/cad/cadImportData';
import { needsCadSketchPreparation, prepareCadEdits, type CadSketchEditWarning, type CadSketchWarningsRecord } from './cadEditPreparation';
import type { CadSketchSolverClient } from './sketch-solver/cadSketchSolverTypes';
import type { CadSketchConstraintInspection } from './cadSketchConstraintInspection';
import { useCadSketchEditing } from './useCadSketchEditing';

type App = Pick<ReturnType<typeof useWorkbenchAppController>, 'connectedWorkbench' | 'workbenchInteractionLocked' | 'runAgentWorkbenchOperation'>
  & Partial<Pick<ReturnType<typeof useWorkbenchAppController>, 'showStatusToast'>>;
type Kernel = ReturnType<typeof import('./kernel/cadKernelClient').createCadKernelClient>;
export function downloadCadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const fileBase = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100) || 'part';
function importUnitReceipt(declaration: DxfUnitDeclaration) {
  if (declaration.status !== 'malformed' || declaration.rawValue === null || declaration.rawValue.length <= 160) return declaration;
  // The exact declaration remains in the saved original; keep committed tool receipts bounded.
  return { ...declaration, rawValue: declaration.rawValue.slice(0, 160), rawValueTruncated: true, rawValueLength: declaration.rawValue.length };
}
function matchingSectionResult(value: unknown, request: CadSectionRequest, parameters: CadDocument['parameters']) {
  if (!isCadSectionResult(value) || value.bodyId !== request.bodyId || value.plane !== request.plane || value.offset !== evaluateCadScalar(request.offset, parameters)) {
    throw new ToolError('INVALID_SECTION_RESULT', 'The CAD kernel returned an invalid or different section. Rebuild and preview the section again.');
  }
  return value;
}
type CadPreviewArtifact = PreviewCaptureArtifact & { documentId: string; viewState: CadViewportState; sketchId: string | null; curveId: string | null };

export function useCadController(app: App, session: CadSession, open: boolean, setOpen: (open: boolean) => void,
  getCamDraft: () => DraftReadSnapshot | null) {
  useCadUnloadGuard(session);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [build, setBuild] = useState<CadBuildResult | null>(null);
  const [buildVersion, setBuildVersion] = useState<string | null>(null);
  const [buildState, setBuildState] = useState<'idle' | 'building' | 'ready' | 'error'>('idle');
  const [featurePreview, setFeaturePreview] = useState<CadFeaturePreviewState>({ kind: 'idle' });
  const [sketchWarnings, setSketchWarnings] = useState<CadSketchWarningsRecord | null>(null);
  const liveBuild = useRef({ result: build, version: buildVersion, state: buildState });
  liveBuild.current = { result: build, version: buildVersion, state: buildState };
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [library, setLibrary] = useState<CadLibraryEntry[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryDiagnostic, setLibraryDiagnostic] = useState<string | null>(null);
  const libraryAbort = useRef<AbortController | null>(null);
  const [importFile, setImportFile] = useState<{ file: File; version: string; adapter: NonNullable<App['connectedWorkbench']>['adapter'] } | null>(null);
  const importAbort = useRef<AbortController | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<CadPreviewArtifact | null>(null);
  const previewUrl = useRef<string | null>(null);
  const viewport = useRef<CadWorkbenchViewportControls | null>(null);
  const regionReferenceTexts = useRef(new WeakMap<CadDocument, Map<string, string>>());
  const proposedRegionReferenceTexts = useRef<{ document: CadDocument; sketchId: string; proposalKey: string; texts: Map<string, string> } | null>(null);
  const setViewportControls = useCallback((controls: CadWorkbenchViewportControls | null) => { viewport.current = controls; }, []);
  const busy = useRef(false);
  const preparing = useRef<AbortController | null>(null);
  const sketchSolver = useRef<Promise<CadSketchSolverClient> | null>(null);
  const constraintInspections = useRef(new WeakMap<CadDocument, Map<string, CadSketchConstraintInspection>>());
  const current = useRef({ app, open }); current.current = { app, open };
  const kernel = useRef<Promise<Kernel> | null>(null);
  const buildAbort = useRef<AbortController | null>(null);
  const boundAdapter = useRef(app.connectedWorkbench?.adapter);
  const sketchEditing = useCadSketchEditing({ session, storage: app.connectedWorkbench?.adapter ?? null, open,
    locked: storageBusy || app.workbenchInteractionLocked, prepare: prepareDocument, prepareCommit, warn: showSketchWarnings, inspect: readSketchConstraintInspection,
    commit: (edits, version, signal) => edit(edits, version, false, signal) });
  const featurePreviewCoordinator = useOwnedDisposable(() => createCadFeaturePreviewCoordinator({
    assertCurrent(expectedVersion) {
      const workbench = connected(); editable(expectedVersion); session.assertWorkflowClosed('editor');
      return { document: session.getSnapshot().document, storage: workbench.adapter };
    },
    createKernel: async () => (await import('./kernel/cadKernelClient')).createCadKernelClient(),
    prepare: prepareDocument,
    onChange: setFeaturePreview
  }), session);
  useLayoutEffect(() => { featurePreviewCoordinator.invalidate(); }, [featurePreviewCoordinator, snapshot.version, app.connectedWorkbench?.adapter, open, app.workbenchInteractionLocked, storageBusy]);
  const featureInputCoordinator = useOwnedDisposable(() => createCadFeatureInputCoordinator({
    assertCurrent(expectedVersion, scope) {
      const workbench = connected(); editable(expectedVersion); session.assertWorkflowClosed(scope);
      return { document: session.getSnapshot().document, storage: workbench.adapter };
    },
    createKernel: async () => (await import('./kernel/cadKernelClient')).createCadKernelClient(),
    prepare: prepareDocument,
  }), session);
  useLayoutEffect(() => { featureInputCoordinator.invalidate(); }, [featureInputCoordinator, snapshot.version, app.connectedWorkbench?.adapter, open, app.workbenchInteractionLocked, storageBusy]);
  useLayoutEffect(() => {
    try { session.assertWorkflowClosed('editor'); } catch { featureInputCoordinator.invalidate(); }
  }, [featureInputCoordinator, session, snapshot]);
  const releaseFeatureInput = useCallback((inputToken: string) => featureInputCoordinator.clear(inputToken), [featureInputCoordinator]);
  function changeOpen(value: boolean) {
    current.current.open = value;
    setOpen(value);
  }

  function getKernel() {
    kernel.current ??= import('./kernel/cadKernelClient').then(module => module.createCadKernelClient());
    return kernel.current;
  }
  function getSketchSolver() {
    if (sketchSolver.current) return sketchSolver.current;
    const pending = import('./sketch-solver/cadSketchSolverClient').then(module => module.createCadSketchSolverClient());
    sketchSolver.current = pending;
    void pending.catch(() => { if (sketchSolver.current === pending) sketchSolver.current = null; });
    return pending;
  }
  /** Prepares a previewed batch: every preview goes through here, and none looks for solve warnings. */
  async function prepareDocument(document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal) {
    return needsCadSketchPreparation(document, edits)
      ? (await prepareCadEdits(document, edits, await getSketchSolver(), signal)).document : applyCadEdits(document, edits);
  }
  /** As `prepareDocument`, with warnings about its solves, for an edit that is committed rather than previewed. */
  async function prepareCommit(document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal) {
    return needsCadSketchPreparation(document, edits)
      ? prepareCadEdits(document, edits, await getSketchSolver(), signal, { warnings: true }) : { document: applyCadEdits(document, edits), sketchWarnings: [] };
  }
  /**
   * Shows each warning of an accepted edit's solves as a status toast that names its sketch, and keeps them with the version that edit made, so
   * the sketch being edited lists them among its issues until another version is shown.
   */
  function showSketchWarnings(warnings: readonly CadSketchEditWarning[], version: string) {
    for (const warning of warnings) current.current.app.showStatusToast?.(`${warning.sketchName}: ${warning.message}`, 'warning');
    setSketchWarnings(warnings.length ? Object.freeze({ version, warnings }) : null);
  }
  async function readSketchConstraintInspection(source: CadDocument, sketchId: string, signal?: AbortSignal) {
    let inspection = constraintInspections.current.get(source)?.get(sketchId);
    if (!inspection) {
      const { inspectCadSketchConstraints } = await import('./cadSketchConstraintInspection'); signal?.throwIfAborted();
      inspection = await inspectCadSketchConstraints(source, sketchId, getSketchSolver, signal);
      signal?.throwIfAborted();
    }
    return inspection;
  }
  function publishBuild(result: CadBuildResult, version: string) {
    const state = result.diagnostics.length ? 'error' : 'ready';
    liveBuild.current = { result, version, state };
    setErrorMessage(null);
    setBuild(result); setBuildVersion(version); setBuildState(state);
  }
  useLayoutEffect(() => {
    const adapter = app.connectedWorkbench?.adapter;
    const previous = boundAdapter.current;
    if (previous === adapter) return;
    closeLibrary();
    importAbort.current?.abort(); setImportFile(null); session.setWorkflowOpen(false, 'import');
    // Retain the last store through a disconnect so reconnecting elsewhere cannot
    // reuse its saved fingerprint. A disconnect alone preserves the current draft.
    if (!adapter) return;
    boundAdapter.current = adapter;
    if (!previous) return;
    const state = session.getSnapshot();
    // A saved fingerprint belongs to one adapter. Never reuse it in a new store.
    // Unexpected dirty switches preserve the in-memory work as an unsaved copy.
    if (!state.dirty && !state.workflowOpen) session.replace(createCadDocument());
    else if (state.savedVersion !== null) session.detachStorage();
    setLibrary(null); setLibraryDiagnostic(null); setBuild(null); setBuildVersion(null); setErrorMessage(null);
  }, [app.connectedWorkbench?.adapter, session]);
  useEffect(() => () => {
    preparing.current?.abort();
    void sketchSolver.current?.then(client => client.dispose(), () => undefined);
    libraryAbort.current?.abort(); session.setWorkflowOpen(false, 'library');
    importAbort.current?.abort();
    buildAbort.current?.abort();
    void kernel.current?.then(value => value.dispose()); kernel.current = null;
    if (previewUrl.current) { const url = previewUrl.current; window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
  }, []);

  useEffect(() => {
    if (!open || !app.connectedWorkbench?.adapter) return;
    const controller = new AbortController();
    buildAbort.current?.abort(); buildAbort.current = controller;
    setBuildVersion(null);
    setBuildState(snapshot.document.features.some(feature => cadFeatureProducesBody(feature) && cadFeatureActive(feature, snapshot.document)) ? 'building' : 'idle');
    if (!snapshot.document.features.some(feature => cadFeatureProducesBody(feature) && cadFeatureActive(feature, snapshot.document))) {
      setBuild(null); return () => controller.abort();
    }
    const timer = setTimeout(() => {
      void getKernel().then(client => client.build(snapshot.document, controller.signal)).then(result => {
        if (controller.signal.aborted || session.getSnapshot().version !== snapshot.version) return;
        publishBuild(result, snapshot.version);
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBuildState('error'); setErrorMessage(userFacingMessage(error, 'CAD kernel could not build this model.'));
      });
    }, 30);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, snapshot.document, app.connectedWorkbench?.adapter]);

  function connected() {
    if (busy.current || preparing.current || current.current.app.workbenchInteractionLocked) throw new ToolError('BUSY', 'A workbench operation is running.');
    const workbench = current.current.app.connectedWorkbench;
    if (!workbench) throw new ToolError('WORKBENCH_UNAVAILABLE', 'Wait for the workbench to open.');
    return workbench;
  }
  function assertCanSwitch() {
    const cam = getCamDraft();
    if (cam?.dirty || cam?.workflowOpen) throw new ToolError('DRAFT_IN_USE', 'Save the CAM draft and finish its workflow before opening CAD.');
  }
  function editable(expectedVersion?: string, fromAgent = false) {
    connected();
    if (!current.current.open) throw new ToolError('CAD_NOT_OPEN', 'Open CAD with cad_create_document or cad_open_workspace first.');
    if (expectedVersion) session.assertVersion(expectedVersion);
    if (fromAgent) session.assertWorkflowClosed();
  }
  async function run<T>(action: () => Promise<T>) {
    connected(); busy.current = true; setStorageBusy(true); setErrorMessage(null);
    try { return await action(); }
    catch (error) {
      const aborted = (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError';
      if (!aborted) setErrorMessage(userFacingMessage(error, 'CAD operation failed.'));
      throw error;
    }
    finally { busy.current = false; setStorageBusy(false); }
  }
  function enter() { connected(); assertCanSwitch(); changeOpen(true); }
  const plugins = useCallback(async (signal?: AbortSignal) => {
    const workbench = connected();
    const result = await listCadPlugins(workbench.adapter, signal);
    signal?.throwIfAborted();
    if (current.current.app.connectedWorkbench !== workbench) throw new ToolError('STALE_STATE', 'Workbench changed while listing plugins.');
    return result;
  }, []);
  async function installPlugin(text: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'editor') {
    editable(expectedVersion); session.assertWorkflowClosed(scope);
    if (busy.current) throw new ToolError('BUSY', 'Wait for the current CAD operation to finish.');
    const workbench = connected();
    return run(() => installCadPlugin(workbench.adapter, text, { signal, beforeWrite: () => {
      signal?.throwIfAborted(); session.assertVersion(expectedVersion); session.assertWorkflowClosed(scope);
      if (current.current.app.connectedWorkbench !== workbench) throw new ToolError('STALE_STATE', 'Workbench changed before plugin installation.');
    } }));
  }
  const preparePreviewEdits = useCallback(async (edits: readonly CadEdit[], signal: AbortSignal) => {
    signal.throwIfAborted(); editable(snapshot.version); session.assertWorkflowClosed('editor');
    validateCadEditBatch(edits);
    const captured = structuredClone(edits), source = session.getSnapshot().document, workbench = connected();
    const candidate = await prepareDocument(source, captured, signal);
    signal.throwIfAborted(); editable(snapshot.version); session.assertWorkflowClosed('editor');
    if (session.getSnapshot().document !== source || current.current.app.connectedWorkbench !== workbench)
      throw new ToolError('STALE_STATE', 'The CAD workspace changed while preparing this preview.');
    return candidate;
  }, [session, snapshot.version]);
  /** Applies a batch as one undo step. Once it is accepted, the warnings its solves gave are shown and passed to `warned`. */
  function edit(edits: readonly CadEdit[], expectedVersion?: string, fromAgent = false, signal?: AbortSignal, warned?: (warnings: readonly CadSketchEditWarning[]) => void) {
    signal?.throwIfAborted();
    editable(expectedVersion, fromAgent); setErrorMessage(null);
    validateCadEditBatch(edits);
    const captured = structuredClone(edits);
    const source = session.getSnapshot();
    if (needsCadSketchPreparation(source.document, captured)) {
      const workbench = current.current.app.connectedWorkbench;
      const owner = new AbortController(); preparing.current = owner;
      const combined = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal;
      session.setWorkflowOpen(true, 'preparation');
      const solver = getSketchSolver();
      let warnings: readonly CadSketchEditWarning[] = [];
      return session.editPrepared(expectedVersion ?? source.version, async (document, signal) => {
        const prepared = await prepareCadEdits(document, captured, await solver, signal, { warnings: true });
        warnings = prepared.sketchWarnings; return prepared.document;
      }, combined, () => {
        if (!current.current.open || current.current.app.connectedWorkbench !== workbench || current.current.app.workbenchInteractionLocked)
          throw new ToolError('STALE_STATE', 'The CAD workspace changed while the sketch was being solved.');
      }).then(accepted => { showSketchWarnings(warnings, session.getSnapshot().version); warned?.(warnings); return accepted; }).finally(() => {
        if (preparing.current === owner) { preparing.current = null; session.setWorkflowOpen(false, 'preparation'); }
      });
    }
    return session.edit(captured, expectedVersion);
  }
  async function persistReviewed(workbench: NonNullable<App['connectedWorkbench']>, expectedVersion: string, signal?: AbortSignal) {
    const reviewed = session.getSnapshot();
    const saved = await saveCadDocument(workbench.adapter, reviewed.document, {
      expectedSavedVersion: reviewed.savedVersion, signal, beforeWrite: () => {
        session.assertVersion(expectedVersion); session.assertWorkflowClosed();
        if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed.');
      }
    });
    // A durable receipt belongs to its actual destination. A disconnect or
    // unexpected switch after commit must not lend its baseline to another store.
    const draftMarkedSaved = current.current.app.connectedWorkbench?.adapter === workbench.adapter && session.getSnapshot().version === expectedVersion;
    if (draftMarkedSaved) session.markSaved(saved, expectedVersion);
    return { saved: true, draftMarkedSaved, storageName: workbench.adapter.name, documentId: saved.document.id, savedVersion: saved.savedVersion, version: expectedVersion };
  }
  async function save(expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed();
    const workbench = connected();
    return run(() => persistReviewed(workbench, expectedVersion, signal));
  }
  async function list(signal?: AbortSignal) {
    const workbench = connected();
    return listCadDocuments(workbench.adapter, signal);
  }
  function reviewProjectMutation(adapter: Parameters<typeof renameCadDocument>[0], documentId?: string) {
    const workbench = connected(); session.assertWorkflowClosed();
    if (workbench.adapter !== adapter) throw new ToolError('STALE_STATE', 'Storage changed. Refresh the project library.');
    const reviewed = session.getSnapshot();
    if (documentId === reviewed.document.id && hasUnsavedCadDraft(reviewed)) {
      throw new ToolError('UNSAVED_DRAFT', 'Save the CAD draft before changing its saved project.');
    }
    return reviewed;
  }
  const projectActions = {
    rename: async (...args: Parameters<typeof renameCadDocument>) => {
      const [adapter, id, , options] = args;
      const reviewed = reviewProjectMutation(adapter, id);
      return run(async () => {
        const saved = await renameCadDocument(...args);
        if (current.current.app.connectedWorkbench?.adapter === adapter && session.getSnapshot().version === reviewed.version && reviewed.document.id === id) {
          if (reviewed.savedVersion === options.expectedSavedVersion) {
            session.edit([{ kind: 'rename-document', name: saved.document.name }], reviewed.version);
            session.markSaved(saved, session.getSnapshot().version);
          } else session.replace(saved.document, saved);
        }
        return saved;
      });
    },
    archive: async (...args: Parameters<typeof archiveCadDocument>) => {
      const [adapter, id] = args;
      const reviewed = reviewProjectMutation(adapter, id);
      return run(async () => {
        const archived = await archiveCadDocument(...args);
        if (current.current.app.connectedWorkbench?.adapter === adapter && session.getSnapshot().version === reviewed.version && reviewed.document.id === id) {
          session.replace(createCadDocument());
        }
        return archived;
      });
    },
    restore: async (...args: Parameters<typeof restoreCadDocument>) => {
      reviewProjectMutation(args[0]);
      return run(() => restoreCadDocument(...args));
    }
  };
  function closeLibrary() {
    libraryAbort.current?.abort(); libraryAbort.current = null;
    setLibrary(null); setLibraryLoading(false); setLibraryDiagnostic(null); session.setWorkflowOpen(false, 'library');
  }
  async function showLibrary() {
    const workbench = connected(), expectedVersion = session.getSnapshot().version;
    editable(expectedVersion); session.assertWorkflowClosed();
    const controller = new AbortController(); libraryAbort.current = controller;
    session.setWorkflowOpen(true, 'library'); setLibrary([]); setLibraryLoading(true); setLibraryDiagnostic(null);
    try {
      const result = await listCadDocuments(workbench.adapter, controller.signal);
      controller.signal.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed('library');
      if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed while listing CAD documents.');
      setLibrary(result.entries);
      setLibraryDiagnostic([result.truncated ? 'The library listing is incomplete.' : '', ...result.diagnostics.map(d => `${d.path}: ${d.message}`)].filter(Boolean).join(' ') || null);
    } catch (error) {
      if (controller.signal.aborted) return;
      closeLibrary(); throw error;
    } finally {
      if (libraryAbort.current === controller) { libraryAbort.current = null; setLibraryLoading(false); }
    }
  }
  function requireCleanReplacement(scope?: 'import' | 'library') {
    session.assertWorkflowClosed(scope);
    const state = session.getSnapshot();
    if (hasUnsavedCadDraft(state)) throw new ToolError('UNSAVED_DRAFT', 'Save the current CAD draft before opening another document.');
  }
  async function openDocument(id: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'library') {
    connected(); assertCanSwitch(); session.assertVersion(expectedVersion); requireCleanReplacement(scope);
    const workbench = connected();
    return run(async () => {
      const saved = await loadCadDocument(workbench.adapter, id, signal);
      signal?.throwIfAborted(); session.assertVersion(expectedVersion); requireCleanReplacement(scope);
      if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed.');
      session.replace(saved.document, saved); closeLibrary(); setBuild(null); changeOpen(true);
      return session.getSnapshot();
    });
  }
  function newDocument(name = 'Untitled part', expectedVersion = session.getSnapshot().version) {
    connected(); assertCanSwitch(); session.assertVersion(expectedVersion); requireCleanReplacement();
    session.replace(createCadDocument(name)); setBuild(null); changeOpen(true);
    return session.getSnapshot();
  }
  async function importDocument(file: File) {
    const workbench = connected(); assertCanSwitch(); requireCleanReplacement();
    if (/\.(step|stp|stl|dxf)$/i.test(file.name)) {
      if (!file.size) throw new ToolError('EMPTY_FILE', 'CAD geometry files must be nonempty.');
      setImportFile({ file, version: session.getSnapshot().version, adapter: workbench.adapter }); session.setWorkflowOpen(true, 'import');
      return;
    }
    const expected = session.getSnapshot().version;
    const controller = new AbortController();
    importAbort.current?.abort(); importAbort.current = controller;
    return run(async () => {
      try {
        let text: string;
        try { text = await readExactUtf8Blob(file, controller.signal); }
        catch (error) {
          if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed during CAD import.');
          controller.signal.throwIfAborted();
          if (error instanceof TypeError) throw new ToolError('INVALID_ENCODING', 'CAD JSON must contain valid UTF-8. The draft has not changed.');
          throw error;
        }
        // Only the document transport BOM is removed; embedded source strings stay exact.
        return acceptImportedDocument(JSON.parse(text.replace(/^\uFEFF/, '')), workbench, expected, controller.signal);
      } finally {
        if (importAbort.current === controller) importAbort.current = null;
      }
    });
  }
  function acceptImportedDocument(value: unknown, workbench: NonNullable<App['connectedWorkbench']>, expectedVersion: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement();
    if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed during CAD import.');
    const document = parseCadDocument(value);
    // Portable imports receive a fresh identity. replace validates the final
    // document before changing the accepted draft or any installed save.
    session.replace({ ...document, id: `cad_${crypto.randomUUID()}` }); setBuild(null); changeOpen(true);
    return { imported: true, documentId: session.getSnapshot().document.id, sourceDocumentId: document.id, version: session.getSnapshot().version };
  }
  async function importDocumentValue(value: unknown, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    const workbench = connected(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement();
    return run(async () => acceptImportedDocument(value, workbench, expectedVersion, signal));
  }
  function cancelImport() {
    importAbort.current?.abort(); importAbort.current = null;
    setImportFile(null); session.setWorkflowOpen(false, 'import'); setErrorMessage(null);
  }
  async function importSolidSource(value: unknown, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'import') {
    const workbench = connected(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement(scope);
    const source = parseCadSolidImportSource(value);
    return run(async () => {
      signal?.throwIfAborted();
      const client = await getKernel();
      signal?.throwIfAborted();
      const analysis = await client.importSolid(source, signal);
      signal?.throwIfAborted(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement(scope);
      if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed during CAD import.');
      if (!isCadSolidImportResult(analysis) || analysis.format !== source.format || analysis.fileName !== source.fileName || analysis.sourceBytes !== cadSolidImportByteLength(source)) {
        throw new ToolError('INVALID_IMPORT_RESULT', 'CAD import did not return a matching validated solid.');
      }
      const document = parseCadDocument({ ...createCadDocument(source.fileName.replace(/\.(step|stp|stl)$/i, '')), features: [{
        id: `import_${crypto.randomUUID()}`, name: source.fileName, kind: 'imported', suppressed: false, source
      }] });
      session.replace(document); setBuild(null); setBuildVersion(null); setBuildState('idle'); changeOpen(true);
      setImportFile(null);
      return { imported: true, documentId: document.id, version: session.getSnapshot().version, ...analysis };
    });
  }
  async function importDxfSource(value: unknown, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'import') {
    const workbench = connected(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement(scope);
    const source = parseCadDxfImportSource(value);
    return run(async () => {
      signal?.throwIfAborted(); const client = await getKernel(); signal?.throwIfAborted();
      const result = await client.importDxf({ fileName: source.fileName, text: source.text, ...(source.units ? { units: source.units } : {}) }, signal);
      signal?.throwIfAborted(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement(scope);
      if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed during CAD import.');
      const original = result.sketch.source;
      if (!original || original.format !== 'dxf' || original.fileName !== source.fileName || original.text !== source.text || original.units !== source.units) {
        throw new ToolError('INVALID_IMPORT_RESULT', 'DXF import did not preserve the supplied original.');
      }
      const document = parseCadDocument({ ...createCadDocument(result.sketch.name), features: [result.sketch] });
      session.replace(document); setBuild(null); setBuildVersion(null); setBuildState('idle'); changeOpen(true); setImportFile(null);
      return { imported: true, documentId: document.id, version: session.getSnapshot().version, sketchId: result.sketch.id,
        unitDeclaration: importUnitReceipt(result.unitDeclaration), scaleToMillimeters: result.scaleToMillimeters, sourceEntityCount: result.sourceEntityCount, contourCount: result.contourCount };
    });
  }
  async function importDxfCurveSource(value: unknown, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'import') {
    const workbench = connected(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement(scope);
    const source = parseCadDxfImportSource(value);
    return run(async () => {
      signal?.throwIfAborted(); const client = await getKernel(); signal?.throwIfAborted();
      const result = await client.importDxfCurve({ fileName: source.fileName, text: source.text, ...(source.units ? { units: source.units } : {}) }, signal);
      signal?.throwIfAborted(); session.assertVersion(expectedVersion); assertCanSwitch(); requireCleanReplacement(scope);
      if (current.current.app.connectedWorkbench?.adapter !== workbench.adapter) throw new ToolError('STALE_STATE', 'Storage changed during CAD import.');
      const original = result.curve.source;
      if (!original || original.format !== 'dxf' || original.fileName !== source.fileName || original.text !== source.text || original.units !== source.units) {
        throw new ToolError('INVALID_IMPORT_RESULT', 'DXF import did not preserve the supplied original.');
      }
      const document = parseCadDocument({ ...createCadDocument(result.curve.name), features: [result.curve] });
      session.replace(document); setBuild(null); setBuildVersion(null); setBuildState('idle'); changeOpen(true); setImportFile(null);
      return { imported: true, documentId: document.id, version: session.getSnapshot().version, curveId: result.curve.id,
        unitDeclaration: importUnitReceipt(result.unitDeclaration), scaleToMillimeters: result.scaleToMillimeters, sourceEntityCount: result.sourceEntityCount };
    });
  }
  async function confirmImport(units: CadDxfUnits | 'file', dxfKind: 'sketch' | 'curve' = 'sketch') {
    const pending = importFile;
    if (!pending) throw new ToolError('IMPORT_UNAVAILABLE', 'Choose a CAD file first.');
    connected(); session.assertVersion(pending.version); requireCleanReplacement('import');
    const controller = new AbortController(); importAbort.current = controller;
    try {
      const stl = /\.stl$/i.test(pending.file.name);
      if (stl && units !== 'mm' && units !== 'inch') throw new ToolError('INVALID_UNITS', 'Choose millimeters or inches for STL.');
      let contents: string | Uint8Array;
      if (stl) contents = new Uint8Array(await pending.file.arrayBuffer());
      else {
        try { contents = await readExactUtf8Blob(pending.file, controller.signal); }
        catch (error) {
          controller.signal.throwIfAborted();
          if (error instanceof TypeError) throw new ToolError('INVALID_ENCODING', 'CAD geometry text must contain valid UTF-8. The draft has not changed.');
          throw error;
        }
      }
      controller.signal.throwIfAborted();
      session.assertVersion(pending.version);
      if (current.current.app.connectedWorkbench?.adapter !== pending.adapter) throw new ToolError('STALE_STATE', 'Storage changed during CAD import.');
      if (typeof contents === 'string' && /\.dxf$/i.test(pending.file.name)) return await (dxfKind === 'curve' ? importDxfCurveSource : importDxfSource)({ format: 'dxf', fileName: pending.file.name,
        text: contents, ...(units === 'file' ? {} : { units }) }, pending.version, controller.signal, 'import');
      if (dxfKind !== 'sketch') throw new ToolError('INVALID_IMPORT_KIND', 'Curve import requires a DXF file.');
      const source: CadSolidImportSource = typeof contents === 'string'
        ? { format: 'step', fileName: pending.file.name, encoding: 'utf8', data: contents }
        : { format: 'stl', fileName: pending.file.name, encoding: 'base64', data: cadBytesToBase64(contents), units: units === 'inch' ? 'inch' : 'mm' };
      return await importSolidSource(source, pending.version, controller.signal, 'import');
    } finally { if (importAbort.current === controller) importAbort.current = null; }
  }
  async function inspectSketchConstraints(sketchId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const source = session.getSnapshot().document, workbench = connected();
    const inspection = await readSketchConstraintInspection(source, sketchId, signal);
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    if (session.getSnapshot().document !== source || current.current.app.connectedWorkbench !== workbench)
      throw new ToolError('STALE_STATE', 'The CAD workspace changed while inspecting sketch constraints.');
    if (inspection.analysis.kind !== 'unavailable') {
      const cached = constraintInspections.current.get(source) ?? new Map<string, CadSketchConstraintInspection>();
      cached.set(sketchId, inspection); constraintInspections.current.set(source, cached);
    }
    return { version: expectedVersion, persisted: false, ...inspection };
  }
  async function inspectSketchHandles(sketchId: string, profileId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { inspectCadSketchHandles } = await import('@/domain/cad/cadSketchHandles');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    const document = session.getSnapshot().document, sketch = document.features.find(feature => feature.id === sketchId);
    const profile = sketch?.kind === 'sketch' ? sketch.profiles.find(profile => profile.id === profileId) : undefined;
    if (!profile) throw new ToolError('NOT_FOUND', 'Choose an existing profile in a sketch.');
    return inspectCadSketchHandles(profile, document.parameters);
  }
  async function measureSketch(sketchId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { measureCadSketch } = await import('@/domain/cad/cadMeasurements');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    return measureCadSketch(session.getSnapshot().document, sketchId);
  }
  async function measureCurve(curveId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { measureCadCurve } = await import('@/domain/cad/cadCurveMeasurements');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    return measureCadCurve(session.getSnapshot().document, curveId);
  }
  async function inspectSketchRegions(sketchId: string, page: CadSketchRegionInspectionInput = {}, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    if (!isCadImportData(page)) throw new ToolError('INVALID_ARGUMENT', 'Malformed sketch region query.');
    const captured = structuredClone(page);
    const { inspectCadSketchRegions } = await import('@/domain/cad/cadSketchRegionInspection');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    const result = inspectCadSketchRegions(session.getSnapshot().document, sketchId, captured);
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(); return result;
  }
  async function readSketchRegionReference(sketchId: string, target: CadSketchRegionReadTarget, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, proposal?: CadSketchRegionProposal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    if (!isCadImportData(target) || !Value.Check(CadSketchRegionReadTargetSchema, target) || proposal !== undefined && !isCadImportData(proposal))
      throw new ToolError('INVALID_ARGUMENT', 'Choose one contour boundary or unique graph cell IDs.');
    const capturedTarget = structuredClone(target), capturedProposal = proposal === undefined ? undefined : structuredClone(proposal);
    const document = session.getSnapshot().document, targetKey = JSON.stringify(capturedTarget), key = JSON.stringify([sketchId, capturedTarget]);
    if (capturedProposal !== undefined) {
      const { readCadSketchRegionReference, validateCadSketchRegionProposal } = await import('@/domain/cad/cadSketchRegionInspection');
      signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
      validateCadSketchRegionProposal(capturedProposal);
      const proposalKey = JSON.stringify(capturedProposal), previous = proposedRegionReferenceTexts.current;
      const cache = previous?.document === document && previous.sketchId === sketchId && previous.proposalKey === proposalKey
        ? previous : { document, sketchId, proposalKey, texts: new Map<string, string>() };
      let text = cache.texts.get(targetKey);
      if (text === undefined) {
        text = JSON.stringify(readCadSketchRegionReference(document, sketchId, capturedTarget, capturedProposal));
        signal?.throwIfAborted(); cache.texts.set(targetKey, text);
        proposedRegionReferenceTexts.current = cache;
      }
      signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(); return text;
    }
    let cache = regionReferenceTexts.current.get(document), text = cache?.get(key);
    if (text === undefined) {
      const { readCadSketchRegionReference } = await import('@/domain/cad/cadSketchRegionInspection');
      signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
      text = JSON.stringify(readCadSketchRegionReference(document, sketchId, capturedTarget));
      signal?.throwIfAborted();
      cache ??= new Map<string, string>(); cache.set(key, text); regionReferenceTexts.current.set(document, cache);
    }
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(); return text;
  }
  async function inspectPlugin(sketchId: string, profileId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { inspectCadPluginProfile } = await import('@/domain/cad/plugins/cadPlugins');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    const document = session.getSnapshot().document, sketch = document.features.find(feature => feature.id === sketchId);
    const profile = sketch?.kind === 'sketch' ? sketch.profiles.find(profile => profile.id === profileId) : undefined;
    if (profile?.geometry.kind !== 'plugin') throw new ToolError('NOT_FOUND', 'Choose an existing plugin profile in a sketch.');
    const inspection = inspectCadPluginProfile(profile.geometry, document.parameters);
    return { version: expectedVersion, sketchId, profileId, pluginId: profile.geometry.package.id, pluginVersion: profile.geometry.package.version,
      apiVersion: profile.geometry.package.apiVersion,
      inputs: inspection.fields.map(field => ({ name: field.name, value: inspection.values[field.name], enabled: field.enabled, minimum: field.minimum, maximum: field.maximum })),
      derived: profile.geometry.package.apiVersion === 2 ? profile.geometry.package.rules.derived.map(rule => ({ name: rule.name, label: rule.label, unit: rule.unit, value: inspection.values[rule.name] })) : [],
      issues: inspection.issues, persisted: false };
  }
  async function inspectParameters(expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { inspectCadParameters } = await import('@/domain/cad/cadParameters');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    return { version: expectedVersion, ...inspectCadParameters(session.getSnapshot().document), persisted: false };
  }
  async function inspectPlane(featureId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { inspectCadPlane } = await import('@/domain/cad/cadPlaneInspection');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    return { version: expectedVersion, ...inspectCadPlane(session.getSnapshot().document, featureId), persisted: false };
  }
  async function inspectLoft(sketchIds: readonly string[], expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { inspectCadLoft } = await import('@/domain/cad/cadLoftInspection');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    return { version: expectedVersion, ...inspectCadLoft(session.getSnapshot().document, sketchIds), persisted: false };
  }
  async function inspectSweep(sketchId: string, curveId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed(); signal?.throwIfAborted();
    const { inspectCadSweep } = await import('@/domain/cad/cadSweepInspection');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    return { version: expectedVersion, ...inspectCadSweep(session.getSnapshot().document, sketchId, curveId), persisted: false };
  }

  function getViewport(expectedVersion = session.getSnapshot().version) {
    editable(expectedVersion);
    const controls = viewport.current;
    if (!controls || controls.getState().documentVersion !== expectedVersion) throw new ToolError('VIEWPORT_UNAVAILABLE', 'Wait for the CAD viewport to display the current document.');
    return controls;
  }
  function changeViewport(command: CadViewportCommand, expectedVersion: string) {
    session.assertWorkflowClosed();
    const controls = getViewport(expectedVersion);
    controls.apply(command);
    return { version: expectedVersion, applied: true, command };
  }
  async function captureViewport(expectedVersion = session.getSnapshot().version, download = false, signal = new AbortController().signal) {
    session.assertWorkflowClosed();
    const controls = getViewport(expectedVersion);
    return run(async () => {
      const captured = await controls.capture(signal);
      signal.throwIfAborted(); session.assertVersion(expectedVersion); session.assertWorkflowClosed();
      if (captured.documentVersion !== expectedVersion || captured.documentId !== session.getSnapshot().document.id) throw new ToolError('STALE_STATE', 'The CAD preview changed. Capture the current view again.');
      const prepared = await preparePreviewCapture(captured.image, { projectId: null, draftVersion: expectedVersion, dirty: captured.dirty, contentSource: 'cad-draft' }, signal);
      try {
        signal.throwIfAborted(); session.assertVersion(expectedVersion); session.assertWorkflowClosed();
        if (viewport.current !== controls || cadViewportVisualIdentity(controls.getState()) !== cadViewportVisualIdentity(captured.viewState)) throw new ToolError('STALE_VIEW', 'The CAD view changed during capture. Capture the current view again.');
      } catch (error) { URL.revokeObjectURL(prepared.previewUrl); throw error; }
      const artifact: CadPreviewArtifact = { ...prepared, fileName: `cad-preview-${captured.image.source}.png`, documentId: captured.documentId, sketchId: captured.sketchId, curveId: captured.curveId, viewState: captured.viewState };
      const previous = previewUrl.current;
      previewUrl.current = artifact.previewUrl; setPreviewArtifact(artifact);
      if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 60_000);
      if (download) {
        try { downloadPreviewCapture(artifact); }
        catch { return { ...artifact, downloadRequested: false, error: { code: 'DOWNLOAD_FAILED', message: 'The CAD PNG is captured. Use the CAD preview PNG link to download it again.' } }; }
      }
      return { ...artifact, downloadRequested: download };
    });
  }
  function exportDocument(expectedVersion = session.getSnapshot().version) {
    editable(expectedVersion); session.assertWorkflowClosed();
    const document = session.getSnapshot().document;
    downloadCadBlob(new Blob([JSON.stringify(document)], { type: 'application/json' }), `${fileBase(document.name)}.cad.json`);
    return { downloadRequested: true, fileName: `${fileBase(document.name)}.cad.json`, version: expectedVersion };
  }
  async function exportSolid(format: 'step' | 'stl', expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed();
    const document = session.getSnapshot().document;
    return run(async () => {
      const blob = await (await getKernel()).export(document, format, signal);
      signal?.throwIfAborted(); session.assertVersion(expectedVersion); session.assertWorkflowClosed();
      const fileName = `${fileBase(document.name)}.${format}`;
      downloadCadBlob(blob, fileName);
      return { downloadRequested: true, fileName, bytes: blob.size, version: expectedVersion };
    });
  }
  async function inspectBuild(expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    editable(expectedVersion); session.assertWorkflowClosed();
    const document = session.getSnapshot().document;
    const result = await (await getKernel()).build(document, signal);
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed();
    publishBuild(result, expectedVersion);
    return result;
  }
  const topology = createCadTopologyActions({
    assertReadable: (expectedVersion, scope) => { editable(expectedVersion); session.assertWorkflowClosed(scope); },
    getDocument: () => session.getSnapshot().document,
    getBuild: () => liveBuild.current,
    getKernel
  });
  function inspectTopology(request: CadTopologyInspectRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
    return inputToken === undefined ? topology.inspect(request, expectedVersion, signal, scope)
      : featureInputCoordinator.inspect(request, expectedVersion, signal, scope, inputToken);
  }
  function resolveTopologyPicks(request: CadTopologyResolvePicksRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
    return inputToken === undefined ? topology.resolve(request, expectedVersion, signal, scope)
      : featureInputCoordinator.resolve(request, expectedVersion, signal, scope, inputToken);
  }
  function topologyAdjacency(request: CadTopologyAdjacencyRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
    return inputToken === undefined ? topology.adjacency(request, expectedVersion, signal, scope)
      : featureInputCoordinator.adjacency(request, expectedVersion, signal, scope, inputToken);
  }
  function topologyTangentChain(request: CadTopologyTangentChainRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
    return inputToken === undefined ? topology.tangentChain(request, expectedVersion, signal, scope)
      : featureInputCoordinator.tangentChain(request, expectedVersion, signal, scope, inputToken);
  }
  async function inspectSection(request: CadSectionRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'section' | 'dxf-export') {
    editable(expectedVersion); session.assertWorkflowClosed(scope);
    signal?.throwIfAborted();
    const section = { ...parseCadSectionRequest(request) };
    const document = session.getSnapshot().document;
    const result = await (await getKernel()).section(document, section, signal);
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(scope);
    return matchingSectionResult(result, section, document.parameters);
  }
  type CamSource = { kind: 'sketch'; sketchId: string } | { kind: 'section'; section: CadSectionRequest };
  async function prepareHandoffGeometry(source: CamSource, document: CadDocument, signal?: AbortSignal) {
    const { cadSketchToCam, cadEntitiesToCam } = await import('@/domain/cad/cadCam');
    if (source.kind === 'sketch') return { path: cadSketchToCam(document, source.sketchId), sourceReceipt: { sketchId: source.sketchId } };
    const section = matchingSectionResult(await (await getKernel()).section(document, source.section, signal), source.section, document.parameters);
    return { path: cadEntitiesToCam(section.entities, document), sourceReceipt: { section: {
      bodyId: section.bodyId, plane: section.plane, offset: section.offset, contourCount: section.contourCount
    } } };
  }
  async function handoffToCam(source: CamSource, expectedVersion: string, signal?: AbortSignal, scope?: 'section') {
    editable(expectedVersion); session.assertWorkflowClosed(scope); assertCanSwitch();
    const workbench = connected();
    const reviewed = session.getSnapshot();
    return run(async () => {
      // Send finishes the section dialog's editing phase. The synchronous shared
      // operation lock stays held until both persistence operations return.
      if (scope) session.setWorkflowOpen(false, scope);
      let committed = false;
      try {
        const [{ path, sourceReceipt }, { importPortableUpidProject }, { loadEditorProgram }] = await Promise.all([
          prepareHandoffGeometry(source, reviewed.document, signal), import('@/domain/upid/portableUpidProject'), import('@/domain/editor/loadEditorProgram')
        ]);
        signal?.throwIfAborted(); session.assertVersion(expectedVersion); session.assertWorkflowClosed();
        if (current.current.app.connectedWorkbench !== workbench) throw new ToolError('STALE_STATE', 'Workbench changed before CAM handoff.');
        if (reviewed.dirty) await persistReviewed(workbench, expectedVersion, signal);
        const savedVersion = session.getSnapshot().savedVersion;
        const value = await current.current.app.runAgentWorkbenchOperation(async latest => {
          signal?.throwIfAborted(); session.assertVersion(expectedVersion);
          const imported = await importPortableUpidProject(latest, {
            fileName: `${fileBase(reviewed.document.name)}.upid.json`,
            text: JSON.stringify({ format: 'upid', schemaVersion: path.schemaVersion, document: path }),
            beforeWrite: () => {
              signal?.throwIfAborted(); session.assertVersion(expectedVersion); session.assertWorkflowClosed();
              if (current.current.app.connectedWorkbench !== workbench) throw new ToolError('STALE_STATE', 'Workbench changed before CAM handoff.');
            }
          });
          if (!imported.ok) throw new ToolError(imported.error.code, imported.error.message);
          const loaded = await loadEditorProgram(imported.workbench, imported.project.id);
          return { workbench: imported.workbench, ...(loaded.ok ? { editorProgram: loaded.editorProgram } : {}),
            value: { projectId: imported.project.id, opened: loaded.ok, sourceDocumentId: reviewed.document.id,
              sourceSavedVersion: savedVersion, ...sourceReceipt, ...(loaded.ok ? {} : { error: loaded.error.message }) } };
        });
        committed = true;
        if (value.opened) changeOpen(false);
        else setErrorMessage(`CAM project "${value.projectId}" was created, but could not open. Return to Workbench and open it from Projects. ${value.error ?? ''}`.trim());
        return value;
      } finally { if (scope && !committed) session.setWorkflowOpen(true, scope); }
    });
  }
  function sendToCam(sketchId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal) {
    return handoffToCam({ kind: 'sketch', sketchId }, expectedVersion, signal);
  }
  function sendSectionToCam(request: CadSectionRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'section') {
    return handoffToCam({ kind: 'section', section: { ...parseCadSectionRequest(request) } }, expectedVersion, signal, scope);
  }
  async function exportDxf(sketchId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'dxf-export') {
    editable(expectedVersion); session.assertWorkflowClosed(scope);
    const { cadSketchToDxf } = await import('@/domain/cad/cadCam');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(scope);
    const document = session.getSnapshot().document;
    const text = cadSketchToDxf(document, sketchId);
    const fileName = `${fileBase(document.name)}.dxf`;
    downloadCadBlob(new Blob([text], { type: 'application/dxf' }), fileName);
    return { fileName, downloadRequested: true, sketchId, version: expectedVersion };
  }
  async function exportCurveDxf(curveId: string, expectedVersion = session.getSnapshot().version, signal?: AbortSignal, scope?: 'dxf-export') {
    editable(expectedVersion); session.assertWorkflowClosed(scope);
    const { cadCurveToDxf } = await import('@/domain/cad/cadCurveDxf');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(scope);
    const document = session.getSnapshot().document;
    const text = cadCurveToDxf(document, curveId);
    const fileName = `${fileBase(document.name)}.dxf`;
    downloadCadBlob(new Blob([text], { type: 'application/dxf' }), fileName);
    return { fileName, downloadRequested: true, curveId, version: expectedVersion };
  }
  async function exportSectionDxf(request: CadSectionRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'dxf-export') {
    editable(expectedVersion); session.assertWorkflowClosed(scope); signal?.throwIfAborted();
    const document = session.getSnapshot().document;
    const section = await inspectSection(request, expectedVersion, signal, scope);
    const { cadEntitiesToDxf } = await import('@/domain/cad/cadDxfExport');
    signal?.throwIfAborted(); editable(expectedVersion); session.assertWorkflowClosed(scope);
    const notes = document.features.flatMap(feature => feature.kind === 'sketch' && cadFeatureActive(feature, document)
      ? feature.profiles.flatMap(profile => !profile.construction && profile.geometry.kind === 'plugin'
        ? [`${profile.geometry.package.id}@${profile.geometry.package.version}: ${profile.geometry.package.notes}`] : []) : []);
    const text = cadEntitiesToDxf(section.entities, notes);
    const fileName = `${fileBase(document.name)}-section-${section.plane}.dxf`;
    downloadCadBlob(new Blob([text], { type: 'application/dxf' }), fileName);
    return { fileName, downloadRequested: true, version: expectedVersion, section: {
      bodyId: section.bodyId, plane: section.plane, offset: section.offset, contourCount: section.contourCount, entityCount: section.entities.length
    } };
  }
  function back() { connected(); session.assertWorkflowClosed(); changeOpen(false); }
  const isBusy = () => busy.current || preparing.current !== null;
  return { session, snapshot, sketchEditing, sketchWarnings, open, enter, edit, preparePreviewEdits, save, list, projectActions, plugins, installPlugin, showLibrary, library, libraryLoading, libraryDiagnostic, closeLibrary,
    openDocument, newDocument, importDocument, importDocumentValue, importSolidSource, importDxfSource, importDxfCurveSource, importFile, confirmImport, cancelImport, measureSketch, inspectSketchConstraints, inspectSketchHandles, measureCurve, inspectSketchRegions, readSketchRegionReference, inspectPlugin, inspectParameters, inspectPlane, inspectLoft, inspectSweep, exportDocument, exportSolid, exportDxf, exportCurveDxf, exportSectionDxf, inspectBuild, inspectSection, sendSectionToCam, sendToCam, back,
    setViewportControls, readViewport: (expectedVersion: string) => getViewport(expectedVersion).getState(), changeViewport, captureViewport, previewArtifact,
    inspectTopology, resolveTopologyPicks, topologyAdjacency, topologyTangentChain, buildFeatureInput: featureInputCoordinator.build, releaseFeatureInput,
    build, buildVersion, buildState, featurePreview, previewFeature: featurePreviewCoordinator.update, errorMessage, setErrorMessage, storageBusy, isBusy, isOpen: () => current.current.open,
    undo: (expected?: string) => { editable(expected); session.undo(expected); },
    redo: (expected?: string) => { editable(expected); session.redo(expected); }
  };
}
export type CadController = ReturnType<typeof useCadController>;
