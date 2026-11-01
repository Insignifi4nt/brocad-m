import type { CadFeature, CadSketchFeature } from '../cadDocument';
import { CadError } from '../cadError';
import type { CadSketchGenerator, CadSketchGraph } from '../cadSketchGraph';
import {
  cadSketchGeneratorMembers, cadSketchGeneratorName, cadSketchGeneratorOwner, cadSketchGenerators, cadSketchIdNamespace, settleCadSketchGenerators
} from './cadSketchGenerators';

const EMPTY_GRAPH: CadSketchGraph = Object.freeze({ points: Object.freeze([]), entities: Object.freeze([]), relations: Object.freeze([]) });

/**
 * The sketch with the generator `generator` created, or with its inputs replaced when one with its id exists. A new generator's prefix
 * must name a namespace nothing in the sketch uses; an existing one keeps its prefix. Its members are made when the edit settles (see
 * `settleCadSketchGenerators`), which also takes the user relations on members that leave through the relation remap.
 */
export function setCadSketchGenerator(sketch: CadSketchFeature, generator: CadSketchGenerator): CadSketchFeature {
  const graph = sketch.graph ?? EMPTY_GRAPH, name = cadSketchGeneratorName(generator);
  const previous = graph.relations.find(relation => relation.id === generator.id);
  if (previous && previous.kind !== 'generator') throw new CadError('duplicate-sketch-id', `Sketch identity "${generator.id}" already names a ${previous.kind} relation. Choose a fresh identity for ${name}.`);
  const owner = cadSketchGeneratorOwner(graph, generator.id);
  if (owner) throw new CadError('owned-sketch-generator', `${name} cannot take an id that ${cadSketchGeneratorName(owner)} generates.`);
  if (previous) {
    if (previous.idPrefix !== generator.idPrefix)
      throw new CadError('invalid-sketch-generator', `${name} keeps its id prefix "${previous.idPrefix}". Detach it and create a new generator to use another prefix.`);
  } else {
    const ids = [...graph.points, ...graph.entities, ...graph.relations].map(item => item.id).concat(sketch.profiles.map(profile => profile.id));
    const taken = ids.find(id => cadSketchIdNamespace(id) === generator.idPrefix);
    if (taken !== undefined) throw new CadError('invalid-sketch-generator', `${name} cannot use the id prefix "${generator.idPrefix}": sketch identity "${taken}" is already in that namespace.`);
  }
  const relations = previous ? graph.relations.map(relation => relation.id === generator.id ? generator : relation) : [...graph.relations, generator];
  return { ...sketch, graph: { ...graph, relations } };
}

/** The sketch with the generator `generatorId` removed and its members kept as ordinary geometry, relations and all. */
export function detachCadSketchGenerator(sketch: CadSketchFeature, generatorId: string): CadSketchFeature {
  const graph = sketch.graph, generator = graph?.relations.find(relation => relation.id === generatorId);
  if (!graph || generator?.kind !== 'generator') throw new CadError('missing-sketch-relation', `Sketch generator "${generatorId}" no longer exists.`);
  return { ...sketch, graph: { ...graph, relations: graph.relations.filter(relation => relation !== generator) } };
}

/**
 * The points, edges and relations a deletion removes with the generators it names: each one's members, which go with it. A member named
 * on its own is refused, naming its generator, unless its generator goes too.
 */
export function cadSketchGeneratorDeletion(graph: CadSketchGraph, selected: { readonly pointIds: Set<string>; readonly entityIds: Set<string>; readonly relationIds: Set<string> }): void {
  if (!cadSketchGenerators(graph).length) return;
  const removed = cadSketchGenerators(graph).filter(generator => selected.relationIds.has(generator.id));
  const going = new Set(removed.map(generator => generator.idPrefix));
  for (const [ids, kind] of [[selected.pointIds, 'point'], [selected.entityIds, 'entity'], [selected.relationIds, 'relation']] as const) for (const id of ids) {
    const owner = cadSketchGeneratorOwner(graph, id);
    if (owner && !going.has(owner.idPrefix))
      throw new CadError('owned-sketch-generator', `${cadSketchGeneratorName(owner)} generates sketch ${kind} "${id}". Delete or detach the generator instead.`);
  }
  for (const generator of removed) {
    const members = cadSketchGeneratorMembers(graph, generator);
    for (const id of members.pointIds) selected.pointIds.add(id);
    for (const id of members.entityIds) selected.entityIds.add(id);
    for (const id of members.relationIds) selected.relationIds.add(id);
  }
}


/**
 * The features an edit batch made from `before`, with each sketch's generators settled under `parameters`: members an edit left as they
 * were regenerate from the current inputs, and an edit of a member itself is refused, naming its generator. Unchanged features whose
 * generators make the same members are kept as they are.
 */
export function settleCadDocumentGenerators(before: readonly CadFeature[], features: readonly CadFeature[], parameters: Readonly<Record<string, number>>): CadFeature[] {
  const previous = new Map(before.map(feature => [feature.id, feature]));
  return features.map(feature => {
    if (feature.kind !== 'sketch' || !feature.graph || !feature.graph.relations.some(relation => relation.kind === 'generator')) return feature;
    const earlier = previous.get(feature.id), graph = settleCadSketchGenerators(feature.graph, earlier?.kind === 'sketch' ? earlier.graph : undefined, parameters);
    return graph === feature.graph ? feature : { ...feature, graph };
  });
}
