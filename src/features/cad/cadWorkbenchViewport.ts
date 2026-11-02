import { Value } from '@sinclair/typebox/value';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import type { CadDocument, CadMesh, CadPlane, CadSketchPlane } from '@/domain/cad/cadDocument';
import { cadFeatureProducesBody } from '@/domain/cad/cadSchema';
import { CadError } from '@/domain/cad/cadError';
import { parseCadTopologyPickSet, type CadTopologyPickSet } from '@/domain/cad/cadTopology';
import { ToolError } from '@/features/webmcp/siteTools';
import { CadViewportCommandSchema, cadViewportVisualIdentity, type CadSketchGraphSelection, type CadRenderedViewControls, type CadViewportCapture, type CadViewportState, type CadWorkbenchViewportControls } from './cadViewportControls';
import { validateTopologySelection, type CadPickMode } from './cadTopologyPicking';
import { cadSketchGraphSelectionSet } from './cadSketchGraphSelection';
import type { CadSectionView } from './view/cadViewState';
import { cadSameReferencePlane } from './cadViewportReferences';
import { cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

export interface CadViewportBindings extends Omit<CadViewportState, 'documentId' | 'view' | 'selectedSketchGeometry'> {
  readonly document: CadDocument;
  readonly rendered: CadRenderedViewControls | null;
  readonly meshes: readonly CadMesh[];
  /** Sorted unique feature IDs expected in the current world-space reference layer. */
  readonly visibleReferenceIds: readonly string[];
  readonly visibleReferencePlanes: readonly CadPlane[];
  selectFeature(id: string | null): void;
  selectReferencePlane(plane: CadSketchPlane | null): void;
  /** Sets or clears the part view's section through the same operation as the view controls. */
  setSection?(section: CadSectionView | null): void;
  editSketch(id: string): void;
  editCurve(id: string): void;
  selectProfile(id: string | null): void;
  selectSketchGeometrySet(selections: readonly CadSketchGraphSelection[]): void;
  finishSketch(): void;
  finishCurve(): void;
  selectTopology(selection: CadTopologyPickSet | null, additive: boolean): void;
  setPickMode(mode: CadPickMode): void;
  updateView(action: () => void): void;
}

/** UI and agent requests share the same workflow, identity and rendered-source checks. */
export function createCadWorkbenchViewportControls(getBindings: () => CadViewportBindings): CadWorkbenchViewportControls {
  function readable() {
    const bindings = getBindings();
    if (bindings.workflowOpen) throw new ToolError('WORKFLOW_OPEN', 'Apply or cancel the current CAD edit before controlling or capturing the viewport.');
    if (bindings.busy) throw new ToolError('BUSY', 'Wait for the running CAD operation.');
    return bindings;
  }
  function getState(): CadViewportState {
    const bindings = getBindings();
    const selectedSketchGeometrySet = Object.freeze(bindings.selectedSketchGeometrySet.map(selection => Object.freeze({ kind: selection.kind, id: selection.id })));
    return Object.freeze({ documentId: bindings.document.id, documentVersion: bindings.documentVersion, dirty: bindings.dirty,
      selectedFeatureId: bindings.selectedFeatureId, selectedProfileId: bindings.selectedProfileId, sketchId: bindings.sketchId, curveId: bindings.curveId,
      selectedSketchGeometrySet,
      ...(selectedSketchGeometrySet.length === 1 ? { selectedSketchGeometry: selectedSketchGeometrySet[0] } : {}),
      selectedReferencePlane: typeof bindings.selectedReferencePlane === 'object' && bindings.selectedReferencePlane !== null ? Object.freeze({ ...bindings.selectedReferencePlane }) : bindings.selectedReferencePlane,
      ...(bindings.selectedOrigin ? { selectedOrigin: Object.freeze({ ...bindings.selectedOrigin }) } : {}),
      section: bindings.section ? Object.freeze({ ...bindings.section, plane: typeof bindings.section.plane === 'string' ? bindings.section.plane : Object.freeze({ ...bindings.section.plane }) }) : null,
      awaitingSketchPlane: bindings.awaitingSketchPlane,
      workflowOpen: bindings.workflowOpen, busy: bindings.busy, buildVersion: bindings.buildVersion,
      buildId: bindings.buildId, pickMode: bindings.pickMode, topologySelection: bindings.topologySelection ? parseCadTopologyPickSet(bindings.topologySelection) : null,
      buildState: bindings.buildState, visibleBodyIds: Object.freeze([...bindings.visibleBodyIds]), view: bindings.rendered?.getState() ?? null });
  }
  function referencesInstalled(bindings: CadViewportBindings, state: CadViewportState): boolean {
    if (state.view?.mode !== 'solid') return true;
    const installed = state.view.referenceFeatureIds;
    return installed !== undefined && state.view.referenceVersion === bindings.documentVersion
      && installed.length === bindings.visibleReferenceIds.length
      && installed.every((id, index) => id === bindings.visibleReferenceIds[index])
      && JSON.stringify(state.view.referencePlanes ?? []) === JSON.stringify(bindings.visibleReferencePlanes);
  }
  return {
    getState,
    apply(command) {
      if (!Value.Check(CadViewportCommandSchema, command)) throw new ToolError('INVALID_INPUT', 'Invalid CAD viewport command.');
      const bindings = readable();
      const rendered = bindings.rendered;
      bindings.updateView(() => {
        switch (command.kind) {
          case 'select-feature':
            if (command.featureId !== null && !bindings.document.features.some((feature) => feature.id === command.featureId)) throw new ToolError('NOT_FOUND', 'Feature does not exist in the current CAD draft.');
            bindings.selectFeature(command.featureId); return;
          case 'select-reference-plane': {
            if (bindings.sketchId || bindings.curveId) throw new ToolError('WRONG_VIEW', 'Finish sketch or curve editing before selecting a reference plane.');
            const plane = command.plane;
            if (typeof plane === 'object' && plane !== null && !bindings.document.features.some(feature => feature.id === plane.featureId && feature.kind === 'datum-plane' && cadFeatureActive(feature, bindings.document))) throw new ToolError('NOT_FOUND', 'Choose an active datum plane in the current CAD draft.');
            bindings.selectReferencePlane(plane); return;
          }
          case 'edit-sketch':
            if (!bindings.document.features.some((feature) => feature.kind === 'sketch' && feature.id === command.sketchId && cadFeatureActive(feature, bindings.document))) throw new ToolError('NOT_FOUND', 'Choose an active sketch in the current CAD draft.');
            bindings.editSketch(command.sketchId); return;
          case 'edit-curve':
            if (!bindings.document.features.some((feature) => feature.kind === 'curve' && feature.id === command.curveId && cadFeatureActive(feature, bindings.document))) throw new ToolError('NOT_FOUND', 'Choose an active curve in the current CAD draft.');
            bindings.editCurve(command.curveId); return;
          case 'select-profile': {
            const sketch = bindings.document.features.find((feature) => feature.kind === 'sketch' && feature.id === bindings.sketchId);
            if (sketch?.kind !== 'sketch') throw new ToolError('WRONG_VIEW', 'Open the sketch editor before selecting a profile.');
            if (command.profileId !== null && !cadSketchProfileViews(sketch).some((profile) => profile.id === command.profileId)) throw new ToolError('NOT_FOUND', 'Profile does not exist in the active sketch.');
            bindings.selectProfile(command.profileId); return;
          }
          case 'select-sketch-geometry':
          case 'select-sketch-geometry-set': {
            const sketch = bindings.document.features.find(feature => feature.kind === 'sketch' && feature.id === bindings.sketchId && cadFeatureActive(feature, bindings.document));
            if (sketch?.kind !== 'sketch') throw new ToolError('WRONG_VIEW', 'Open the sketch editor before selecting points or edges.');
            const request = command.kind === 'select-sketch-geometry-set' ? command.selections : command.selection ? [command.selection] : [];
            let selections: readonly CadSketchGraphSelection[];
            try { selections = cadSketchGraphSelectionSet(sketch.graph, request); }
            catch (error) {
              if (error instanceof CadError) throw new ToolError(error.code === 'missing-sketch-selection' ? 'NOT_FOUND' : 'INVALID_INPUT', error.message);
              throw error;
            }
            bindings.selectSketchGeometrySet(selections); return;
          }
          case 'set-sketch-pick-filter': {
            if (bindings.curveId || !bindings.document.features.some(feature => feature.kind === 'sketch' && feature.id === bindings.sketchId && cadFeatureActive(feature, bindings.document))) throw new ToolError('WRONG_VIEW', 'Open an active sketch editor before changing its pick filter.');
            if (!rendered) throw new ToolError('VIEW_UNAVAILABLE', 'Wait for the sketch viewport to load.');
            const view = rendered.getState();
            if (view.mode !== 'sketch') throw new ToolError('WRONG_VIEW', 'Open the sketch viewport before changing its pick filter.');
            if (!view.available || !rendered.setSketchPickFilter) throw new ToolError('VIEW_UNAVAILABLE', 'Wait for sketch picking controls to load.');
            rendered.setSketchPickFilter(command.filter); return;
          }
          case 'finish-sketch':
            if (!bindings.sketchId) throw new ToolError('WRONG_VIEW', 'No sketch editor is open.');
            bindings.finishSketch(); return;
          case 'finish-curve':
            if (!bindings.curveId) throw new ToolError('WRONG_VIEW', 'No curve editor is open.');
            bindings.finishCurve(); return;
          case 'set-pick-mode':
            if (bindings.sketchId || bindings.curveId || !rendered) throw new ToolError('WRONG_VIEW', 'Open the solid viewport before selecting faces or edges.');
            if (bindings.buildState !== 'ready' || bindings.buildVersion !== bindings.documentVersion) throw new ToolError('STALE_STATE', 'Wait for the current CAD draft to finish building before picking topology.');
            bindings.setPickMode(command.mode); return;
          case 'select-topology': {
            if (bindings.sketchId || bindings.curveId || !rendered) throw new ToolError('WRONG_VIEW', 'Open the solid viewport before selecting topology.');
            const selection = parseCadTopologyPickSet(command.selection);
            try { validateTopologySelection(selection, { documentVersion: bindings.documentVersion, buildId: bindings.buildId, meshes: bindings.meshes,
              ready: bindings.buildState === 'ready' && bindings.buildVersion === bindings.documentVersion }); }
            catch (error) { throw new ToolError('STALE_STATE', error instanceof Error ? error.message : 'Select topology from the current build.'); }
            bindings.selectTopology(selection, command.additive); return;
          }
          case 'clear-topology': bindings.selectTopology(null, false); return;
          case 'set-section': {
            if (bindings.sketchId || bindings.curveId) throw new ToolError('WRONG_VIEW', 'Finish sketch or curve editing before changing the section view; an open sketch shows its own cut.');
            if (!bindings.setSection || !rendered) throw new ToolError('VIEW_UNAVAILABLE', 'Wait for the solid viewport to load.');
            if (!command.on) { bindings.setSection(null); return; }
            // The selected plane, or the section's own plane to change only its side or caps.
            const plane = bindings.selectedReferencePlane ?? bindings.section?.plane ?? null;
            if (!plane) throw new ToolError('INVALID_INPUT', 'Select an origin or datum plane with select-reference-plane before turning the section view on.');
            if (typeof plane === 'object' && !bindings.document.features.some(feature => feature.id === plane.featureId && feature.kind === 'datum-plane' && cadFeatureActive(feature, bindings.document)))
              throw new ToolError('NOT_FOUND', 'Choose an origin plane or an active datum plane in the current CAD draft.');
            const current = bindings.section && cadSameReferencePlane(bindings.section.plane, plane) ? bindings.section : null;
            bindings.setSection({ plane, flip: command.flip ?? current?.flip ?? false, caps: command.caps ?? current?.caps ?? true }); return;
          }
          case 'set-view':
            if (bindings.sketchId || bindings.curveId || !rendered?.setView) throw new ToolError('WRONG_VIEW', 'Finish sketch or curve editing before selecting a named solid view.');
            rendered.setView(command.view); return;
          case 'fit':
            if (!rendered) throw new ToolError('VIEW_UNAVAILABLE', 'Wait for the viewport to load.');
            rendered.fit(); return;
          case 'set-grid':
            if (!rendered) throw new ToolError('VIEW_UNAVAILABLE', 'Wait for the viewport to load.');
            rendered.setGrid(command.visible); return;
          default: { const exhaustive: never = command; throw exhaustive; }
        }
      });
    },
    async capture(signal): Promise<CadViewportCapture> {
      signal.throwIfAborted();
      const bindings = readable();
      const rendered = bindings.rendered;
      const before = getState();
      if (!rendered || !before.view?.available) throw new ToolError('CAPTURE_UNAVAILABLE', 'Wait for a visible CAD viewport to load.');
      const hasReferences = bindings.visibleReferencePlanes.length > 0 || before.view.mode === 'solid' && Boolean(before.view.referencePlanes?.length) || bindings.document.features.some(feature => cadFeatureActive(feature, bindings.document) && (feature.kind === 'datum-plane' || feature.kind === 'curve' || feature.kind === 'sketch' && (feature.profiles.length > 0 || Boolean(feature.graph?.entities.length))));
      const requiresBuild = !hasReferences || bindings.document.features.some(feature => cadFeatureProducesBody(feature) && cadFeatureActive(feature, bindings.document));
      if (before.view.mode === 'solid') {
        if (requiresBuild && (bindings.buildState !== 'ready' || bindings.buildVersion !== bindings.documentVersion)) throw new ToolError('STALE_STATE', 'Wait for this exact CAD draft to finish building before capturing its solid view.');
        if (hasReferences && !referencesInstalled(bindings, before)) throw new ToolError('STALE_STATE', 'Wait for the current reference geometry to appear before capturing the view.');
      }
      const image = await rendered.capture(signal);
      signal.throwIfAborted();
      const after = getState();
      if (after.documentId !== before.documentId || after.documentVersion !== before.documentVersion) throw new ToolError('STALE_STATE', 'The CAD draft changed during capture. Read context and capture again.');
      if (after.workflowOpen || cadViewportVisualIdentity(after) !== cadViewportVisualIdentity(before)) throw new ToolError('STALE_VIEW', 'The CAD view changed during capture. Capture the current view again.');
      if (hasReferences && !referencesInstalled(getBindings(), after)) throw new ToolError('STALE_VIEW', 'The visible CAD references changed during capture. Capture the current view again.');
      return Object.freeze({ image, contentSource: 'cad-draft', documentId: before.documentId, documentVersion: before.documentVersion,
        dirty: before.dirty, sketchId: before.sketchId, curveId: before.curveId,
        buildVersion: before.view.mode === 'solid' && requiresBuild ? before.buildVersion : null, viewState: before });
    },
  };
}
