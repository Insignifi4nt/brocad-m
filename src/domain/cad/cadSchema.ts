import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { CadDiagnostic, CadDocument, CadFeature, CadPoint3, CadProfile, CadScalar, CadSketchFeature, CadSketchProfile } from './cadDocument';
import { CadError } from './cadError';
import { evaluateCadScalar } from './cadExpression';
import { CadParameterGroupSchema, CadParameterMetadataSchema, CadParameterNameSchema, validateCadParameterMetadata } from './cadParameters';
import { resolveCadSketchRegions, validateCadSketchGeometry } from './cadSketchGeometry';
import { cadImportDataFields, isCadImportData } from './cadImportData';
import { MAX_CAD_PATTERN_INSTANCES } from './cadPatterns';
import { CadLabelSchema, CadNumberSchema } from './cadPrimitives';
import type { CadResolvedFrame } from './cadDatumPlanes';
import { cadFeatureInputs, cadFeatureProducesBody } from './cadFeatureInputs';
import { createCadBodyLineage } from './cadBodies';
import { validateCadSketchConstraints } from './cadSketchConstraints';
import { assertNoReservedCadSketchIds, cadSketchGraphWithPlacements } from './cadSketchGraph';
import { sameCadSketchGeometryParameters } from './cadSketchParameterReads';
import { cadFeatureActive } from './features/cadFeatureActivity';
import type { CadFeatureCheckContext, CadFeatureScalar, CadFeatureTrait } from './features/cadFeatureDefinitionTypes';
import { cadFeatureDefinition, cadFeatureLayout, cadFeatureScalar, cadFeatureScalarAccepts, cadFeatureSchemaUnion, findCadFeatureDefinition } from './features/cadFeatureRegistry';
import { CadSketchProfileSchema } from './features/kinds/references';
export { cadConsumedBodyIds, cadFeatureDependencies, cadFeatureInputs, cadFeatureProducesBody, cadVisibleBodyIds, type CadBodyFeature } from './cadFeatureInputs';
export { CadPathSegmentSchema } from './cadPrimitives';
export { CadProfileSchema, CadSketchFeatureSchema, CadSketchProfileSchema } from './features/kinds/references';

const strict = { additionalProperties: false };
const label = CadLabelSchema;
const number = CadNumberSchema;
/** Every stored feature shape, from the kinds' definitions. */
export const CadFeatureSchema = cadFeatureSchemaUnion();
export const CadDocumentSchema = Type.Object({
  format: Type.Literal('wireedm-cad'), schemaVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,95}$' }), name: label, units: Type.Literal('mm'),
  parameters: Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' }), number, { additionalProperties: false }),
  parameterGroups: Type.Optional(Type.Array(CadParameterGroupSchema)),
  parameterMetadata: Type.Optional(Type.Record(CadParameterNameSchema, CadParameterMetadataSchema, { additionalProperties: false })),
  features: Type.Array(CadFeatureSchema)
}, strict);

// Only this parser's detached, deeply frozen successful outputs are trusted.
// Mutable inputs, lookalikes and structured clones still cross the full boundary.
const acceptedDocuments = new WeakSet<CadDocument>();
const acceptedSketchSources = new WeakSet<CadSketchFeature>();
// Every feature of an accepted document. Its boundary checks read only its own frozen data, so a
// new document listing it takes it as it is; checks that read the document still run.
const acceptedFeatures = new WeakSet<object>();
const isAcceptedFeature = (item: unknown): item is CadFeature => typeof item === 'object' && item !== null && acceptedFeatures.has(item);
// Accepted sketches whose geometry was valid, and accepted extrudes and revolves whose sketch had regions
// to use, each with the parameters of the document they were checked in. The checks read only the frozen
// features and the values of the parameters the sketch names, so a parse in which the sketch reads the same
// values skips them. Those names are collected only when a parse lists the sketch again. Failures are never kept.
const validSketches = new WeakMap<CadSketchFeature, CadDocument['parameters']>();
const usableSketches = new WeakMap<CadFeature, { readonly sketch: CadSketchFeature; readonly parameters: CadDocument['parameters'] }>();
// An accepted sketch that differs from an earlier accepted one only in where its dimensions are drawn, mapped to the first of that
// line, whose geometry it shares. The region checks above key on that sketch, so moving a dimension keeps them.
const geometrySources = new WeakMap<CadSketchFeature, CadSketchFeature>();
const geometrySource = (sketch: CadSketchFeature) => geometrySources.get(sketch) ?? sketch;

