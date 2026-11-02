import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { CadDocument, CadFeature, CadPoint2, CadScalar, CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { CadFeatureSchema, cadFeatureDependencies, parseCadDocument, withCadSketchPlacements } from './cadSchema';
import { isCadImportData } from './cadImportData';
import { CadPluginPackageSchema, type CadPluginPackage } from './plugins/cadPlugins';
import { addCadPluginProfile, CadParameterGroupSchema, mapCadFeatureScalars, renameCadScalarParameter, type CadParameterGroup } from './cadParameters';
import { addCadSketchDimension, cadSketchDimensionScalar, CadSketchDimensionConstraintSchema, isCadSketchExpressionDriven, removeCadSketchDimension, setCadSketchDimensionValue, translateCadSketchProfile, type CadSketchDimensionConstraint } from './cadSketchConstraints';
import { CadPoint2Schema, CadScalarSchema } from './cadPrimitives';
import { evaluateCadScalar } from './cadExpression';
import { CadSketchHandleSchema, moveCadSketchHandle, type CadSketchHandle } from './cadSketchHandles';
import { CadSketchGeneratorSchema, CadSketchGraphSchema, assertNoReservedCadSketchIds, type CadSketchGenerator, type CadSketchGraph, type CadSketchGraphRelation } from './cadSketchGraph';
import { appendCadSketchEntities, deleteCadSketchElements, setCadSketchConstruction } from './cadSketchGraphEdits';
import { CadSketchCornerCommandTreatmentSchema, createCadSketchCornerTreatmentFromIds, type CadSketchCornerCommandTreatment } from './cadSketchCornerTreatment';
import { CAD_SKETCH_SELECTION_LIMIT, CadSketchGraphSelectionSchema, type CadSketchGraphSelection } from './cadSketchGraphSelection';
import { cadSketchFixedElementError, isCadSketchReservedId, isCadSketchVirtualId } from './sketch-relations/cadSketchVirtualElements';
import { translateCadSketchGraph } from './cadSketchTranslation';
import { keepCadSketchLineSides } from './cadSketchPointLineDistanceRelations';
import { cadSketchRelationsEqualButPlacement } from './cadSketchPlacedDimensions';
import { CadSketchPlacementRequestSchema, placeCadSketchGraph, type CadSketchPlacementRequest } from './cadSketchPlacement';
import { CadSketchSplitTargetSchema, splitCadSketchEntity, type CadSketchSplitTarget } from './cadSketchSplit';
import { CadSketchTrimTargetSchema, trimCadSketchEntity, type CadSketchTrimTarget, CadSketchExtendTargetSchema, extendCadSketchEntity, type CadSketchExtendTarget,
  CadSketchRemovedRelationIdsSchema } from './cadSketchTrimExtend';
import { CadSketchOffsetRequestSchema, prepareCadSketchOffset, type CadSketchOffsetRequest } from './cadSketchOffset';
import { CadSketchMirrorRequestSchema, prepareCadSketchMirror, type CadSketchMirrorRequest } from './cadSketchMirror';
import { CadSketchProfileCopyRequestSchema, prepareCadSketchProfileCopy, type CadSketchProfileCopyRequest } from './cadSketchProfileCopy';
import { CadSketchUseEntityRequestSchema, prepareCadSketchUseEntity, cadSketchExternalReferenceLockReason, type CadSketchUseEntityRequest } from './cadSketchExternalReferences';
import { prepareCadSketchPatternSnapshot, reconcileCadSketchLinearPattern } from './cadSketchLinearPattern';
import { cadSketchOwnedGeometryLockReason } from './cadSketchOwnedGeometry';
import { assertCadSketchGeneratorRemovals, cadSketchGeneratorLockReason, cadSketchGeneratorName, cadSketchGeneratorRemovals } from './sketch-generators/cadSketchGenerators';
import { cadSketchGeneratorHandleError, cadSketchGeneratorMoveReason, cadSketchProfileViews, cadSketchWholeGenerator, withCadSketchProfile } from './sketch-generators/cadSketchProfileViews';
import { detachCadSketchGenerator, setCadSketchGenerator, settleCadDocumentGenerators } from './sketch-generators/cadSketchGeneratorEdits';
import { assertCadSketchGraphGeneratorCounts } from './sketch-generators/cadSketchGeneratorKinds';

export type CadEdit =
  | { readonly kind: 'add-feature'; readonly feature: CadFeature; readonly beforeId?: string }
  | { readonly kind: 'update-feature'; readonly feature: CadFeature }
  | { readonly kind: 'delete-feature'; readonly featureId: string; readonly cascade: boolean }
  | { readonly kind: 'move-feature'; readonly featureId: string; readonly beforeId: string | null }
  | { readonly kind: 'set-parameter'; readonly name: string; readonly value: number; readonly removedRelationIds?: readonly string[] }
  | { readonly kind: 'remove-parameter'; readonly name: string }
  | { readonly kind: 'rename-parameter'; readonly name: string; readonly newName: string }
  | { readonly kind: 'set-parameter-group'; readonly group: CadParameterGroup }
  | { readonly kind: 'remove-parameter-group'; readonly groupId: string }
  | { readonly kind: 'move-parameter'; readonly name: string; readonly groupId: string | null }
  | { readonly kind: 'add-plugin-profile'; readonly sketchId: string; readonly profileId: string; readonly name: string; readonly package: CadPluginPackage; readonly groupId: string }
  | { readonly kind: 'add-sketch-dimension'; readonly sketchId: string; readonly profileId: string; readonly constraint: CadSketchDimensionConstraint }
  | { readonly kind: 'set-sketch-dimension'; readonly sketchId: string; readonly profileId: string; readonly dimensionId: string; readonly value: CadScalar }
  | { readonly kind: 'remove-sketch-dimension'; readonly sketchId: string; readonly profileId: string; readonly dimensionId: string }
  | { readonly kind: 'translate-sketch-profiles'; readonly sketchId: string; readonly profileIds: readonly string[]; readonly translation: CadPoint2 }
  | { readonly kind: 'translate-sketch-geometry'; readonly sketchId: string; readonly selections: readonly CadSketchGraphSelection[]; readonly translation: CadPoint2 }
  | ({ readonly kind: 'place-sketch-geometry'; readonly sketchId: string } & CadSketchPlacementRequest)
  | { readonly kind: 'move-sketch-handle'; readonly sketchId: string; readonly profileId: string; readonly handle: CadSketchHandle; readonly translation: CadPoint2 }
  | { readonly kind: 'append-sketch-entities'; readonly sketchId: string; readonly geometry: CadSketchGraph }
  | { readonly kind: 'create-sketch-corner'; readonly sketchId: string; readonly pointId: string; readonly treatment: CadSketchCornerCommandTreatment }
  | { readonly kind: 'split-sketch-entity'; readonly sketchId: string; readonly split: CadSketchSplitTarget }
  | { readonly kind: 'trim-sketch-entity'; readonly sketchId: string; readonly trim: CadSketchTrimTarget }
  | { readonly kind: 'extend-sketch-entity'; readonly sketchId: string; readonly extend: CadSketchExtendTarget }
  | ({ readonly kind: 'offset-sketch-loop'; readonly sketchId: string } & CadSketchOffsetRequest)
  | ({ readonly kind: 'mirror-sketch-geometry'; readonly sketchId: string } & CadSketchMirrorRequest)
  | ({ readonly kind: 'copy-sketch-profile' } & CadSketchProfileCopyRequest)
  | ({ readonly kind: 'use-sketch-entity' } & CadSketchUseEntityRequest)
  | { readonly kind: 'delete-sketch-elements'; readonly sketchId: string; readonly pointIds: readonly string[]; readonly entityIds: readonly string[]; readonly relationIds: readonly string[]; readonly cascade: boolean }
  | { readonly kind: 'set-sketch-construction'; readonly sketchId: string; readonly entityIds: readonly string[]; readonly construction: boolean }
  | { readonly kind: 'move-sketch-point'; readonly sketchId: string; readonly pointId: string; readonly translation: CadPoint2 }
  /** `copyRelations` applies to a linear-pattern owner only: each occurrence it creates copies the seed's reference dimensions. */
  | { readonly kind: 'set-sketch-relation'; readonly sketchId: string; readonly relation: CadSketchGraphRelation; readonly copyRelations?: boolean }
  | { readonly kind: 'remove-sketch-relation'; readonly sketchId: string; readonly relationId: string }
  /** Creates a generator, or replaces the inputs of the one with its id; its members regenerate in the same edit. */
  | { readonly kind: 'set-sketch-generator'; readonly sketchId: string; readonly generator: CadSketchGenerator; readonly removedRelationIds?: readonly string[] }
  /** Removes a generator and keeps its members as ordinary geometry. */
  | { readonly kind: 'detach-sketch-generator'; readonly sketchId: string; readonly generatorId: string }
  | { readonly kind: 'rename-document'; readonly name: string };

const identifier = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$' });
const parameterName = Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' });
const strict = { additionalProperties: false };
export const CadEditSchema = Type.Union([
  Type.Object({ kind: Type.Literal('add-feature'), feature: CadFeatureSchema, beforeId: Type.Optional(identifier) }, strict),
  Type.Object({ kind: Type.Literal('update-feature'), feature: CadFeatureSchema }, strict),
  Type.Object({ kind: Type.Literal('delete-feature'), featureId: identifier, cascade: Type.Boolean() }, strict),
  Type.Object({ kind: Type.Literal('move-feature'), featureId: identifier, beforeId: Type.Union([identifier, Type.Null()]) }, strict),
  Type.Object({ kind: Type.Literal('set-parameter'), name: parameterName, value: Type.Number({ minimum: -1e9, maximum: 1e9 }), removedRelationIds: CadSketchRemovedRelationIdsSchema }, strict),
  Type.Object({ kind: Type.Literal('remove-parameter'), name: parameterName }, strict),
  Type.Object({ kind: Type.Literal('rename-parameter'), name: parameterName, newName: parameterName }, strict),
  Type.Object({ kind: Type.Literal('set-parameter-group'), group: CadParameterGroupSchema }, strict),
  Type.Object({ kind: Type.Literal('remove-parameter-group'), groupId: identifier }, strict),
  Type.Object({ kind: Type.Literal('move-parameter'), name: parameterName, groupId: Type.Union([identifier, Type.Null()]) }, strict),
  Type.Object({ kind: Type.Literal('add-plugin-profile'), sketchId: identifier, profileId: identifier, name: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }), package: CadPluginPackageSchema, groupId: identifier }, strict),
  Type.Object({ kind: Type.Literal('add-sketch-dimension'), sketchId: identifier, profileId: identifier, constraint: CadSketchDimensionConstraintSchema }, strict),
  Type.Object({ kind: Type.Literal('set-sketch-dimension'), sketchId: identifier, profileId: identifier, dimensionId: identifier, value: CadScalarSchema }, strict),
  Type.Object({ kind: Type.Literal('remove-sketch-dimension'), sketchId: identifier, profileId: identifier, dimensionId: identifier }, strict),
  Type.Object({ kind: Type.Literal('translate-sketch-profiles'), sketchId: identifier, profileIds: Type.Array(identifier, { minItems: 1, maxItems: 256, uniqueItems: true }), translation: CadPoint2Schema }, strict),
  Type.Object({ kind: Type.Literal('translate-sketch-geometry'), sketchId: identifier, selections: Type.Array(CadSketchGraphSelectionSchema, { minItems: 1, maxItems: CAD_SKETCH_SELECTION_LIMIT, uniqueItems: true }), translation: CadPoint2Schema }, strict),
  Type.Object({ kind: Type.Literal('place-sketch-geometry'), sketchId: identifier, ...CadSketchPlacementRequestSchema.properties }, strict),
  Type.Object({ kind: Type.Literal('move-sketch-handle'), sketchId: identifier, profileId: identifier, handle: CadSketchHandleSchema, translation: CadPoint2Schema }, strict),
  Type.Object({ kind: Type.Literal('append-sketch-entities'), sketchId: identifier, geometry: CadSketchGraphSchema }, strict),
  Type.Object({ kind: Type.Literal('create-sketch-corner'), sketchId: identifier, pointId: identifier, treatment: CadSketchCornerCommandTreatmentSchema }, strict),
  Type.Object({ kind: Type.Literal('split-sketch-entity'), sketchId: identifier, split: CadSketchSplitTargetSchema }, strict),
  Type.Object({ kind: Type.Literal('trim-sketch-entity'), sketchId: identifier, trim: CadSketchTrimTargetSchema }, strict),
  Type.Object({ kind: Type.Literal('extend-sketch-entity'), sketchId: identifier, extend: CadSketchExtendTargetSchema }, strict),
  Type.Object({ kind: Type.Literal('offset-sketch-loop'), sketchId: identifier, ...CadSketchOffsetRequestSchema.properties }, strict),
  Type.Object({ kind: Type.Literal('mirror-sketch-geometry'), sketchId: identifier, ...CadSketchMirrorRequestSchema.properties }, strict),
  Type.Object({ kind: Type.Literal('copy-sketch-profile'), ...CadSketchProfileCopyRequestSchema.properties }, strict),
  Type.Object({ kind: Type.Literal('use-sketch-entity'), ...CadSketchUseEntityRequestSchema.properties }, strict),
  Type.Object({ kind: Type.Literal('delete-sketch-elements'), sketchId: identifier, pointIds: Type.Array(identifier, { uniqueItems: true }), entityIds: Type.Array(identifier, { uniqueItems: true }), relationIds: Type.Array(identifier, { uniqueItems: true }), cascade: Type.Boolean() }, strict),
  Type.Object({ kind: Type.Literal('set-sketch-construction'), sketchId: identifier, entityIds: Type.Array(identifier, { uniqueItems: true }), construction: Type.Boolean() }, strict),
  Type.Object({ kind: Type.Literal('move-sketch-point'), sketchId: identifier, pointId: identifier, translation: CadPoint2Schema }, strict),
  Type.Object({ kind: Type.Literal('set-sketch-relation'), sketchId: identifier, relation: CadSketchGraphSchema.properties.relations.items,
    copyRelations: Type.Optional(Type.Boolean()) }, strict),
  Type.Object({ kind: Type.Literal('remove-sketch-relation'), sketchId: identifier, relationId: identifier }, strict),
  Type.Object({ kind: Type.Literal('set-sketch-generator'), sketchId: identifier, generator: CadSketchGeneratorSchema, removedRelationIds: CadSketchRemovedRelationIdsSchema }, strict),
  Type.Object({ kind: Type.Literal('detach-sketch-generator'), sketchId: identifier, generatorId: identifier }, strict),
  Type.Object({ kind: Type.Literal('rename-document'), name: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }) }, strict)
]);

