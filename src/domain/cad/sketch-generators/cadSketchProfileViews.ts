import type { CadDocument, CadProfile, CadSketchFeature, CadSketchProfile } from '../cadDocument';
import { Value } from '@sinclair/typebox/value';
import { CadError } from '../cadError';
import type { CadEdit } from '../cadOperations';
import type { CadSketchGenerator } from '../cadSketchGraph';
import { deleteCadSketchElements } from '../cadSketchGraphEdits';
import { cadSketchGeneratorPrefixFor } from './cadSketchGeneratorEdits';
import { cadSketchGeneratorKind, cadSketchGeneratorOutlines, cadSketchGenerators } from './cadSketchGenerators';

// The shapes people configure as profiles: a sketch's saved legacy profiles, then each generator of a profile's geometry, seen as the
// profile it replaces. The profile editor, the plugin panel, the parameter bindings and CAM notes read generators through these views,
// so a generator is configured as a profile was, and a view's change is written back to its generator's record. A generator whose shape
// no profile had, such as a regular polygon, a circular pattern or a linked offset, has no view.

export type CadSketchProfileGenerator = CadSketchGenerator & { readonly geometry: CadProfile };
const NOT_PROFILES: ReadonlySet<CadSketchGenerator['geometry']['kind']> = new Set(['regular-polygon', 'circular-pattern', 'offset']);
const isProfileGenerator = (generator: CadSketchGenerator): generator is CadSketchProfileGenerator => !NOT_PROFILES.has(generator.geometry.kind);

const views = new WeakMap<CadSketchGenerator, CadSketchProfile>();
/**
 * The profile `generator` is seen as; one object per record, so an unchanged record keeps its view. A listed polygon's or path's entry ids
 * are the record's, not the profile's: a view written back with other points or segments takes them anew from the record it replaces.
 */
function generatorProfile(generator: CadSketchProfileGenerator): CadSketchProfile {
  let view = views.get(generator);
  if (!view) {
    const { ids: _ids, ...geometry } = generator.geometry as CadProfile & { readonly ids?: readonly number[] };
    view = Object.freeze({ id: generator.id, name: generator.name ?? cadSketchGeneratorKind(generator.geometry).label(generator.geometry),
      construction: generator.construction, geometry: 'ids' in generator.geometry ? geometry as CadProfile : generator.geometry });
    views.set(generator, view);
  }
  return view;
}

const sketchViews = new WeakMap<CadSketchFeature, readonly CadSketchProfile[]>();
/** The sketch's legacy profiles, then its generators of profile geometry as profiles, in relation order. */
export function cadSketchProfileViews(sketch: CadSketchFeature): readonly CadSketchProfile[] {
  const kept = sketchViews.get(sketch);
  if (kept) return kept;
  const generators = sketch.graph ? cadSketchGenerators(sketch.graph).filter(isProfileGenerator) : [];
  const result = generators.length ? Object.freeze([...sketch.profiles, ...generators.map(generatorProfile)]) : sketch.profiles;
  if (Object.isFrozen(sketch)) sketchViews.set(sketch, result);
  return result;
}

const outlineViews = new WeakMap<CadSketchGenerator, { readonly shape: unknown; readonly view: CadSketchProfile }>();
/**
 * Each generator of the sketch with no profile view that draws a closed outline, such as a regular polygon, as a profile of that outline
 * from `parameters`, in relation order: what a canvas picks and selects as the generator, never a view an edit writes back.
 */
export function cadSketchOutlineViews(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>): readonly CadSketchProfile[] {
  if (!sketch.graph) return [];
  const result: CadSketchProfile[] = [];
  for (const { generator, shape } of cadSketchGeneratorOutlines(sketch.graph, parameters).values()) {
    if (isProfileGenerator(generator)) continue;
    let kept = outlineViews.get(generator);
    if (kept?.shape !== shape) outlineViews.set(generator, kept = { shape, view: Object.freeze({ id: generator.id,
      name: generator.name ?? cadSketchGeneratorKind(generator.geometry).label(generator.geometry), construction: generator.construction, geometry: shape }) });
    result.push(kept.view);
  }
  return result;
}

/** The generator the profile view `profileId` of `sketch` stands for; undefined for a legacy profile or an id with no view. */
export function cadSketchProfileGenerator(sketch: CadSketchFeature, profileId: string): CadSketchProfileGenerator | undefined {
  const generator = sketch.graph?.relations.find(relation => relation.id === profileId);
  return generator?.kind === 'generator' && isProfileGenerator(generator) ? generator : undefined;
}

/**
 * The sketch with the profile view `next` written back: a legacy profile is replaced, and a generator takes its name, construction flag
 * and geometry, keeping its id and prefix. Its members regenerate when the edit settles.
 */