/**
 * The accepted sketch `sketch` was made from by moving its dimensions alone, the first of that line, or `sketch` itself. It differs
 * only in where dimensions are drawn, so a result that never reads placement can be kept with it across those moves.
 */
export function cadSketchPlacedFrom(sketch: CadSketchFeature): CadSketchFeature {
  return geometrySource(sketch);
}
/**
 * Whether `to` holds the parameters and features of `from` but for dimensions of sketch `sketchId` moved from one to the other, known
 * from identity alone: a result that never reads placement, such as freedom analysis, holds for both. False is no proof of a difference.
 */
export function cadDocumentsPlacedAlike(from: CadDocument, to: CadDocument, sketchId: string): boolean {
  return from === to || from.parameters === to.parameters && from.features.length === to.features.length && from.features.every((feature, index) => {
    const next = to.features[index];
    return feature === next || feature.id === sketchId && feature.kind === 'sketch' && next.kind === 'sketch' && geometrySource(feature) === geometrySource(next);
  });
}
// The document schema with its features left to `CadFeatureSchema`, one by one.
const CadDocumentEnvelopeSchema = { ...CadDocumentSchema, properties: { ...CadDocumentSchema.properties, features: Type.Array(Type.Unknown()) } };

/** Whether `feature` matches `CadFeatureSchema`: the stored shape its kind names, as there is one per kind. */
function matchesCadFeatureSchema(feature: unknown) {
  const definition = typeof feature === 'object' && feature !== null ? findCadFeatureDefinition((feature as { readonly kind?: unknown }).kind) : undefined;
  return definition !== undefined && Value.Check(definition.schema, feature);
}
/** Whether `value` matches `CadDocumentSchema`, taking its accepted features as matching. */
function matchesCadDocumentSchema(value: unknown) {
  return Value.Check(CadDocumentEnvelopeSchema, value)
    && (value as { features: readonly unknown[] }).features.every(feature => isAcceptedFeature(feature) || matchesCadFeatureSchema(feature));
}

/**
 * A detached copy of complete own data `value`. A document listing accepted features keeps them and
 * copies only its other parts, reading its fields and features once through their descriptors, so
 * a transparent proxy there is copied rather than rejected. Any other is copied whole, as before.
 * The parts are copied together, so references they share stay shared. Throws when the copy is not
 * complete own data.
 */