/** Validates the complete final document once; a failed batch never mutates the input. */
/** The relations `edits` confirm they remove as the generators they change or the parameters they set regenerate members. */
export function cadEditGeneratorRemovals(edits: readonly CadEdit[]): string[] {
  return edits.flatMap(edit => edit.kind === 'set-sketch-generator' || edit.kind === 'set-parameter' ? edit.removedRelationIds ?? [] : []);
}

export function applyCadEdits(document: CadDocument, edits: readonly CadEdit[]): CadDocument {
  return placeCadSketchDimensions(document, edits) ?? parseCadDocument(reduceCadEditIntents(document, edits));
}

/**
 * Whether every edit only moves a dimension of `document`: it replaces a sketch relation with one that differs from it only in
 * where it is drawn. Such a batch needs no solve, analysis or geometry check, so it is accepted at once.
 */
export function cadEditsOnlyPlaceDimensions(document: CadDocument, edits: readonly CadEdit[]): boolean {
  // A malformed batch is refused by the full path, with its reason.
  try { validateCadEditBatch(edits); } catch { return false; }
  return edits.length > 0 && edits.every(edit => {
    if (edit.kind !== 'set-sketch-relation') return false;
    const sketch = document.features.find(feature => feature.id === edit.sketchId);
    const accepted = sketch?.kind === 'sketch' ? sketch.graph?.relations.find(relation => relation.id === edit.relation.id) : undefined;
    return Boolean(accepted && cadSketchRelationsEqualButPlacement(accepted, edit.relation));
  });
}

