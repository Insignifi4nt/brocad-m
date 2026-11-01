import { createMemoryRouter, RouterProvider, useInRouterContext } from 'react-router';
import { useWorkbenchRoutes } from '@/app/useWorkbenchRoutes';
import { Button } from '@/components/ui/button';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CadSession, hasUnsavedCadDraft } from '@/features/cad/cadSession';
import { useCadController } from '@/features/cad/useCadController';
import { cadSiteTools } from '@/features/cad/cadSiteTools';
import { cadVisibleBodyIds } from '@/domain/cad/cadSchema';
import { CadLibraryDialog } from '@/features/cad/CadLibraryDialog';
import { CadWorkspaceBoundary } from '@/features/cad/CadWorkspaceBoundary';
import { useSiteTools } from '@/features/webmcp/siteTools';
import { workbenchSiteTools, type DraftReadSnapshot, type WorkbenchToolState } from '@/features/webmcp/workbenchSiteTools';
import { useWorkbenchActions } from '@/features/webmcp/useWorkbenchActions';
import { AgentActivity } from '@/features/webmcp/AgentActivity';

import { AppShell } from '@/app/AppShell';
import { type AppServices } from '@/app/appServices';
import { useWorkbenchAppController } from '@/app/useWorkbenchAppController';
import { StatusToastList } from '@/components/StatusToasts';
import { RecoveryExportPanel } from '@/app/RecoveryExportPanel';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { DxfImportConfirmationDialog } from '@/features/dashboard/DxfImportConfirmationDialog';

interface AppProps {
  services?: Partial<AppServices>;
}

const EditorPage = lazy(() => import('@/features/editor/EditorPage').then(({ EditorPage }) => ({ default: EditorPage })));
const CadWorkbench = lazy(() => import('@/features/cad/CadWorkbench').then(({ CadWorkbench }) => ({ default: CadWorkbench })));
const CadSectionDialog = lazy(() => import('@/features/cad/CadSectionDialog').then(({ CadSectionDialog }) => ({ default: CadSectionDialog })));
const CadDxfExportDialog = lazy(() => import('@/features/cad/CadDxfExportDialog').then(({ CadDxfExportDialog }) => ({ default: CadDxfExportDialog })));
const CadImportDialog = lazy(() => import('@/features/cad/CadImportDialog').then(({ CadImportDialog }) => ({ default: CadImportDialog })));