function detachCadDocument(value: unknown): unknown {
  const fields = cadImportDataFields(value), list = fields?.features;
  if (!fields || !Array.isArray(list)) return structuredClone(value);
  // The length too, as the import-data walk reads it, never through a proxy's `get`.
  const length: unknown = Object.getOwnPropertyDescriptor(list, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return structuredClone(value);
  const items = Array.from({ length }, (_, index) => Object.getOwnPropertyDescriptor(list, index)?.value);
  if (!items.some(isAcceptedFeature)) return structuredClone(value);
  const [envelope, ...copies] = structuredClone([Object.fromEntries(Object.entries(fields).filter(([name]) => name !== 'features')), ...items.filter(item => !isAcceptedFeature(item))]);
  let next = 0;
  const features = items.map(item => isAcceptedFeature(item) ? item : copies[next++]);
  const copy = Object.fromEntries(Object.keys(fields).map(name => [name, name === 'features' ? features : envelope[name]]));
  // A proxy can answer these reads differently from the walk before them, so the copy, which every
  // later check reads, is walked as well: only its envelope and the features that were copied.
  if (!isCadImportData(copy, isAcceptedFeature)) throw new TypeError('The CAD document copy is not complete own data.');
  return copy;
}

/** Provenance for internal geometry reuse; a caller's frozen lookalike is not accepted. */
export function isAcceptedCadSketchSource(sketch: CadSketchFeature): boolean {
  return acceptedSketchSources.has(sketch);
}

/**
 * Whether an accepted sketch's geometry was found valid under the values it reads from these parameters.
 * Its graph's relations then hold under them too, since compiling the graph requires that.
 */
export function hasValidCadSketchGeometry(sketch: CadSketchFeature, parameters: CadDocument['parameters']): boolean {
  const checked = validSketches.get(sketch);
  return Boolean(checked && sameCadSketchGeometryParameters(sketch, checked, parameters));
}

const storedField = (feature: CadFeature, field: string) => (feature as unknown as Readonly<Record<string, unknown>>)[field];
/** Whether `feature` gives later features `trait`. */
function gives(feature: CadFeature | undefined, trait: CadFeatureTrait) {
  return feature !== undefined && cadFeatureDefinition(feature.kind).outputs.includes(trait);
}
/** Refuses a dimension of `size` outside its declared range. */
function refuseOutOfRange(scalar: CadFeatureScalar, size: number) {
  if (!cadFeatureScalarAccepts(scalar, size)) throw new CadError('invalid-dimension', scalar.refusal ?? 'Dimension is out of range.');
}

/** Strict boundary parser. Never rewrites IDs, geometry, units or saved expressions. */
export function parseCadDocument(value: unknown): CadDocument {
  if (typeof value === 'object' && value !== null && acceptedDocuments.has(value as CadDocument)) return value as CadDocument;
  if (!isCadImportData(value, isAcceptedFeature)) throw new CadError('invalid-document', 'CAD documents must contain their own complete JSON data fields.');
  // A sketch storing a reserved id is refused with that reason, which the schema check below would not give.
  const features = (value as { readonly features?: unknown }).features;
  if (Array.isArray(features)) for (const feature of features as readonly unknown[]) {
    if (typeof feature === 'object' && feature !== null && (feature as { readonly kind?: unknown }).kind === 'sketch') assertNoReservedCadSketchIds((feature as { readonly graph?: unknown }).graph);
  }
  if (!matchesCadDocumentSchema(value)) {
    const error = Value.Errors(CadDocumentSchema, value).First();
    throw new CadError('invalid-document', `Invalid CAD document${error ? ` at ${error.path || '/'}: ${error.message}` : '.'}`);
  }
  // A boundary input may have inherited fields or accessors. Validate semantics
  // against its detached own-data snapshot, never against changing getters.
  let snapshot: Static<typeof CadDocumentSchema>;
  try { snapshot = detachCadDocument(value) as Static<typeof CadDocumentSchema>; }
  catch { throw new CadError('invalid-document', 'CAD document must contain portable declarative data.'); }
  if (!matchesCadDocumentSchema(snapshot)) throw new CadError('invalid-document', 'CAD document must contain its own complete JSON fields.');
  const document: CadDocument = snapshot;
  validateCadParameterMetadata(document);
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(document.id)) throw new CadError('invalid-document-id', 'Document ID is a reserved filesystem name.');
  for (const name of Object.keys(document.parameters)) {
    if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new CadError('invalid-parameter', `Parameter name "${name}" is reserved.`);
  }
  const previous = new Map<string, CadFeature>();
  const datumFrames = new Map<string, CadResolvedFrame>();
  // Stored targets name the feature whose result a body is; they resolve to bodies by key through the lineage.
  const bodies = createCadBodyLineage();
  const expandedInstances = new Map<string, number>();
  let instanceBudget = 0;
  // Kept only once the whole document is accepted, with every feature they name.
  const certificates: (() => void)[] = [];
  const evaluate = (scalar: CadScalar) => evaluateCadScalar(scalar, document.parameters);
  const context: { -readonly [Key in keyof CadFeatureCheckContext]: CadFeatureCheckContext[Key] } = {
    document, active: false, previous, datums: Object.freeze({ get: (id: string) => datumFrames.get(id) }), value: evaluate,
    scalar(feature, field) {
      const scalar = cadFeatureScalar(feature.kind, field), result = evaluate(storedField(feature, field) as CadScalar);
      refuseOutOfRange(scalar, scalar.magnitude ? Math.abs(result) : result);
      return result;
    },
    vector(feature, field) {
      const scalar = cadFeatureScalar(feature.kind, field), result = (storedField(feature, field) as CadPoint3).map(evaluate);
      if (scalar.nonzero && result.every(component => Math.abs(component) <= (scalar.tolerance ?? 0))) throw new CadError('invalid-dimension', scalar.refusal ?? 'Dimension must be nonzero.');
      for (const component of result) refuseOutOfRange(scalar, scalar.magnitude ? Math.abs(component) : component);
      return result;
    },
    addDatumFrame(id, frame) { datumFrames.set(id, frame); },
    checkSketchGeometry(sketch) {
      const checked = validSketches.get(sketch);
      if (!checked || !sameCadSketchGeometryParameters(sketch, checked, document.parameters)) {
        validateCadSketchGeometry(sketch, document.parameters);
        certificates.push(() => validSketches.set(sketch, document.parameters));
      }
    },
    checkUsableSketch(feature, sketch, selection) {
      // Only an active sketch with regions is kept, so the same sketch object is still active.
      const usable = usableSketches.get(feature);
      if (usable?.sketch !== geometrySource(sketch) || !sameCadSketchGeometryParameters(sketch, usable.parameters, document.parameters)) {
        if (!cadFeatureActive(sketch, document) || !resolveCadSketchRegions(sketch, document.parameters, selection).length) throw new CadError('empty-sketch', `Feature "${feature.name}" needs an active nonempty sketch.`);
        certificates.push(() => usableSketches.set(feature, { sketch: geometrySource(sketch), parameters: document.parameters }));
      }
    }
  };
  for (const feature of document.features) {
    if (previous.has(feature.id)) throw new CadError('duplicate-id', `Duplicate feature ID "${feature.id}".`);
    const definition = cadFeatureDefinition(feature.kind), layout = cadFeatureLayout(feature), active = cadFeatureActive(feature, document);
    context.active = active;
    const inputs = cadFeatureInputs(feature);
    for (const id of inputs.datumIds) {
      if (!gives(previous.get(id), 'plane')) throw new CadError('invalid-reference', `Feature "${feature.name}" needs a preceding datum plane "${id}".`);
    }
    for (const id of inputs.sketchIds) {
      if (!gives(previous.get(id), 'sketch')) throw new CadError('invalid-reference', `Feature "${feature.name}" needs a preceding sketch "${id}".`);
    }
    for (const id of inputs.curveIds) {
      if (!gives(previous.get(id), 'curve')) throw new CadError('invalid-reference', `Feature "${feature.name}" needs a preceding reference curve "${id}".`);
    }
    for (const id of inputs.bodyIds) {
      const referenced = previous.get(id);
      if (!referenced) throw new CadError('invalid-reference', `Feature "${feature.name}" references missing or later feature "${id}".`);
      if (!cadFeatureProducesBody(referenced)) throw new CadError('invalid-reference', `A solid operation cannot target ${referenced.kind === 'sketch' ? 'a sketch' : referenced.kind === 'curve' ? 'a reference curve' : 'a datum plane'}.`);
    }
    if (active) for (const id of inputs.bodyIds) {
      if (!bodies.has(id)) throw new CadError('unavailable-body', `Feature "${feature.name}" references suppressed or already consumed body "${id}". Select its current successor.`);
    }
    const operandInstances = inputs.bodyIds.reduce((total, id) => total + (expandedInstances.get(id) ?? 1), 0);
    for (const { name, field } of layout.checked) {
      const held = storedField(feature, name);
      if (held !== undefined && held !== null) field.check!(held, context);
    }
    // Pad and Revolve count their sketch as no operand, as saved histories were budgeted that way.
    let instances = definition.instances ? definition.instances(feature, operandInstances, context) : definition.body === 'none' ? 0 : operandInstances || 1;
    for (const name of layout.repeats) instances *= storedField(feature, name) as number;
    if (instances > MAX_CAD_PATTERN_INSTANCES) throw new CadError('feature-limit', 'Nested pattern expansion exceeds 1000 solid instances.');
    for (const { name, meaning } of layout.conditioned) {
      if ((storedField(feature, meaning.field) === meaning.absentWhen) !== (storedField(feature, name) === null)) throw new CadError('invalid-operation', meaning.refusal);
    }
    definition.check?.(feature, context);
    for (const name of layout.repeats) {
      instanceBudget += storedField(feature, name) as number;
      if (instanceBudget > MAX_CAD_PATTERN_INSTANCES) throw new CadError('feature-limit', 'Document has too many pattern instances.');
    }
    previous.set(feature.id, feature);
    expandedInstances.set(feature.id, instances);
    bodies.apply(feature, document);
  }
  // Detach from callers, then freeze the complete history so neither a caller's
  // edit payload nor a UI/tool snapshot can mutate an accepted revision later.
  function freeze(value: unknown): void {
    // An accepted feature is frozen through already.
    if (value === null || typeof value !== 'object' || acceptedFeatures.has(value)) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  freeze(document);
  for (const feature of document.features) {
    acceptedFeatures.add(feature);
    if (feature.kind === 'sketch') acceptedSketchSources.add(feature);
  }
  certificates.forEach(certify => certify());
  acceptedDocuments.add(document);
  return document;
}

/**
 * The accepted `document` with the sketch `sketchId` drawing the dimensions `relations` name where they say, each differing from its
 * accepted relation only in its placement. Placement is display data that no document check reads, so only the new placements are
 * checked: every other feature stays as it is, and the sketch keeps its geometry's certificates. Null when `document` is not an
 * accepted parse, or a relation is new or changes more than its placement; such an edit takes the full parse.
 */
export function withCadSketchPlacements(document: CadDocument, sketchId: string, relations: readonly unknown[]): CadDocument | null {
  if (!acceptedDocuments.has(document)) return null;
  const index = document.features.findIndex(feature => feature.id === sketchId), sketch = document.features[index];
  if (sketch?.kind !== 'sketch' || !sketch.graph) return null;
  const graph = cadSketchGraphWithPlacements(sketch.graph, relations);
  if (!graph) return null;
  if (graph === sketch.graph) return document;
  const placed: CadSketchFeature = Object.freeze({ ...sketch, graph });
  const next: CadDocument = Object.freeze({ ...document, features: Object.freeze(document.features.map((feature, at) => at === index ? placed : feature)) });
  acceptedFeatures.add(placed); acceptedSketchSources.add(placed);
  const checked = validSketches.get(sketch);
  if (checked) validSketches.set(placed, checked);
  geometrySources.set(placed, geometrySource(sketch));
  acceptedDocuments.add(next);
  return next;
}

export function createCadDocument(name = 'Untitled part', id = `cad_${crypto.randomUUID()}`): CadDocument {
  return parseCadDocument({ format: 'wireedm-cad', schemaVersion: 1, id, name, units: 'mm', parameters: {}, features: [] });
}

/** Shared contour default for drawing and declarative authoring: nesting is automatic. */
export function createCadSketchProfile(input: { readonly geometry: CadProfile; readonly id?: string; readonly name?: string; readonly construction?: boolean; readonly constraints?: CadSketchProfile['constraints'] }): CadSketchProfile {
  const value = { id: input.id ?? `contour_${crypto.randomUUID()}`, name: input.name ?? 'Contour', construction: input.construction ?? false, geometry: input.geometry,
    ...(input.constraints ? { constraints: input.constraints } : {}) };
  if (!Value.Check(CadSketchProfileSchema, value)) throw new CadError('invalid-profile', 'Malformed sketch contour.');
  let profile: CadSketchProfile;
  try { profile = structuredClone(value); }
  catch { throw new CadError('invalid-profile', 'Sketch contours must contain portable declarative data.'); }
  if (!Value.Check(CadSketchProfileSchema, profile)) throw new CadError('invalid-profile', 'Sketch contours must contain their own complete fields.');
  validateCadSketchConstraints(profile);
  function freeze(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    Object.values(item).forEach(freeze); Object.freeze(item);
  }
  freeze(profile); return profile;
}

export function validateCadDocument(document: CadDocument): readonly CadDiagnostic[] {
  try { parseCadDocument(document); return []; }
  catch (error) { if (error instanceof CadError) return [{ code: error.code, message: error.message }]; throw error; }
}