/**
 * The accepted `document` after a batch that only moves dimensions, checking only their new placements and keeping every other
 * part and certificate; null for any other batch or a document that is not an accepted parse, which take the full path.
 */
export function placeCadSketchDimensions(document: CadDocument, edits: readonly CadEdit[]): CadDocument | null {
  if (!cadEditsOnlyPlaceDimensions(document, edits)) return null;
  let placed: CadDocument | null = document;
  for (const edit of edits) {
    if (edit.kind !== 'set-sketch-relation') return null;
    placed = withCadSketchPlacements(placed, edit.sketchId, [edit.relation]);
    if (!placed) return null;
  }
  return placed;
}

/** The sketch edits that move, cut, delete, convert or copy the points and edges they name, which the origin and the axes refuse. */
const SKETCH_ELEMENT_EDITS: ReadonlySet<string> = new Set(['translate-sketch-geometry', 'place-sketch-geometry', 'create-sketch-corner',
  'split-sketch-entity', 'trim-sketch-entity', 'extend-sketch-entity', 'offset-sketch-loop', 'mirror-sketch-geometry', 'use-sketch-entity',
  'delete-sketch-elements', 'set-sketch-construction', 'move-sketch-point']);
/**
 * The ids these edits only read, as `parent.key`: a mirror's axis line, and the boundary a trim cuts at or an extension reaches. An axis
 * may be named there; every other id an edit names is something it moves, cuts, removes, converts or copies, or a new id.
 */
