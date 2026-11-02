import type { CadDocument, CadFeature, CadScalar } from '@/domain/cad/cadDocument';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import { cadFeatureInputs } from '@/domain/cad/cadFeatureInputs';
import { cadEditsOnlyPlaceDimensions, validateCadEditBatch, type CadEdit } from '@/domain/cad/cadOperations';
import { parseCadDocument } from '@/domain/cad/cadSchema';
import { CadError } from '@/domain/cad/cadError';
import { keepCadSketchLineSides } from '@/domain/cad/cadSketchPointLineDistanceRelations';
import { cadSketchCellModeForAreas, prepareCadSketchCells, type CadPreparedSketchCatalog } from '@/domain/cad/cadSketchRegionInspection';
import { resolveCadSketchRegions } from '@/domain/cad/cadSketchGeometry';
import type { CadSketchRegionSelection } from '@/domain/cad/cadSketchRegionSelection';
import { CadSession, CadSessionError, type CadSessionSnapshot } from './cadSession';
import { deepFreezeCadData } from '@/domain/cad/cadDeepFreeze';
import { cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

export type CadSketchEditDraftSource = Pick<CadSessionSnapshot, 'document' | 'version'>;
export type CadSketchDraftPreparation = (document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal) => Promise<CadDocument>;
export interface CadSketchEditDraftFinish {
  readonly baseVersion: string;
  readonly localVersion: string;
  readonly edits: readonly CadEdit[];
  readonly noOp: boolean;
}
export type CadSketchAreaRepairFeature = Extract<CadFeature, { kind: 'extrude' | 'pocket' }>;
export interface CadSketchAreaRepairInspection {
  readonly sketchId: string;
  readonly localVersion: string;
  readonly consumers: readonly { readonly feature: CadSketchAreaRepairFeature; readonly issue: string; readonly cells: CadPreparedSketchCatalog }[];
}
export interface CadSketchAreaRepairs {
  readonly localVersion: string;
  readonly selections: readonly { readonly featureId: string; readonly selection: CadSketchRegionSelection }[];
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const scopeError = () => new CadSessionError('SKETCH_DRAFT_SCOPE', 'A sketch draft may change only its owned sketch, numeric parameters and solver-updated earlier graph values.');
const numericOriginal = (original: CadScalar, candidate: CadScalar) => typeof original === 'number' && typeof candidate === 'number' ? original : candidate;
const freezeData = (value: unknown) => deepFreezeCadData(value, { skipFrozen: true });

/** Remove only the allowed solver-owned differences before comparing complete earlier source. */
function withoutSolvedGraphValues(original: CadFeature, candidate: CadFeature): CadFeature {
  if (original.kind !== 'sketch' || candidate.kind !== 'sketch' || !original.graph || !candidate.graph) return candidate;
  const graph = original.graph;
  return { ...candidate, graph: { ...candidate.graph,
    points: candidate.graph.points.map((point, index) => {
      const previous = graph.points[index];
      return previous ? { ...point, position: [numericOriginal(previous.position[0], point.position[0]), numericOriginal(previous.position[1], point.position[1])] } : point;
    }),
    entities: candidate.graph.entities.map((entity, index) => {
      const previous = graph.entities[index];
      return entity.kind === 'circle' && previous?.kind === 'circle' ? { ...entity, radius: numericOriginal(previous.radius, entity.radius) } : entity;
    }) } };
}

/**
 * Private valid prefix and bounded local history for one consumed sketch.
 * Preparation is the controller's existing trusted pipeline, never another solver.
 * Shared parameters may solve earlier numeric graph coordinates/radii; exact drivers,
 * topology, relations, profiles, provenance and all other earlier fields stay pinned.
 * Finish returns snapshots, not replayed gestures. The controller must prepare the
 * batch against the full base and recheck assertCurrent immediately before acceptance.
 */
export class CadSketchEditDraft {
  readonly initialDocument: CadDocument;
  readonly pin: Readonly<{ documentId: string; version: string; sketchId: string }>;
  private readonly source: CadSketchEditDraftSource;
  private readonly local: CadSession;
  private readonly owner = new AbortController();
  private readonly sketchIndex: number;

  constructor(source: CadSketchEditDraftSource, sketchId: string) {
    const accepted = parseCadDocument(source.document);
    if (accepted !== source.document) throw new CadSessionError('SKETCH_DRAFT_SOURCE', 'Start a sketch draft from an accepted immutable CAD snapshot.');
    this.sketchIndex = accepted.features.findIndex(feature => feature.id === sketchId && feature.kind === 'sketch');
    if (this.sketchIndex < 0) throw new CadSessionError('SKETCH_DRAFT_SCOPE', 'Choose an existing sketch to edit.');
    this.source = Object.freeze({ document: source.document, version: source.version });
    this.pin = Object.freeze({ documentId: accepted.id, version: source.version, sketchId });
    this.initialDocument = parseCadDocument({ ...accepted, features: accepted.features.slice(0, this.sketchIndex + 1) });
    this.local = new CadSession(this.initialDocument);
  }
  getSnapshot = (): CadSessionSnapshot => this.local.getSnapshot();
  subscribe = (listener: () => void) => this.local.subscribe(listener);
  private assertOpen() {
    if (this.owner.signal.aborted) throw new CadSessionError('SKETCH_DRAFT_CLOSED', 'This sketch edit has ended. Open a fresh sketch edit.');
  }
  assertSource(source: CadSketchEditDraftSource) {
    this.assertOpen();
    if (source.document !== this.source.document || source.version !== this.pin.version)
      throw new CadSessionError('STALE_STATE', 'The accepted part changed. Open a fresh sketch edit.');
  }
  assertCurrent(source: CadSketchEditDraftSource, localVersion = this.local.getSnapshot().version) {
    this.assertSource(source); this.local.assertVersion(localVersion);
  }
  validateEdits(edits: readonly CadEdit[]) {
    this.assertOpen(); validateCadEditBatch(edits);
    for (const edit of edits) {
      switch (edit.kind) {
        case 'set-parameter': break;
        case 'update-feature':
          if (edit.feature.kind !== 'sketch' || edit.feature.id !== this.pin.sketchId) throw scopeError();
          break;
        case 'add-sketch-dimension': case 'set-sketch-dimension': case 'remove-sketch-dimension':
        case 'translate-sketch-profiles': case 'translate-sketch-geometry': case 'place-sketch-geometry': case 'move-sketch-handle': case 'append-sketch-entities': case 'delete-sketch-elements':
        case 'set-sketch-construction': case 'move-sketch-point': case 'set-sketch-relation': case 'remove-sketch-relation': case 'create-sketch-corner': case 'split-sketch-entity': case 'trim-sketch-entity': case 'extend-sketch-entity': case 'offset-sketch-loop': case 'mirror-sketch-geometry': case 'use-sketch-entity':
          if (edit.sketchId !== this.pin.sketchId) throw scopeError();
          break;
        default: throw scopeError();
      }
    }
  }
  private parameterEdits(candidate: CadDocument): CadEdit[] {
    for (const name of Object.keys(this.initialDocument.parameters)) if (!Object.hasOwn(candidate.parameters, name)) throw scopeError();
    return Object.entries(candidate.parameters).flatMap(([name, value]) => value === this.initialDocument.parameters[name] ? [] : [{ kind: 'set-parameter' as const, name, value }]);
  }
  private assertOwnedPrefix(candidate: CadDocument) {
    const owned = candidate.features[this.sketchIndex], original = this.initialDocument.features[this.sketchIndex];
    if (owned?.kind !== 'sketch' || owned.id !== this.pin.sketchId || original.kind !== 'sketch') throw scopeError();
    if (!same(owned.source, original.source)) throw scopeError();
    // A plugin instance, a saved profile or a generator, keeps its pinned package.
    for (const profile of cadSketchProfileViews(original)) if (profile.geometry.kind === 'plugin') {
      const retained = cadSketchProfileViews(owned).find(value => value.id === profile.id);
      if (retained && (retained.geometry.kind !== 'plugin' || !same(retained.geometry.package, profile.geometry.package))) throw scopeError();
    }
    this.parameterEdits(candidate);
    const added = Object.keys(candidate.parameters).filter(name => !Object.hasOwn(this.initialDocument.parameters, name));
    const expected = { ...this.initialDocument, parameters: candidate.parameters,
      schemaVersion: candidate.features.some(feature => feature.kind === 'sketch' && feature.graph) ? 2 : this.initialDocument.schemaVersion,
      features: [...this.initialDocument.features.slice(0, this.sketchIndex), owned],
      ...(added.length ? { parameterMetadata: { ...this.initialDocument.parameterMetadata,
        ...Object.fromEntries(added.map(name => [name, { source: { kind: 'manual' } }])) } } : {}) };
    const normalized = { ...candidate, features: candidate.features.map((feature, index) => index < this.sketchIndex
      ? withoutSolvedGraphValues(this.initialDocument.features[index], feature) : feature) };
    if (!same(normalized, expected)) throw scopeError();
  }
  async editPrepared(edits: readonly CadEdit[], prepare: CadSketchDraftPreparation,
    expectedLocalVersion = this.local.getSnapshot().version, signal?: AbortSignal, assertCurrent?: () => void) {
    this.validateEdits(edits);
    const captured = structuredClone(edits), combined = signal ? AbortSignal.any([this.owner.signal, signal]) : this.owner.signal;
    combined.throwIfAborted(); assertCurrent?.();
    return this.local.editPrepared(expectedLocalVersion, async document => {
      const candidate = parseCadDocument(await prepare(document, captured, combined));
      this.assertOpen(); assertCurrent?.(); this.assertOwnedPrefix(candidate); return candidate;
    }, combined, () => { this.assertOpen(); assertCurrent?.(); });
  }
  /**
   * Accepts at once a batch that only moves dimensions of the owned sketch, since nothing in it needs preparing; null for any other
   * batch, which `editPrepared` takes. It is one undo step of the draft, as a prepared edit is.
   */
  editPlacements(edits: readonly CadEdit[], expectedLocalVersion = this.local.getSnapshot().version, assertCurrent?: () => void) {
    this.validateEdits(edits);
    if (!cadEditsOnlyPlaceDimensions(this.local.getSnapshot().document, edits)) return null;
    assertCurrent?.();
    return this.local.edit(structuredClone(edits), expectedLocalVersion);
  }
  undo(expectedLocalVersion = this.local.getSnapshot().version) { this.assertOpen(); this.local.undo(expectedLocalVersion); }
  redo(expectedLocalVersion = this.local.getSnapshot().version) { this.assertOpen(); this.local.redo(expectedLocalVersion); }
  setWorkflowOpen(open: boolean) { this.assertOpen(); this.local.setWorkflowOpen(open, 'editor'); }
  /** Inspect exact original active selectors against one current private cell preparation. */
  inspectAreaRepairs(source: CadSketchEditDraftSource): CadSketchAreaRepairInspection | null {
    this.assertSource(source);
    const candidates = source.document.features.slice(this.sketchIndex + 1).filter((feature): feature is CadSketchAreaRepairFeature =>
      (feature.kind === 'extrude' || feature.kind === 'pocket') && feature.sketchId === this.pin.sketchId && cadFeatureActive(feature, source.document) && feature.regionSelection !== undefined);
    if (!candidates.length) return null;
    const snapshot = this.local.getSnapshot(), sketch = snapshot.document.features[this.sketchIndex];
    if (sketch.kind !== 'sketch') throw scopeError();
    const consumers: CadSketchAreaRepairInspection['consumers'][number][] = [];
    for (const feature of candidates) {
      try { resolveCadSketchRegions(sketch, snapshot.document.parameters, feature.regionSelection); }
      catch (error) {
        if (!(error instanceof CadError)) throw error;
        const cells = prepareCadSketchCells(sketch, snapshot.document.parameters, cadSketchCellModeForAreas(sketch, snapshot.document.parameters, feature.regionSelection));
        if (!cells.cells.length) throw new CadSessionError('SKETCH_AREA_REPAIR_UNAVAILABLE', 'The edited sketch has no closed material areas. Close or repair its boundary before choosing replacement areas.');
        consumers.push({ feature, issue: error.message, cells });
      }
    }
    if (!consumers.length) return null;
    const result = { sketchId: this.pin.sketchId, localVersion: snapshot.version, consumers };
    freezeData(result); return result;
  }
  cancel() {
    if (this.owner.signal.aborted) return;
    this.owner.abort(); this.local.replace(this.initialDocument);
  }
  finishEdits(source: CadSketchEditDraftSource, consumerRepairs: readonly CadEdit[] = []): CadSketchEditDraftFinish {
    this.assertSource(source); validateCadEditBatch(consumerRepairs);
    const snapshot = this.local.getSnapshot(), candidate = snapshot.document;
    this.assertOwnedPrefix(candidate);
    const edits = this.parameterEdits(candidate);
    for (const [index, feature] of candidate.features.entries()) {
      const original = this.initialDocument.features[index];
      if (same(feature, original)) continue;
      if (original.kind === 'sketch' && feature.kind === 'sketch') for (const relation of original.graph?.relations ?? []) {
        if (relation.kind !== 'linear-pattern') continue;
        const retained = feature.graph?.relations.find(value => value.id === relation.id);
        // The trusted private draft already performed this explicit release. Replay
        // the ownership boundary before publishing later independent member edits.
        if (retained?.kind !== 'linear-pattern' || retained.idPrefix !== relation.idPrefix || !same(retained.seed, relation.seed))
          edits.push({ kind: 'remove-sketch-relation', sketchId: feature.id, relationId: relation.id });
      }
      // The draft's own edits already kept each distance's side and each placement along a line. Publishing its final state as one
      // edit would turn a side or placement the draft deliberately restated after reversing its line, so release each such relation
      // first: the final state then states it exactly, before any solve that edit needs.
      if (original.kind === 'sketch' && feature.kind === 'sketch' && original.graph && feature.graph) {
        const graph = feature.graph, republished = keepCadSketchLineSides(original.graph, graph);
        if (republished !== graph) for (const [index, relation] of graph.relations.entries())
          if (republished.relations[index] !== relation) edits.push({ kind: 'remove-sketch-relation', sketchId: feature.id, relationId: relation.id });
      }
      edits.push({ kind: 'update-feature', feature });
    }
    const repaired = new Set<string>();
    for (const edit of structuredClone(consumerRepairs)) {
      if (edit.kind !== 'update-feature' || edit.feature.kind !== 'extrude' && edit.feature.kind !== 'pocket') throw scopeError();
      const feature = edit.feature, index = source.document.features.findIndex(value => value.id === feature.id), original = source.document.features[index];
      if (index <= this.sketchIndex || !original || original.kind !== feature.kind || !cadFeatureInputs(original).sketchIds.includes(this.pin.sketchId)
        || repaired.has(feature.id) || !same({ ...feature, regionSelection: undefined }, { ...original, regionSelection: undefined })) throw scopeError();
      repaired.add(feature.id);
      if (!same(feature, original)) edits.push(edit);
    }
    validateCadEditBatch(edits);
    const finish = { baseVersion: this.pin.version, localVersion: snapshot.version, edits, noOp: edits.length === 0 };
    freezeData(finish); return finish;
  }
}
