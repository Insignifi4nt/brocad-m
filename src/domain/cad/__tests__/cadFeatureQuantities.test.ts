import type { TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { CadFeature } from '../cadDocument';
import { mapCadFeatureScalars } from '../cadParameters';
import type { CadFeatureKind } from '../features/cadFeatureDefinitionTypes';
import { cadFeatureDefinition, cadFeatureKinds, cadFeatureLayout, cadFeatureQuantityAt } from '../features/cadFeatureRegistry';
import { cadKernelParityModels } from '../../../features/cad/kernel/__tests__/cadKernelParity';

/**
 * A plugin profile pins a copy of its package, whose numbers are the package's own (its API version, its inputs' defaults and bounds, its
 * generator recipe and its rules), not dimensions of the feature. The inputs the profile passes to it are declared.
 */
// A plugin's pinned package, on a profile or a generator: its numbers are the package's own rules, not the part's.
const PINNED_PACKAGE = /^(profiles\.\*\.geometry|graph\.relations\.\*\{generator\}\.geometry)\{plugin\}\.package(\.|$)/;

type Segment = { readonly key: string; readonly kind?: string };
const segments = (path: string): readonly Segment[] => path.split('.').map(segment => {
  const kind = /\{([^{}]+)\}$/.exec(segment);
  return kind ? { key: segment.slice(0, kind.index), kind: kind[1] } : { key: segment };
});

type SchemaNode = TSchema & {
  anyOf?: SchemaNode[]; properties?: Record<string, SchemaNode>; items?: SchemaNode | SchemaNode[]; patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean; type?: string; const?: unknown;
};
/**
 * Every number `schema` accepts, by path: `*` for any array item or record key, and `{kind}` after the key of an object that has one.
 * A scalar (a number or an expression) counts as one number. The feature's own kind is left out.
 */
function numericLeaves(schema: SchemaNode, path: string, out: Set<string>): Set<string> {
  if (schema.anyOf) {
    const types = schema.anyOf.map(entry => entry.type);
    if (schema.anyOf.length === 2 && types.includes('number') && types.includes('string')) out.add(path);
    else for (const variant of schema.anyOf) numericLeaves(variant, path, out);
  } else if (schema.type === 'number' || schema.type === 'integer') out.add(path);
  else if (schema.type === 'object') {
    const kind = schema.properties?.kind?.const;
    const at = kind === undefined || !path ? path : `${path}{${String(kind)}}`;
    for (const [name, child] of Object.entries(schema.properties ?? {})) numericLeaves(child, at ? `${at}.${name}` : name, out);
    for (const child of [...Object.values(schema.patternProperties ?? {}), ...typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []])
      numericLeaves(child, `${at}.*`, out);
  } else if (schema.type === 'array') {
    if (Array.isArray(schema.items)) schema.items.forEach((item, index) => numericLeaves(item, `${path}.${index}`, out));
    else if (schema.items) numericLeaves(schema.items, `${path}.*`, out);
  }
  return out;
}
/** Whether a declared pattern covers a schema leaf: `*` covers any key, and a pattern's kind must be the leaf's. */
function covers(pattern: string, leaf: string): boolean {
  const want = segments(pattern), have = segments(leaf);
  return want.length === have.length && want.every(({ key, kind }, index) =>
    (key === '*' || key === have[index].key) && (kind === undefined || kind === have[index].kind));
}

/** The numbers stored in `value`, by their concrete path. */
function storedNumbers(value: unknown, path: string, out: string[] = []): string[] {
  if (typeof value === 'number') out.push(path);
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) storedNumbers(child, path ? `${path}.${key}` : key, out);
  return out;
}

/** The parity models, which hold every kind and every step of the benchmark cases. */
const corpus = (): readonly CadFeature[] => cadKernelParityModels().flatMap(model => model.document.features);

describe('CAD feature quantities', () => {
  it.each(cadFeatureKinds())('declare what every number a %s feature stores measures, once', (kind: CadFeatureKind) => {
    const definition = cadFeatureDefinition(kind);
    const leaves = [...numericLeaves(definition.schema as SchemaNode, '', new Set())].filter(leaf => !PINNED_PACKAGE.test(leaf));
    const declared = cadFeatureLayout({ kind }).quantities;
    for (const leaf of leaves) expect(declared.filter(({ path }) => covers(path, leaf)).map(({ path }) => path), leaf).toHaveLength(1);
    for (const { path } of declared) expect(leaves.some(leaf => covers(path, leaf)), `${path} covers a stored number`).toBe(true);
    // A top-level dimension's quantity is its scalar's.
    for (const { name, meaning } of cadFeatureLayout({ kind }).scalars)
      expect(declared.find(({ path }) => path === name || path === `${name}.*`)?.quantity, name).toBe(meaning.quantity);
  });

  it('resolve the quantity of every number and expression stored across the parity and benchmark documents', () => {
    const features = corpus(), missing: string[] = [];
    for (const feature of features) {
      // Only a plugin profile's or generator's geometry holds a package.
      const paths = storedNumbers(feature, '').filter(path => !/^(profiles\.\d+|graph\.relations\.\d+)\.geometry\.package\./.test(path));
      mapCadFeatureScalars(feature, (value, path) => { paths.push(path); return value; });
      for (const path of new Set(paths)) if (cadFeatureQuantityAt(feature, path) === undefined) missing.push(`${feature.kind} ${path}`);
    }
    expect(missing).toEqual([]);
    expect(new Set(features.map(feature => feature.kind))).toEqual(new Set(cadFeatureKinds()));
  });
});