const SKETCH_READ_REFERENCES: ReadonlySet<string> = new Set(['.axisLineId', 'boundary.entityId', 'boundaries.entityId']);
/** Refuse an edit that names the origin or an axis as something it changes, with that reason rather than as malformed. */
function refuseFixedSketchElements(edit: unknown): void {
  if (!edit || typeof edit !== 'object' || !SKETCH_ELEMENT_EDITS.has((edit as { kind?: unknown }).kind as string)) return;
  const visit = (value: unknown, key: string, parent: string): void => {
    if (typeof value === 'string') {
      if (/(?:^i|I)ds?$/.test(key) && isCadSketchVirtualId(value) && !SKETCH_READ_REFERENCES.has(`${parent}.${key}`)) throw cadSketchFixedElementError();
    } else if (Array.isArray(value)) for (const item of value) visit(item, key, parent);
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) visit(item, name, key);
  };
  visit(edit, '', '');
}

/**
 * The sketch data an edit adds, read before the schema check, as a document's is, for what that check would refuse without a reason:
 * reserved ids in a sketch feature's graph, appended geometry, a relation, or the prefix new ids are made from, and a generator listing
 * fewer or more entries than its kind takes.
 */
function refuseSketchData(edit: unknown): void {
  if (!edit || typeof edit !== 'object') return;
  const fields = edit as { readonly kind?: unknown; readonly feature?: { readonly kind?: unknown; readonly graph?: unknown } | null; readonly geometry?: unknown;
    readonly relation?: unknown; readonly idPrefix?: unknown };
  const graph = (fields.kind === 'add-feature' || fields.kind === 'update-feature') && fields.feature?.kind === 'sketch' ? fields.feature.graph
    : fields.kind === 'append-sketch-entities' ? fields.geometry : fields.kind === 'set-sketch-relation' ? { relations: [fields.relation] }
      : fields.kind === 'set-sketch-generator' ? { relations: [(fields as { readonly generator?: unknown }).generator] } : undefined;
  assertNoReservedCadSketchIds(graph);
  assertCadSketchGraphGeneratorCounts(graph);
  if (typeof fields.idPrefix === 'string' && SKETCH_ELEMENT_EDITS.has(fields.kind as string) && isCadSketchReservedId(fields.idPrefix))
    throw new CadError('reserved-sketch-id', `Sketch id prefix "${fields.idPrefix}" is reserved: ids starting with "@" name the origin and the H and V axes.`);
}
/**
 * Refuses, from edits' unchecked own data, what their schema check would refuse without a reason, as `validateCadEditBatch` does first. A
 * caller that checks edits against the schema itself, as the edit tool does, runs this before it.
 */
export function refuseCadEditsBeforeSchema(edits: readonly unknown[]): void {
  for (const edit of edits) { refuseSketchData(edit); refuseFixedSketchElements(edit); }
}
export function validateCadEditBatch(edits: readonly CadEdit[]): void {
  if (!isCadImportData(edits) || !Array.isArray(edits)) throw new CadError('invalid-edit', 'CAD edits must contain their own complete JSON data fields.');
  if (edits.length > 256) throw new CadError('edit-limit', 'An edit batch may contain at most 256 edits.');
  refuseCadEditsBeforeSchema(edits);
  for (const edit of edits) {
    if (!Value.Check(CadEditSchema, edit)) throw new CadError('invalid-edit', 'Malformed CAD edit.');
    if (edit.kind === 'set-sketch-relation' && edit.copyRelations !== undefined && edit.relation.kind !== 'linear-pattern')
      throw new CadError('invalid-edit', 'copyRelations applies only to a linear-pattern owner, whose new occurrences copy the seed\'s reference dimensions.');
  }
}