export function withCadSketchProfile(sketch: CadSketchFeature, next: CadSketchProfile): CadSketchFeature {
  const generator = cadSketchProfileGenerator(sketch, next.id);
  if (!generator || !sketch.graph) return { ...sketch, profiles: sketch.profiles.map(entry => entry.id === next.id ? next : entry) };
  const { name: _name, ...unnamed } = generator;
  // A name left as the one shown, the kind's own when the generator has none, is not stored.
  const name = next.name.trim() && next.name !== generatorProfile(generator).name ? next.name : generator.name;
  const geometry = next.geometry === generatorProfile(generator).geometry ? generator.geometry : next.geometry;
  const replaced: CadSketchGenerator = { ...unnamed, ...name ? { name } : {}, construction: next.construction, geometry };
  return { ...sketch, graph: { ...sketch.graph, relations: sketch.graph.relations.map(relation => relation === generator ? replaced : relation) } };
}

/**
 * The edits that set `parameters`, then write the profile view `next` back to `sketch`: a generator's inputs with set-sketch-generator,
 * which confirms it removes `removedRelationIds` with the members that leave, and a legacy profile with an update of the sketch. A
 * view that only reads changed parameters confirms the removals with its last parameter.
 */
export function cadSketchProfileEdits(sketch: CadSketchFeature, next: CadSketchProfile, parameters: Readonly<Record<string, number>> = {},
  removedRelationIds: readonly string[] = []): CadEdit[] {
  const set: CadEdit[] = Object.entries(parameters).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, value]) => ({ kind: 'set-parameter', name, value }));
  const generator = cadSketchProfileGenerator(sketch, next.id), confirmed = removedRelationIds.length ? { removedRelationIds: [...removedRelationIds] } : {};
  const confirming = () => [...set.slice(0, -1), { ...set[set.length - 1], ...confirmed }];
  if (!generator) return [...set.length ? confirming() : [], { kind: 'update-feature', feature: withCadSketchProfile(sketch, next) }];
  const replaced = withCadSketchProfile(sketch, next).graph!.relations.find(relation => relation.id === next.id) as CadSketchGenerator;
  if (Value.Equal(replaced, generator) && set.length) return confirming();
  return [...set, { kind: 'set-sketch-generator', sketchId: sketch.id, generator: replaced, ...confirmed }];
}

/** The sketch without the profile view `profileId`: a legacy profile goes alone, a generator with its members and the relations on them. */
export function withoutCadSketchProfile(sketch: CadSketchFeature, profileId: string): CadSketchFeature {
  if (!cadSketchProfileGenerator(sketch, profileId)) return { ...sketch, profiles: sketch.profiles.filter(entry => entry.id !== profileId) };
  return deleteCadSketchElements({ sketch, pointIds: [], entityIds: [], relationIds: [profileId], cascade: true });
}

/**
 * The edits that add the shape `geometry` to `sketch`, as drawing or the profile tools do: a generator with the id `id`, named for its kind
 * and the sketch's shape count, configured afterwards as its profile was. A closed path is kept as its own lines and arcs, so it is
 * generated and detached in the same step. No edit adds a saved profile.
 */
export function cadSketchShapeEdits(sketch: CadSketchFeature, geometry: CadProfile, { id, construction }: { readonly id: string; readonly construction: boolean }): CadEdit[] {
  const name = `${geometry.kind[0].toUpperCase()}${geometry.kind.slice(1)} ${cadSketchProfileViews(sketch).length + 1}`;
  const generator: CadSketchGenerator = { id, kind: 'generator', idPrefix: cadSketchGeneratorPrefixFor(sketch, id), name, construction, geometry };
  return [{ kind: 'set-sketch-generator', sketchId: sketch.id, generator },
    ...geometry.kind === 'path' ? [{ kind: 'detach-sketch-generator', sketchId: sketch.id, generatorId: id } as const] : []];
}

/**
 * Refuses an edit batch that gives a sketch a legacy profile it did not have: saved profiles load and stay editable, but new shapes are
 * generators or sketch geometry. `edits` run in order from `document`, so a profile added and later edited in one batch is refused once.
 */
export function refuseNewCadSketchProfiles(document: CadDocument, edits: readonly CadEdit[]): void {
  const known = new Map(document.features.flatMap(feature => feature.kind === 'sketch' ? [[feature.id, new Set(feature.profiles.map(profile => profile.id))] as const] : []));
  for (const edit of edits) {
    if ((edit.kind !== 'add-feature' && edit.kind !== 'update-feature') || edit.feature.kind !== 'sketch') continue;
    const had = edit.kind === 'update-feature' ? known.get(edit.feature.id) : undefined;
    const added = edit.feature.profiles.find(profile => !had?.has(profile.id));
    if (added) throw new CadError('legacy-sketch-profile', `Sketch "${edit.feature.id}" cannot gain the profile "${added.id}". Saved profiles stay editable, but a new shape is a generator: add it with a set-sketch-generator edit, or draw it with append-sketch-entities.`);
    known.set(edit.feature.id, new Set(edit.feature.profiles.map(profile => profile.id)));
  }
}