export default function App(props: AppProps = {}) {
  return useInRouterContext() ? <WorkbenchApp {...props} /> : <StandaloneWorkbench {...props} />;
}
function StandaloneWorkbench(props: AppProps) {
  const [router] = useState(() => createMemoryRouter([{ path: '*', element: <WorkbenchApp {...props} /> }]));
  return <RouterProvider router={router} />;
}
function WorkbenchApp({ services }: AppProps) {
  const draftRead = useRef<DraftReadSnapshot | null>(null);
  const [cadSession] = useState(() => new CadSession());
  const [cadOpen, setCadOpen] = useState(false);
  const [cadSection, setCadSection] = useState<{ bodyId: string; version: string } | null>(null);
  const [cadDxfExport, setCadDxfExport] = useState<{ version: string } | null>(null);
  const cadOpenRef = useRef(cadOpen); cadOpenRef.current = cadOpen;
  const app = useWorkbenchAppController(services, () => cadOpenRef.current ? {
    dirty: cadSession.getSnapshot().dirty, workflowOpen: cadSession.getSnapshot().workflowOpen,
    version: cadSession.getSnapshot().version
  } : draftRead.current);
  const cad = useCadController(app, cadSession, cadOpen, setCadOpen, () => draftRead.current);
  const navigation = useWorkbenchRoutes(app, cad, () => draftRead.current, () => { draftRead.current = null; });
  const cadRef = useRef(cad); cadRef.current = cad;
  useEffect(() => { if (app.activeView === 'editor') setCadOpen(false); }, [app.activeView, app.editorProgramRevision]);
  const agentActions = useWorkbenchActions(app, draftRead, cad.isBusy);
  const updateDraftRead = useCallback((snapshot: DraftReadSnapshot | null) => { draftRead.current = snapshot; }, []);
  const toolState = useRef<WorkbenchToolState>({ workbench: null, draft: null, busy: false });
  useLayoutEffect(() => { toolState.current = { workbench: app.connectedWorkbench, draft: null, busy: app.workbenchInteractionLocked, recovery: app.recoveryControls?.source ?? null }; });
  const agentActivity = useSiteTools([...workbenchSiteTools(() => ({ ...toolState.current, draft: draftRead.current,
    busy: agentActions.isBusy() || cad.isBusy() })), ...agentActions.tools, ...cadSiteTools(() => cadRef.current)]);
  const planningMachineId = app.connectedWorkbench?.manifest.preferences.recentPlanningMachineId;
  const planningMachine = app.connectedWorkbench?.machines.machines.find(
    ({ id }) => id === planningMachineId
  ) ?? null;

  function closeCadDxfExport() { setCadDxfExport(null); cadSession.setWorkflowOpen(false, 'dxf-export'); }
  function closeCadSection() { setCadSection(null); cadSession.setWorkflowOpen(false, 'section'); }
  function switchStorage(action: () => Promise<void>) {
    try {
      const currentCad = cadRef.current;
      if (currentCad.isOpen() || currentCad.isBusy() || app.workbenchInteractionLocked || app.activeView === 'editor') throw new Error('Return to the dashboard and finish the running workflow before switching storage.');
      cadSession.assertStorageSwitchAllowed();
      return action();
    } catch (error) { app.showStatusToast(error instanceof Error ? error.message : 'Cannot switch storage.', 'error'); }
  }

  return (
    <AppShell
      showDashboardBrand={app.activeView === 'dashboard' && !cadOpen}
      routeSettingsSection={navigation.settingsSection} onRouteSettingsSection={navigation.openSettings} onCloseRouteSettings={navigation.closeSettings}
      recovery={app.recoveryControls}
      agentPanelContent={<><AgentActivity activity={agentActivity} onRefresh={agentActivity.refresh} /><div className="mt-3">{agentActions.attachControl}</div>{agentActions.previewControl && <div className="mt-3 border-t border-border pt-2">{agentActions.previewControl}</div>}{cad.previewArtifact && <a className="mt-3 block text-xs text-primary underline" href={cad.previewArtifact.previewUrl} download={cad.previewArtifact.fileName}>CAD preview PNG</a>}</>}
      connectedWorkbench={app.connectedWorkbench}
      errorMessage={app.errorMessage}
      interactionLocked={app.workbenchInteractionLocked || cad.storageBusy}
      onConnectWorkbench={() => switchStorage(app.handleConnectWorkbench)}
      onUseBrowserCache={() => switchStorage(app.handleUseBrowserCache)}
      onActivateMachineSetup={app.handleActivateMachineSetup}
      onCommitMachinePackage={app.handleCommitMachinePackage}
      onPrepareMachinePackage={app.handlePrepareMachinePackage}
      onRemoveMachineDefinition={app.handleRemoveMachineDefinition}
      onSaveCatalogPreferences={app.handleSaveCatalogPreferences}
      settingsErrorMessage={app.settingsErrorMessage}
      settingsStatus={app.settingsStatus}
      statusNotifications={app.statusNotifications}
      storageActionLabel={app.storageActionLabel}
      storageSwitchDisabled={cadOpen || app.activeView === 'editor' || app.workbenchInteractionLocked || cad.storageBusy || (hasUnsavedCadDraft(cad.snapshot))}
      storageSwitchDisabledReason={app.workbenchInteractionLocked || cad.storageBusy ? 'Wait for the running workbench operation to finish.'
        : cadOpen || app.activeView === 'editor' ? 'Save or discard pending edits, then return to the dashboard before switching storage or restoring files.'
        : hasUnsavedCadDraft(cad.snapshot) ? 'Save or discard the retained CAD draft before switching storage or restoring files.' : undefined}
      storageWarningMessage={app.storageWarningMessage}
      workbenchStatus={app.workbenchStatus}
    >
      <StatusToastList onDismiss={app.dismissStatusToast} toasts={app.statusToasts} />
      {app.dxfReimportStatus === 'importing' && !app.pendingDxfReimport && (
        <div className="fixed left-1/2 top-14 z-50 flex -translate-x-1/2 items-center gap-3 border border-border bg-background p-3 text-xs" role="status">
          Preparing DXF unit review…
          <Button variant="outline" className="px-2 py-1" onClick={app.handleCancelDxfReimport} type="button">Cancel DXF preparation</Button>
        </div>
      )}
      {app.workbenchStatus === 'error' && !app.connectedWorkbench ? (
        <section className="grid h-full place-items-center p-6" role="alert">
          <div className="max-w-2xl border border-destructive bg-destructive/10 p-4 font-mono text-xs text-destructive">
            <h1 className="mb-2 font-sans text-sm font-semibold">Workbench could not be opened</h1>
            <p>{app.errorMessage ?? 'The workbench failed without a diagnostic.'}</p>
            <div className="mt-4 text-foreground"><RecoveryExportPanel recovery={app.recoveryControls} disabled={app.workbenchInteractionLocked} /></div>
          </div>
        </section>
      ) : navigation.error ? (
        <section className="m-auto grid max-w-lg gap-3 p-6 text-sm" aria-label="Page unavailable">
          <h1 className="font-semibold">Unable to open this page</h1><p role="alert">{navigation.error}</p>
          <Button variant="outline" onClick={() => { void navigation.home(); }}>Back to projects</Button>
        </section>
      ) : cadOpen && app.connectedWorkbench ? (
        <CadWorkspaceBoundary documentName={cad.snapshot.document.name} busy={cad.storageBusy || app.workbenchInteractionLocked}
          onSave={cad.save} onDownloadDocument={cad.exportDocument}
          onFailure={() => { cad.cancelImport(); closeCadSection(); closeCadDxfExport(); }}>
        <Suspense fallback={<p className="p-4 text-xs" role="status">Opening CAD workspace…</p>}>
          <CadWorkbench
            document={cad.sketchEditing.snapshot.document} documentVersion={cad.sketchEditing.snapshot.version} build={cad.build} buildVersion={cad.buildVersion} buildState={cad.buildState}
            featurePreview={cad.featurePreview} onFeaturePreview={cad.sketchEditing.sketchId ? undefined : cad.previewFeature}
            dirty={cad.sketchEditing.snapshot.dirty} canUndo={cad.sketchEditing.snapshot.canUndo} canRedo={cad.sketchEditing.snapshot.canRedo}
            errorMessage={cad.errorMessage} onStatusMessage={app.showStatusToast} storageBusy={cad.storageBusy || app.workbenchInteractionLocked}
            onEdit={(edit, signal) => cad.sketchEditing.sketchId ? cad.sketchEditing.edit([edit], signal) : cad.edit([edit], undefined, false, signal)}
            onUndo={() => cad.sketchEditing.sketchId ? cad.sketchEditing.undo() : cad.undo()} onRedo={() => cad.sketchEditing.sketchId ? cad.sketchEditing.redo() : cad.redo()}
            onEditMany={(edits, signal) => cad.sketchEditing.sketchId ? cad.sketchEditing.edit(edits, signal) : cad.edit(edits, undefined, false, signal)}
            onPrepareEdits={cad.sketchEditing.sketchId ? cad.sketchEditing.prepare : cad.preparePreviewEdits}
            onInspectSketchConstraints={cad.sketchEditing.sketchId ? cad.sketchEditing.inspect : cad.inspectSketchConstraints}
            sketchAnalysisReady={cad.sketchEditing.analysisReady} sketchWarnings={cad.sketchWarnings}
            onWorkflowChange={cad.sketchEditing.setWorkflowOpen}
            onBeginSketchEdit={cad.sketchEditing.begin}
            sketchEdit={cad.sketchEditing.sketchId ? { sketchId: cad.sketchEditing.sketchId, inspectAreaRepairs: cad.sketchEditing.inspectAreaRepairs, finish: cad.sketchEditing.finish, cancel: cad.sketchEditing.cancel } : undefined}
            onBack={cad.back} onSave={async () => { await cad.save(); }}
            onOpenDocument={() => { void cad.showLibrary().catch(error => cad.setErrorMessage(String(error))); }}
            onNewDocument={() => { cad.newDocument(); }} onImportDocument={async file => { await cad.importDocument(file); }}
            onListPlugins={cad.plugins} onInstallPlugin={text => cad.installPlugin(text, cad.snapshot.version, undefined, 'editor')}
            onExportDocument={() => { cad.exportDocument(); }}
            onExportSolid={async format => { await cad.exportSolid(format); }}
            externalWorkflowOpen={Boolean(cadDxfExport || cadSection || cad.library)}
            onOpenDxfExport={() => {
              cadSession.assertWorkflowClosed();
              cadSession.setWorkflowOpen(true, 'dxf-export');
              setCadDxfExport({ version: cadSession.getSnapshot().version });
            }}
            onRebuild={async () => { await cad.inspectBuild(); }}
            onSendToCam={async sketchId => { await cad.sendToCam(sketchId); }}
            onViewportControlsReady={cad.setViewportControls}
            onInspectTopology={(request, version, signal) => cad.inspectTopology(request, version, signal, 'editor')}
            onResolveSelection={(request, version, signal) => cad.resolveTopologyPicks(request, version, signal, 'editor')}
            onTopologyAdjacency={(request, version, signal) => cad.topologyAdjacency(request, version, signal, 'editor')}
            onTopologyTangentChain={(request, version, signal) => cad.topologyTangentChain(request, version, signal, 'editor')}
            featureInputPicking={{
              build: (request, version, signal) => cad.buildFeatureInput(request, version, signal, 'editor'),
              inspect: (token, request, version, signal) => cad.inspectTopology(request, version, signal, 'editor', token),
              resolve: (token, request, version, signal) => cad.resolveTopologyPicks(request, version, signal, 'editor', token),
              adjacency: (token, request, version, signal) => cad.topologyAdjacency(request, version, signal, 'editor', token),
              tangentChain: (token, request, version, signal) => cad.topologyTangentChain(request, version, signal, 'editor', token),
              release: cad.releaseFeatureInput,
            }}
            onCaptureViewport={async () => { await cad.captureViewport(cad.snapshot.version, true); }}
            onSectionForCam={bodyId => {
              cadSession.assertWorkflowClosed();
              cadSession.setWorkflowOpen(true, 'section');
              setCadSection({ bodyId, version: cadSession.getSnapshot().version });
            }}
          />
          {cadDxfExport && <Suspense fallback={<div className="cad-export-loading" role="status">Opening DXF export...</div>}><CadDxfExportDialog document={cad.snapshot.document} version={cadDxfExport.version} currentVersion={cad.snapshot.version}
            bodies={cad.buildState === 'ready' && cad.buildVersion === cad.snapshot.version ? cad.build?.meshes.filter(mesh => cadVisibleBodyIds(cad.snapshot.document.features, cad.snapshot.document).includes(mesh.featureId)) ?? [] : []}
            onClose={closeCadDxfExport}
            onExportSketch={(id, version, signal) => cad.exportDxf(id, version, signal, 'dxf-export')}
            onExportCurve={(id, version, signal) => cad.exportCurveDxf(id, version, signal, 'dxf-export')}
            onInspectSection={(request, version, signal) => cad.inspectSection(request, version, signal, 'dxf-export')}
            onExportSection={(request, version, signal) => cad.exportSectionDxf(request, version, signal, 'dxf-export')} /></Suspense>}
          {cadSection && <CadSectionDialog bodies={cad.build?.meshes ?? []} initialBodyId={cadSection.bodyId} version={cadSection.version}
            onClose={closeCadSection}
            onInspect={(request, version, signal) => cad.inspectSection(request, version, signal, 'section')}
            onSend={(request, version, signal) => cad.sendSectionToCam(request, version, signal, 'section')} />}
          {cad.importFile && <CadImportDialog file={cad.importFile.file} onImport={cad.confirmImport} onCancel={cad.cancelImport} />}
        </Suspense>
        </CadWorkspaceBoundary>
      ) : app.activeView === 'editor' && app.connectedWorkbench ? (
        <Suspense fallback={<p className="p-4 text-xs text-muted-foreground" role="status">Opening editor…</p>}><EditorPage
          importErrorMessage={app.editorImportErrorMessage}
          onReadSnapshot={updateDraftRead}
          importStatus={app.editorImportStatus}
          interactionLocked={app.workbenchInteractionLocked || cad.storageBusy}
          key={`${app.loadedEditorProgram?.filePath ?? 'empty-editor'}:${app.editorProgramRevision}`}
          machines={app.connectedWorkbench.machines.machines}
          posts={app.connectedWorkbench.posts}
          onBackToDashboard={app.handleBackToDashboard}
          onDownloadEditorFile={(fileName, text) => app.handleDownloadEditorFile({ fileName, text })}
          onGenerateControllerArtifact={app.handleGenerateControllerArtifact}
          onImportProgramFile={app.handleImportExternalProgram}
          onReimportDxfUnits={
            app.loadedEditorProgram?.project.source.kind === 'dxf'
              ? app.handlePrepareDxfReimport
              : undefined
          }
          onSaveEditorDraft={async (draft) => { await app.handleSaveEditorDraft(draft); }}
          onStatusMessage={app.showStatusToast}
          planningMachine={planningMachine}
          program={app.loadedEditorProgram}
          saveErrorMessage={app.editorSaveErrorMessage}
          saveStatus={app.editorSaveStatus}
        /></Suspense>
      ) : (
        <DashboardPage
          dxfWriting={app.dxfWriting}
          dxfImportCancellable={app.dxfImportCancellable}
          connectedWorkbench={app.connectedWorkbench}
          importErrorMessage={app.importErrorMessage}
          importStatus={app.importStatus}
          interactionLocked={app.workbenchInteractionLocked || cad.storageBusy}
          latestImport={app.latestImport}
          onCancelDxfImport={app.handleCancelDxfImport}
          onConfirmDxfImport={app.handleConfirmDxfImport}
          onDeleteProject={app.handleDeleteWorkbenchProject}
          onDeleteSavedRevisions={app.handleDeleteSavedRevisions}
          onRestoreProject={app.handleRestoreWorkbenchProject}
          onPurgeArchivedProject={app.handlePurgeArchivedWorkbenchProject}
          onDxfImportOverrideAcknowledgedChange={app.handleDxfImportOverrideAcknowledgedChange}
          onDxfImportUnitCandidateChange={app.handleDxfImportUnitCandidateChange}
          onExportUpidProject={app.handleExportUpidProject}
          onSaveUpidProjectAs={app.handleSaveUpidProjectAs}
          onImportDxfFile={app.handleImportDxfFile}
          onImportProgramFile={app.handleImportExternalProgram}
          onImportUpidFile={app.handleImportUpidFile}
          onOpenEditor={app.handleOpenEditor}
          onOpenCad={() => { try { cad.enter(); } catch (error) { app.showStatusToast(String(error), 'error'); } }}
          onOpenLatestImportInEditor={app.handleOpenLatestImportInEditor}
          onOpenProject={async id => { await app.handleOpenWorkbenchProject(id); }}
          onOpenCadProject={navigation.openCadProject}
          cadLibraryVersion={cad.snapshot.savedVersion ?? cad.snapshot.version}
          cadProjectActions={cad.projectActions}
          onStatusMessage={app.showStatusToast}
          onRenameProject={app.handleRenameWorkbenchProject}
          pendingDxfImport={app.pendingDxfImport}
          programImportErrorMessage={app.editorImportErrorMessage}
          programImportStatus={app.editorImportStatus}
          workbenchStatus={app.workbenchStatus}
        />
      )}
      {navigation.loading && <div role="status" className="pointer-events-none absolute bottom-3 left-3 rounded border border-border bg-card px-3 py-2 text-xs">Opening project…</div>}
      {cad.library && <CadLibraryDialog entries={cad.library} diagnostic={cad.libraryDiagnostic} busy={cad.storageBusy} loading={cad.libraryLoading}
        onClose={cad.closeLibrary} onOpen={async id => { await cad.openDocument(id, cad.snapshot.version, undefined, 'library'); }} />}
      {app.pendingDxfReimport && (
        <DxfImportConfirmationDialog
          cancellationBlocked={app.dxfWriting}
          declaredUnitOverrideAcknowledged={app.pendingDxfReimport.declaredUnitOverrideAcknowledged}
          errorMessage={app.dxfReimportErrorMessage}
          mode="reimport"
          onCancel={app.handleCancelDxfReimport}
          onConfirm={app.handleConfirmDxfReimport}
          onOverrideAcknowledgedChange={app.handleDxfReimportOverrideAcknowledgedChange}
          onRebuildAcknowledgedChange={app.handleDxfReimportRebuildAcknowledgedChange}
          onUnitCandidateChange={app.handleDxfReimportUnitCandidateChange}
          planningMachineFit={app.pendingDxfReimport.planningMachineFit}
          preparationResult={{ ok: true, preparation: app.pendingDxfReimport.preparation }}
          previewResult={app.pendingDxfReimport.previewResult}
          rebuildAcknowledged={app.pendingDxfReimport.rebuildAcknowledged}
          rebuildRequired={app.pendingDxfReimport.rebuildRequired}
          selectedUnitCandidateId={app.pendingDxfReimport.selectedUnitCandidateId}
          submitting={app.dxfReimportStatus === 'importing'}
        />
      )}
      {agentActions.importControl}
    </AppShell>
  );
}