/** The points and edges an edit changes where they are, rather than copying or only reading them. */
function sketchIdsChangedInPlace(edit: CadEdit): readonly string[] {
  switch (edit.kind) {
    case 'split-sketch-entity': return [edit.split.entityId];
    case 'trim-sketch-entity': return [edit.trim.entityId];
    case 'extend-sketch-entity': return [edit.extend.entityId];
    case 'create-sketch-corner': return [edit.pointId];
    case 'set-sketch-construction': return edit.entityIds;
    case 'translate-sketch-geometry': case 'place-sketch-geometry': return edit.selections.map(selection => selection.id);
    case 'move-sketch-point': return [edit.pointId];
    default: return [];
  }
}
/** Refuses an edit of a generator's member on its own before the edit's own checks, naming the generator. */
function refuseGeneratedSketchEdit(features: readonly CadFeature[], edit: CadEdit): void {
  const ids = sketchIdsChangedInPlace(edit);
  if (!ids.length || !('sketchId' in edit)) return;
  const sketch = features.find(feature => feature.id === edit.sketchId);
  if (sketch?.kind !== 'sketch' || !sketch.graph) return;
  for (const id of ids) {
    const reason = cadSketchGeneratorLockReason(sketch.graph, { id });
    if (reason) throw new CadError('owned-sketch-generator', reason);
  }
}

