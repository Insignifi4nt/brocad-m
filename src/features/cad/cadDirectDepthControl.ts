import type { CadDocument, CadMesh } from '@/domain/cad/cadDocument';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import { applyCadEdits } from '@/domain/cad/cadOperations';
import type { CadTopologyPickSet } from '@/domain/cad/cadTopology';
import { cadExtrudeDepthEdits, cadExtrudeForEndFace, inspectCadExtrudeDepth, type CadExtrudeDepthControl, type CadExtrudeDepthModel, type CadExtrudeDepthState } from './cadExtrudeDepthInteraction';
import { cadFeatureCandidateEdits, cadFeatureCandidateKey, type CadFeatureCandidateEdits, type CadFeaturePreviewCommand } from './cadFeaturePreview';
import { cadGeneratorRemovals } from './cadGeneratorRemovals';

export interface CadDirectDepthEnvironment {
  readonly document: CadDocument;
  readonly documentVersion: string;
  /** False while another command, dialog or storage operation owns the part. A started drag keeps its own state. */
  readonly enabled: boolean;
}
export interface CadDirectDepthControl extends CadExtrudeDepthControl {
  /** Re-reads the environment and cancels a drag whose part or Pad changed. */
  refresh(): void;
  dispose(): void;
}

/**
 * The Pad a direct drag edits: the selected Pad, or the Pad whose end cap is the one
 * picked face. Edges, several picks and other features have no direct Length drag.
 */
export function cadDirectDepthTarget(document: CadDocument, meshes: readonly CadMesh[], selection: CadTopologyPickSet | null, selectedId: string | null): string | null {
  if (selection) {
    const [pick] = selection.picks;
    if (selection.picks.length !== 1 || pick.kind !== 'face') return null;
    const mesh = meshes.find(entry => entry.featureId === selection.bodyId);
    return mesh ? cadExtrudeForEndFace(document, mesh, pick.key) : null;
  }
  const feature = document.features.find(entry => entry.id === selectedId);
  return feature?.kind === 'extrude' && cadFeatureActive(feature, document) ? feature.id : null;
}

/** Drags shorter than this pointer step only round away floating-point noise. */
const DRAG_STEP_MM = .01;
const roundDrag = (quantityMm: number) => Math.round(quantityMm / DRAG_STEP_MM) * DRAG_STEP_MM;

/**
 * Onshape-style direct Length drag on a selected Pad, with no dialog: every move
 * previews, release commits one undoable edit, and Escape or any change to the part
 * restores it. The view-only handle owns pointer geometry; this owns the edits.
 */
export function createCadDirectDepthControl(options: {
  readonly featureId: string;
  readonly baseVersion: string;
  readonly owner: string;
  read(): CadDirectDepthEnvironment;
  preview(command: CadFeaturePreviewCommand): void;
  /** Starts the one accepted edit; the caller owns cancellation and errors. */
  commit(edits: CadFeatureCandidateEdits): void;
  /**
   * Takes the edits of a drag released at a Length that removes relations as generators regenerate. The drag has no dialog, so it
   * applies nothing and the caller asks, as the Pad's editor does.
   */
  ask?(edits: CadFeatureCandidateEdits): void;
  /** True from the first real Length change until release or cancel. */
  onGestureChange(active: boolean): void;
}): CadDirectDepthControl {
  const { featureId, baseVersion, owner } = options;
  const listeners = new Set<() => void>();
  let gesture: { token: string; document: CadDocument; edits: CadFeatureCandidateEdits | null; changed: boolean;
    /** The edits of the latest Length when it removes relations; the preview keeps the last Length that removes none. */
    removing?: CadFeatureCandidateEdits } | null = null;
  let disposed = false;
  let cached: { document: CadDocument; edits: CadFeatureCandidateEdits | null; enabled: boolean; gestureActive: boolean; state: CadExtrudeDepthState | null } | null = null;
  const environment = () => {
    if (disposed) return null;
    const env = options.read();
    return env.documentVersion === baseVersion ? env : null;
  };
  const notify = () => listeners.forEach(listener => listener());
  const end = (commit: boolean) => {
    const saved = gesture; if (!saved) return false;
    gesture = null;
    if (saved.changed) options.onGestureChange(false);
    if (commit && saved.removing && options.ask) { options.preview({ kind: 'clear', owner }); options.ask(saved.removing); }
    else if (commit && saved.edits) options.commit(saved.edits);
    else options.preview({ kind: 'clear', owner });
    notify(); return true;
  };
  const getState = (): CadExtrudeDepthState | null => {
    const env = environment();
    if (!env || !env.enabled && !gesture || gesture && gesture.document !== env.document) return null;
    const edits = gesture?.edits ?? null, gestureActive = Boolean(gesture);
    if (cached && cached.document === env.document && cached.edits === edits && cached.enabled === env.enabled && cached.gestureActive === gestureActive) return cached.state;
    const feature = env.document.features.find(entry => entry.id === featureId);
    let state: CadExtrudeDepthState | null = null;
    if (feature?.kind === 'extrude') {
      let model: CadExtrudeDepthModel | null = null;
      try {
        const candidate = edits ? applyCadEdits(env.document, edits) : env.document;
        model = inspectCadExtrudeDepth(candidate, candidate.features.find(entry => entry.id === featureId) ?? feature);
      } catch { model = null; }
      if (model) state = { model, gestureActive, capability: model.capability,
        definitionKey: cadFeatureCandidateKey(edits ?? cadFeatureCandidateEdits({ feature, isNew: false })) };
    }
    cached = { document: env.document, edits, enabled: env.enabled, gestureActive, state };
    return state;
  };
  const owns = (token: string) => {
    const env = environment();
    return gesture?.token === token && env?.document === gesture.document ? gesture : null;
  };
  return { owner, featureId, baseVersion, getState,
    ownsEndFace(mesh, faceKey) {
      const env = environment();
      return Boolean(env && env.enabled && !gesture && cadExtrudeForEndFace(env.document, mesh, faceKey) === featureId);
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin(expectedDefinitionKey) {
      const state = getState();
      if (gesture || !state || state.definitionKey !== expectedDefinitionKey || state.capability.kind !== 'editable') return null;
      const env = environment(); if (!env) return null;
      gesture = { token: crypto.randomUUID(), document: env.document, edits: null, changed: false };
      notify(); return gesture.token;
    },
    setQuantity(token, quantityMm) {
      const owned = owns(token); if (!owned) return false;
      const result = cadExtrudeDepthEdits(owned.document, featureId, roundDrag(quantityMm));
      // Passing through zero or a refused value keeps the last valid preview.
      if (result.kind === 'locked') return true;
      const edits = result.kind === 'edits' ? result.edits : null;
      if (edits) {
        try { applyCadEdits(owned.document, edits); owned.removing = undefined; }
        catch (cause) { owned.removing = cadGeneratorRemovals(cause) ? edits : undefined; return true; }
      } else owned.removing = undefined;
      if (edits && !owned.changed) { owned.changed = true; options.onGestureChange(true); }
      owned.edits = edits;
      options.preview(edits ? { kind: 'candidate', owner, expectedVersion: baseVersion, edits } : { kind: 'clear', owner });
      notify(); return true;
    },
    release(token) { return owns(token) ? end(true) : false; },
    cancel(token) { return owns(token) ? end(false) : false; },
    refresh() {
      const env = environment();
      if (gesture && (!env || env.document !== gesture.document)) end(false);
      else notify();
    },
    dispose() { if (disposed) return; end(false); disposed = true; listeners.clear(); }
  };
}