/** Internal unsolved intent stage. Only parseCadDocument may accept its result. */
export function reduceCadEditIntents(document: CadDocument, edits: readonly CadEdit[]): CadDocument {
  validateCadEditBatch(edits);
  // The relations the batch confirms it removes as generators regenerate, whichever of its edits regenerates them.
  const removals = cadSketchGeneratorRemovals(cadEditGeneratorRemovals(edits));
  let features = [...document.features];
  let parameters = { ...document.parameters };
  let parameterGroups = document.parameterGroups ? [...document.parameterGroups] : undefined;
  let parameterMetadata = document.parameterMetadata ? { ...document.parameterMetadata } : undefined;
  let name = document.name;
  const indexOf = (id: string) => {
    const index = features.findIndex(feature => feature.id === id);
    if (index < 0) throw new CadError('missing-feature', `Feature "${id}" does not exist.`);
    return index;
  };
  for (const edit of edits) {
    const before = new Map(features.map(feature => [feature.id, feature]));
    refuseGeneratedSketchEdit(features, edit);
    switch (edit.kind) {
      case 'add-feature': {
        if (features.some(feature => feature.id === edit.feature.id)) throw new CadError('duplicate-id', `Feature "${edit.feature.id}" already exists.`);
        const index = edit.beforeId === undefined ? features.length : indexOf(edit.beforeId);
        features.splice(index, 0, edit.feature); break;
      }
      case 'update-feature': {
        const index = indexOf(edit.feature.id), previous = features[index];
        if (previous.kind === 'sketch' && previous.graph?.relations.some(relation => relation.kind === 'linear-pattern') && edit.feature.kind !== 'sketch')
          throw new CadError('owned-sketch-pattern', 'Detach the pattern before replacing its sketch source.');
        features[index] = previous.kind === 'sketch' && edit.feature.kind === 'sketch'
          ? prepareCadSketchPatternSnapshot(previous, edit.feature, parameters) : edit.feature;
        break;
      }
      case 'delete-feature': {
        indexOf(edit.featureId);
        const deleted = new Set([edit.featureId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const feature of features) if (!deleted.has(feature.id) && cadFeatureDependencies(feature).some(id => deleted.has(id))) {
            if (!edit.cascade) throw new CadError('dependent-feature', `Feature "${feature.name}" depends on the feature being deleted. Use explicit cascade deletion.`);
            deleted.add(feature.id); changed = true;
          }
        }
        features = features.filter(feature => !deleted.has(feature.id)); break;
      }
      case 'move-feature': {
        const previousIndex = indexOf(edit.featureId);
        if (edit.beforeId === edit.featureId) break;
        const [feature] = features.splice(previousIndex, 1);
        const index = edit.beforeId === null ? features.length : indexOf(edit.beforeId);
        features.splice(index, 0, feature); break;
      }
      case 'set-parameter':
        if (['__proto__', 'prototype', 'constructor'].includes(edit.name)) throw new CadError('invalid-parameter', `Parameter name "${edit.name}" is reserved.`);
        if (!Object.hasOwn(parameters, edit.name)) parameterMetadata = { ...parameterMetadata, [edit.name]: { source: { kind: 'manual' } } };
        parameters[edit.name] = edit.value; break;
      case 'remove-parameter': {
        if (!Object.hasOwn(parameters, edit.name)) throw new CadError('unknown-parameter', `Parameter "${edit.name}" does not exist.`);
        delete parameters[edit.name]; if (parameterMetadata) delete parameterMetadata[edit.name]; break;
      }
      case 'rename-parameter': {
        if (!Object.hasOwn(parameters, edit.name)) throw new CadError('unknown-parameter', `Parameter "${edit.name}" does not exist.`);
        if (edit.name === edit.newName) break;
        if (Object.hasOwn(parameters, edit.newName)) throw new CadError('duplicate-parameter', `Parameter "${edit.newName}" already exists.`);
        if (['__proto__', 'prototype', 'constructor'].includes(edit.newName)) throw new CadError('invalid-parameter', 'The new parameter name is reserved.');
        parameters[edit.newName] = parameters[edit.name]; delete parameters[edit.name];
        if (parameterMetadata?.[edit.name]) { parameterMetadata[edit.newName] = parameterMetadata[edit.name]; delete parameterMetadata[edit.name]; }
        features = features.map(feature => mapCadFeatureScalars(feature, value => renameCadScalarParameter(value, edit.name, edit.newName)));
        break;
      }
      case 'set-parameter-group': {
        parameterGroups ??= [];
        const index = parameterGroups.findIndex(group => group.id === edit.group.id);
        if (index === -1) parameterGroups.push(edit.group); else parameterGroups[index] = edit.group;
        break;
      }
      case 'remove-parameter-group': {
        if (!parameterGroups?.some(group => group.id === edit.groupId)) throw new CadError('missing-parameter-group', 'Parameter group does not exist.');
        parameterGroups = parameterGroups.filter(group => group.id !== edit.groupId);
        if (parameterMetadata) for (const [name, metadata] of Object.entries(parameterMetadata)) if (metadata.groupId === edit.groupId) parameterMetadata[name] = { source: metadata.source };
        break;
      }
      case 'move-parameter': {
        if (!Object.hasOwn(parameters, edit.name)) throw new CadError('unknown-parameter', 'Parameter does not exist.');
        if (edit.groupId !== null && !parameterGroups?.some(group => group.id === edit.groupId)) throw new CadError('missing-parameter-group', 'Parameter group does not exist.');
        parameterMetadata = { ...parameterMetadata, [edit.name]: { source: parameterMetadata?.[edit.name]?.source ?? { kind: 'manual' }, ...(edit.groupId !== null ? { groupId: edit.groupId } : {}) } };
        break;
      }
      case 'add-plugin-profile': {
        const result = addCadPluginProfile({ ...document, parameters, features, ...(parameterGroups ? { parameterGroups } : {}), ...(parameterMetadata ? { parameterMetadata } : {}) }, edit);
        parameters = { ...result.parameters }; features = [...result.features];
        parameterGroups = [...result.parameterGroups ?? []]; parameterMetadata = { ...result.parameterMetadata };
        break;
      }
      case 'rename-document': name = edit.name; break;
      case 'add-sketch-dimension': case 'set-sketch-dimension': case 'remove-sketch-dimension': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch for the dimension.');
        const generated = cadSketchWholeGenerator(feature, edit.profileId);
        if (generated) throw new CadError('generator-sketch-dimension', `${cadSketchGeneratorName(generated)} is sized by its inputs, not by profile dimensions. Set its inputs, or bind them to parameters, with a set-sketch-generator edit.`);
        if (!feature.profiles.some(profile => profile.id === edit.profileId)) throw new CadError('missing-profile', 'The selected sketch contour no longer exists.');
        features[index] = { ...feature, profiles: feature.profiles.map(profile => {
          if (profile.id !== edit.profileId) return profile;
          if (edit.kind === 'add-sketch-dimension') return addCadSketchDimension({ profile, constraint: edit.constraint });
          if (edit.kind === 'remove-sketch-dimension') return removeCadSketchDimension({ profile, dimensionId: edit.dimensionId });
          const constraint = profile.constraints?.find(constraint => constraint.id === edit.dimensionId);
          if (!constraint) throw new CadError('missing-sketch-dimension', 'The selected sketch dimension no longer exists.');
          const scalar = cadSketchDimensionScalar(profile, constraint.quantity);
          if (typeof scalar === 'string' && isCadSketchExpressionDriven(scalar)) {
            const name = scalar.trim();
            if (!Object.hasOwn(parameters, name)) throw new CadError('driven-sketch-dimension', 'This dimension follows an expression. Edit its referenced parameters or explicitly unlink it before changing the value.');
            parameters[name] = evaluateCadScalar(edit.value, parameters) / (constraint.quantity === 'diameter' ? 2 : 1);
            return profile;
          }
          return setCadSketchDimensionValue({ profile, quantity: constraint.quantity, value: edit.value });
        }) };
        break;
      }
      case 'move-sketch-handle': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to edit.');
        const profile = cadSketchProfileViews(feature).find(profile => profile.id === edit.profileId), whole = profile ? undefined : cadSketchWholeGenerator(feature, edit.profileId);
        // A generator with no profile view, such as a regular polygon, exists but is changed through its inputs only.
        if (whole) throw cadSketchGeneratorHandleError(whole);
        if (!profile) throw new CadError('missing-profile', 'The selected sketch contour no longer exists.');
        const translation = [evaluateCadScalar(edit.translation[0], parameters), evaluateCadScalar(edit.translation[1], parameters)] satisfies readonly [number, number];
        // A generator's shape moves as its profile did; its record takes the new geometry and its members regenerate.
        features[index] = withCadSketchProfile(feature, moveCadSketchHandle({ profile, handle: edit.handle, translation, parameters }));
        break;
      }
      case 'offset-sketch-loop': {
        const index = indexOf(edit.sketchId), sketch = features[index];
        if (sketch.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to offset.');
        // The edit is the shared request plus its sketch, so a proposal.offset preview and this commit read the same fields.
        const { kind: _kind, sketchId: _sketchId, ...request } = edit;
        features[index] = prepareCadSketchOffset({ sketch, parameters, ...request }).sketch;
        break;
      }
      case 'mirror-sketch-geometry': {
        const index = indexOf(edit.sketchId), sketch = features[index];
        if (sketch.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to mirror.');
        const { kind: _kind, sketchId: _sketchId, ...request } = edit;
        features[index] = prepareCadSketchMirror({ sketch, parameters, ...request }).sketch;
        break;
      }
      case 'use-sketch-entity': {
        const index = indexOf(edit.sketchId), sketch = features[index];
        if (sketch.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose a graph sketch to receive the reference.');
        features[index] = prepareCadSketchUseEntity({ sketch, parameters, previous: new Map(features.slice(0, index).map(feature => [feature.id, feature])),
          sketchId: edit.sketchId, sourceSketchId: edit.sourceSketchId, sourceEntityId: edit.sourceEntityId, idPrefix: edit.idPrefix }).sketch;
        break;
      }
      case 'copy-sketch-profile': {
        if (features.some(feature => feature.id === edit.newSketchId)) throw new CadError('duplicate-id', 'The new sketch identity already belongs to another feature.');
        const source = features[indexOf(edit.sourceSketchId)];
        if (source.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch profile to copy.');
        features.push(prepareCadSketchProfileCopy({ sketch: source, parameters, sourceSketchId: edit.sourceSketchId, profileId: edit.profileId,
          newSketchId: edit.newSketchId, name: edit.name, idPrefix: edit.idPrefix }).sketch);
        break;
      }
      case 'create-sketch-corner': case 'split-sketch-entity': case 'trim-sketch-entity': case 'extend-sketch-entity': {
        const index = indexOf(edit.sketchId), sketch = features[index];
        if (sketch.kind !== 'sketch' || !sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
        const result = edit.kind === 'create-sketch-corner'
          ? createCadSketchCornerTreatmentFromIds({ graph: sketch.graph, parameters, pointId: edit.pointId, treatment: edit.treatment })
          : edit.kind === 'split-sketch-entity' ? splitCadSketchEntity({ graph: sketch.graph, parameters, split: edit.split })
            : edit.kind === 'trim-sketch-entity' ? trimCadSketchEntity({ graph: sketch.graph, parameters, trim: edit.trim })
              : extendCadSketchEntity({ graph: sketch.graph, parameters, extend: edit.extend });
        const profileIds = new Set(sketch.profiles.map(profile => profile.id));
        for (const item of [...result.graph.points, ...result.graph.entities, ...result.graph.relations])
          if (profileIds.has(item.id)) throw new CadError('duplicate-sketch-id', `Sketch identity "${item.id}" already belongs to a legacy profile.`);
        features[index] = { ...sketch, graph: result.graph }; break;
      }
      case 'append-sketch-entities': case 'delete-sketch-elements': case 'set-sketch-construction': {
        const index = indexOf(edit.sketchId), sketch = features[index];
        if (sketch.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to edit.');
        features[index] = edit.kind === 'append-sketch-entities' ? appendCadSketchEntities({ sketch, geometry: edit.geometry })
          : edit.kind === 'delete-sketch-elements' ? deleteCadSketchElements({ sketch, pointIds: edit.pointIds, entityIds: edit.entityIds, relationIds: edit.relationIds, cascade: edit.cascade })
            : setCadSketchConstruction({ sketch, entityIds: edit.entityIds, construction: edit.construction });
        break;
      }
      case 'place-sketch-geometry': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch' || !feature.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
        features[index] = { ...feature, graph: placeCadSketchGraph({ graph: feature.graph, parameters, selections: edit.selections,
          anchor: edit.anchor, target: edit.target, angleDegrees: edit.angleDegrees }) };
        break;
      }
      case 'translate-sketch-geometry': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch' || !feature.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
        features[index] = { ...feature, graph: translateCadSketchGraph({ graph: feature.graph, selections: edit.selections, translation: edit.translation, parameters }) };
        break;
      }
      case 'move-sketch-point': case 'set-sketch-relation': case 'remove-sketch-relation': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch' || !feature.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
        let graph = feature.graph;
        if (edit.kind === 'move-sketch-point') {
          if (!graph.points.some(point => point.id === edit.pointId)) throw new CadError('missing-sketch-point', 'The selected sketch point no longer exists.');
          const reason = cadSketchOwnedGeometryLockReason(graph, { kind: 'point', id: edit.pointId }) ?? cadSketchExternalReferenceLockReason(graph, { kind: 'point', id: edit.pointId });
          if (reason) throw new CadError('referenced-sketch-geometry', reason);
          const delta = edit.translation.map(value => evaluateCadScalar(value, parameters));
          graph = { ...graph, points: graph.points.map(point => point.id !== edit.pointId ? point : { ...point, position: [
            typeof point.position[0] === 'number' ? point.position[0] + delta[0] : point.position[0],
            typeof point.position[1] === 'number' ? point.position[1] + delta[1] : point.position[1]
          ] }) };
        } else if (edit.kind === 'set-sketch-relation') {
          const previous = graph.relations.find(relation => relation.id === edit.relation.id);
          if (previous?.kind === 'linear-pattern' && edit.relation.kind !== 'linear-pattern') throw new CadError('owned-sketch-pattern', 'Detach the linear pattern before replacing its owner.');
          if (edit.relation.kind === 'generator' || previous?.kind === 'generator')
            throw new CadError('invalid-sketch-generator', 'Create or change a generator with its set-sketch-generator operation, and remove it by deleting or detaching it.');
          const generated = cadSketchGeneratorLockReason(graph, edit.relation);
          if (generated) throw new CadError('owned-sketch-generator', generated);
          if (edit.relation.kind === 'linear-pattern') {
            if (previous && previous.kind !== 'linear-pattern') throw new CadError('duplicate-sketch-id', 'Choose a fresh identity for the linear pattern.');
            graph = Value.Equal(previous, edit.relation) ? graph
              : reconcileCadSketchLinearPattern({ graph, parameters, relation: edit.relation, previous, copyRelations: edit.copyRelations === true });
          } else graph = { ...graph, relations: graph.relations.some(relation => relation.id === edit.relation.id)
            ? graph.relations.map(relation => relation.id === edit.relation.id ? edit.relation : relation) : [...graph.relations, edit.relation] };
        } else {
          const removed = graph.relations.find(relation => relation.id === edit.relationId);
          if (!removed) throw new CadError('missing-sketch-relation', 'The selected sketch relation no longer exists.');
          const generated = cadSketchGeneratorLockReason(graph, removed);
          if (generated) throw new CadError('owned-sketch-generator', generated);
          // A generator goes with its members, as deleting it does.
          if (removed.kind === 'generator') {
            features[index] = deleteCadSketchElements({ sketch: feature, pointIds: [], entityIds: [], relationIds: [removed.id], cascade: false });
            break;
          }
          graph = { ...graph, relations: graph.relations.filter(relation => relation.id !== edit.relationId) };
        }
        features[index] = { ...feature, graph }; break;
      }
      case 'set-sketch-generator': case 'detach-sketch-generator': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to edit.');
        // Settled at once, so later edits of the batch see the members, and a generator detached in the batch that made it keeps them.
        const [settled] = settleCadDocumentGenerators([feature], [edit.kind === 'set-sketch-generator' ? setCadSketchGenerator(feature, edit.generator) : feature], parameters, removals);
        features[index] = edit.kind === 'set-sketch-generator' ? settled : detachCadSketchGenerator(settled as CadSketchFeature, edit.generatorId);
        break;
      }
      case 'translate-sketch-profiles': {
        const index = indexOf(edit.sketchId), feature = features[index];
        if (feature.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch for translation.');
        // A shape without a profile view is placed by its inputs or its sources, and says so.
        for (const id of edit.profileIds) {
          const generator = cadSketchWholeGenerator(feature, id), reason = generator && cadSketchGeneratorMoveReason(generator);
          if (reason) throw new CadError('unsupported-sketch-translation', reason);
        }
        const views = cadSketchProfileViews(feature);
        if (edit.profileIds.some(id => !views.some(profile => profile.id === id))) throw new CadError('missing-profile', 'A selected sketch contour no longer exists.');
        const translation = [evaluateCadScalar(edit.translation[0], parameters), evaluateCadScalar(edit.translation[1], parameters)] satisfies readonly [number, number];
        let moved: CadSketchFeature = feature;
        for (const profile of views) if (edit.profileIds.includes(profile.id)) moved = withCadSketchProfile(moved, translateCadSketchProfile({ profile, translation, parameters }));
        features[index] = moved;
        break;
      }
      default: { const exhaustive: never = edit; throw exhaustive; }
    }
    // Whatever rewrote a sketch, a line it turned around keeps its distances on their physical sides and its dimensions where they were drawn.
    features = features.map(feature => {
      const previous = before.get(feature.id);
      if (previous === feature || previous?.kind !== 'sketch' || feature.kind !== 'sketch' || !previous.graph || !feature.graph) return feature;
      const graph = keepCadSketchLineSides(previous.graph, feature.graph);
      return graph === feature.graph ? feature : { ...feature, graph };
    });
    // A sketch the edit rewrote regenerates its generators at once, so a later edit of the batch sees their members and may change the
    // same generator again, as moving a shape after setting its inputs does.
    const changed = features.filter(feature => before.get(feature.id) !== feature);
    if (changed.length) {
      const settled = new Map(settleCadDocumentGenerators([...before.values()], changed, parameters, removals).map(feature => [feature.id, feature]));
      features = features.map(feature => settled.get(feature.id) ?? feature);
    }
  }
  // Generated geometry follows the edited inputs and parameters in the same step, so one undo restores both.
  features = settleCadDocumentGenerators(document.features, features, parameters, removals);
  assertCadSketchGeneratorRemovals(removals);
  const schemaVersion = features.some(feature => feature.kind === 'sketch' && feature.graph) ? 2 : document.schemaVersion;
  return { ...document, schemaVersion, name, parameters, features, ...(parameterGroups ? { parameterGroups } : {}), ...(parameterMetadata ? { parameterMetadata } : {}) };
}
