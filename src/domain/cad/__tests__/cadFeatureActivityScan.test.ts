import { describe, expect, it } from 'vitest';
import { checkFeatureActivity, featureActivityReadsIn } from '../../../../scripts/check-feature-activity';

const scan = (text: string) => featureActivityReadsIn('fixture.ts', text);
/** Each line of `lines` read on its own, with the spellings found in it. */
const each = (lines: readonly string[]) => lines.map(line => [line, scan(line).map(read => read.spelling)]);

describe('feature activity scanner', () => {
  it('finds each spelling of a read of the stored suppression flag, on its line', () => {
    const source = [
      'const a = feature.suppressed;',
      'const b = feature?.suppressed;',
      "const c = feature['suppressed'];",
      'const d = feature[`suppressed`];',
      'const { suppressed } = feature;',
      'const { suppressed: off } = feature;',
      'const pick = ({ suppressed }: CadFeature) => suppressed;',
      "const { 'suppressed': quoted } = feature;",
      'for (const { suppressed: each } of features) void each;'
    ].join('\n');
    expect(scan(source)).toEqual([
      { spelling: '.suppressed', line: 1 },
      { spelling: '.suppressed', line: 2 },
      { spelling: "['suppressed']", line: 3 },
      { spelling: "['suppressed']", line: 4 },
      { spelling: '{ suppressed }', line: 5 },
      { spelling: '{ suppressed }', line: 6 },
      { spelling: '{ suppressed }', line: 7 },
      { spelling: '{ suppressed }', line: 8 },
      { spelling: '{ suppressed }', line: 9 }
    ]);
  });

  it('finds element access by any literal key, optional or wrapped', () => {
    expect(each([
      "const a = feature?.['suppressed'];",
      'const b = feature?.[`suppressed`];',
      "const c = feature[('suppressed')];",
      "const d = feature['suppressed' as const];",
      "const e = feature!['suppressed' satisfies string];",
      "const KEY = 'suppressed'; const f = feature[KEY];",
      "const KEY = 'suppressed' as const; const g = feature?.[KEY];"
    ])).toEqual([
      ["const a = feature?.['suppressed'];", ["['suppressed']"]],
      ['const b = feature?.[`suppressed`];', ["['suppressed']"]],
      ["const c = feature[('suppressed')];", ["['suppressed']"]],
      ["const d = feature['suppressed' as const];", ["['suppressed']"]],
      ["const e = feature!['suppressed' satisfies string];", ["['suppressed']"]],
      ["const KEY = 'suppressed'; const f = feature[KEY];", ["['suppressed']"]],
      ["const KEY = 'suppressed' as const; const g = feature?.[KEY];", ["['suppressed']"]]
    ]);
  });

  it('finds destructuring by a computed key, at any depth and beside rest or defaults', () => {
    expect(each([
      "const { ['suppressed']: off } = feature;",
      'const { [`suppressed`]: off } = feature;',
      "const KEY = 'suppressed'; const { [KEY]: off } = feature;",
      'const { geometry, suppressed: off = false, ...rest } = feature;',
      'const { suppressed: _, ...rest } = feature;',
      'const [{ suppressed }] = features;',
      'const { first: { suppressed } } = pair;',
      "function pick({ ['suppressed']: off }: CadFeature) { return off; }",
      'try { run(); } catch ({ suppressed }) { void suppressed; }'
    ])).toEqual([
      ["const { ['suppressed']: off } = feature;", ['{ suppressed }']],
      ['const { [`suppressed`]: off } = feature;', ['{ suppressed }']],
      ["const KEY = 'suppressed'; const { [KEY]: off } = feature;", ['{ suppressed }']],
      ['const { geometry, suppressed: off = false, ...rest } = feature;', ['{ suppressed }']],
      ['const { suppressed: _, ...rest } = feature;', ['{ suppressed }']],
      ['const [{ suppressed }] = features;', ['{ suppressed }']],
      ['const { first: { suppressed } } = pair;', ['{ suppressed }']],
      ["function pick({ ['suppressed']: off }: CadFeature) { return off; }", ['{ suppressed }']],
      ['try { run(); } catch ({ suppressed }) { void suppressed; }', ['{ suppressed }']]
    ]);
  });

  it('finds destructuring assignment, at any depth and in loops', () => {
    expect(each([
      '({ suppressed: off } = feature);',
      '({ suppressed } = feature);',
      "({ ['suppressed']: off } = feature);",
      '({ [`suppressed`]: off } = feature);',
      '({ suppressed: off = false, ...rest } = feature);',
      '({ suppressed = false } = feature);',
      '[{ suppressed }] = features;',
      '[first, ...[{ suppressed: off }]] = features;',
      '({ first: { suppressed: off } } = pair);',
      '[{ suppressed: off } = fallback] = features;',
      'for ({ suppressed: off } of features) count(off);',
      'for ([{ suppressed: off }] of pairs) count(off);',
      'next = ({ suppressed: off } = feature);'
    ])).toEqual([
      ['({ suppressed: off } = feature);', ['{ suppressed } =']],
      ['({ suppressed } = feature);', ['{ suppressed } =']],
      ["({ ['suppressed']: off } = feature);", ['{ suppressed } =']],
      ['({ [`suppressed`]: off } = feature);', ['{ suppressed } =']],
      ['({ suppressed: off = false, ...rest } = feature);', ['{ suppressed } =']],
      ['({ suppressed = false } = feature);', ['{ suppressed } =']],
      ['[{ suppressed }] = features;', ['{ suppressed } =']],
      ['[first, ...[{ suppressed: off }]] = features;', ['{ suppressed } =']],
      ['({ first: { suppressed: off } } = pair);', ['{ suppressed } =']],
      ['[{ suppressed: off } = fallback] = features;', ['{ suppressed } =']],
      ['for ({ suppressed: off } of features) count(off);', ['{ suppressed } =']],
      ['for ([{ suppressed: off }] of pairs) count(off);', ['{ suppressed } =']],
      ['next = ({ suppressed: off } = feature);', ['{ suppressed } =']]
    ]);
  });

  it('finds membership tests and reflective reads by a literal key', () => {
    expect(each([
      "const a = 'suppressed' in feature;",
      'const b = `suppressed` in feature;',
      "const c = Reflect.get(feature, 'suppressed');",
      "const d = Reflect.has(feature, 'suppressed');",
      "const e = Reflect.getOwnPropertyDescriptor(feature, 'suppressed');",
      "const f = Object.hasOwn(feature, 'suppressed');",
      "const g = Object.getOwnPropertyDescriptor(feature, 'suppressed');",
      "const h = feature.hasOwnProperty('suppressed');",
      "const i = feature.propertyIsEnumerable?.('suppressed');",
      "const j = Object.prototype.hasOwnProperty.call(feature, 'suppressed');",
      "const k = Object.prototype.hasOwnProperty.apply(feature, ['suppressed']);"
    ])).toEqual([
      ["const a = 'suppressed' in feature;", ["'suppressed' in"]],
      ['const b = `suppressed` in feature;', ["'suppressed' in"]],
      ["const c = Reflect.get(feature, 'suppressed');", ["get('suppressed')"]],
      ["const d = Reflect.has(feature, 'suppressed');", ["has('suppressed')"]],
      ["const e = Reflect.getOwnPropertyDescriptor(feature, 'suppressed');", ["getOwnPropertyDescriptor('suppressed')"]],
      ["const f = Object.hasOwn(feature, 'suppressed');", ["hasOwn('suppressed')"]],
      ["const g = Object.getOwnPropertyDescriptor(feature, 'suppressed');", ["getOwnPropertyDescriptor('suppressed')"]],
      ["const h = feature.hasOwnProperty('suppressed');", ["hasOwnProperty('suppressed')"]],
      ["const i = feature.propertyIsEnumerable?.('suppressed');", ["propertyIsEnumerable('suppressed')"]],
      ["const j = Object.prototype.hasOwnProperty.call(feature, 'suppressed');", ["hasOwnProperty('suppressed')"]],
      ["const k = Object.prototype.hasOwnProperty.apply(feature, ['suppressed']);", ["hasOwnProperty('suppressed')"]]
    ]);
  });

  it('finds reflective reads whose method is named by a literal key, directly or through call and apply', () => {
    expect(each([
      "const a = Reflect['get'](feature, 'suppressed');",
      "const b = Reflect[`has`](feature, 'suppressed');",
      "const c = Object['hasOwn' as const](feature, 'suppressed');",
      "const d = feature?.['hasOwnProperty']('suppressed');",
      "const GET = 'get'; const e = Reflect[GET](feature, 'suppressed');",
      "const f = Reflect['get']['call'](undefined, feature, 'suppressed');",
      "const g = Reflect.get['apply'](undefined, [feature, 'suppressed']);",
      "const h = Object.prototype['propertyIsEnumerable'].call(feature, 'suppressed');",
      "const i = Object['prototype']['hasOwnProperty'][`apply`](feature, ['suppressed']);"
    ])).toEqual([
      ["const a = Reflect['get'](feature, 'suppressed');", ["get('suppressed')"]],
      ["const b = Reflect[`has`](feature, 'suppressed');", ["has('suppressed')"]],
      ["const c = Object['hasOwn' as const](feature, 'suppressed');", ["hasOwn('suppressed')"]],
      ["const d = feature?.['hasOwnProperty']('suppressed');", ["hasOwnProperty('suppressed')"]],
      ["const GET = 'get'; const e = Reflect[GET](feature, 'suppressed');", ["get('suppressed')"]],
      ["const f = Reflect['get']['call'](undefined, feature, 'suppressed');", ["get('suppressed')"]],
      ["const g = Reflect.get['apply'](undefined, [feature, 'suppressed']);", ["get('suppressed')"]],
      ["const h = Object.prototype['propertyIsEnumerable'].call(feature, 'suppressed');", ["propertyIsEnumerable('suppressed')"]],
      ["const i = Object['prototype']['hasOwnProperty'][`apply`](feature, ['suppressed']);", ["hasOwnProperty('suppressed')"]]
    ]);
  });

  it('reads a constant key from the declaration its name is bound to, past inner and outer declarations of the same name', () => {
    // An outer key naming the flag, with an unrelated inner constant, parameter and loop variable of the same name.
    expect(scan([
      "const KEY = 'suppressed';",
      "function label(feature: CadFeature) { const KEY = 'name'; return feature[KEY]; }",
      'const read = feature[KEY];',
      'const pick = (KEY: string) => feature[KEY];',
      "for (const KEY of ['name']) void feature[KEY];",
      'const { [KEY]: off } = feature;'
    ].join('\n'))).toEqual([{ spelling: "['suppressed']", line: 3 }, { spelling: '{ suppressed }', line: 6 }]);
    // An outer key naming something else, with an inner constant naming the flag, declared before or after it is read.
    expect(scan([
      "const KEY = 'name';",
      "function active(feature: CadFeature) { const KEY = 'suppressed'; return feature[KEY]; }",
      'const label = feature[KEY];',
      "function late(feature: CadFeature) { if (feature) return Reflect.get(feature, KEY); const KEY = 'suppressed'; }",
      "{ const KEY = 'suppressed'; ({ [KEY]: off } = feature); }",
      'const name = feature[KEY];'
    ].join('\n'))).toEqual([{ spelling: "['suppressed']", line: 2 }, { spelling: "get('suppressed')", line: 4 }, { spelling: '{ suppressed } =', line: 5 }]);
  });

  it('ignores writes of the flag, other names, comments, text and types', () => {
    const source = [
      '// feature.suppressed is read through cadFeatureActive',
      "const message = 'feature.suppressed';",
      'const next = { ...feature, suppressed: true };',
      "const computed = { ...feature, ['suppressed']: true };",
      'const suppressed = true; const kept = { suppressed };',
      'target = { suppressed: flag };',
      '[first] = [{ suppressed: true }];',
      'const off = cursor.snapSuppressed || state.suppressedCount;',
      "type Flag = CadFeature['suppressed'];",
      'interface Toggle { suppressed: boolean; readonly ["suppressed"]?: boolean }',
      'const [suppressedFirst] = list;',
      'const byName = feature[suppressed];',
      "let key = 'suppressed'; const byVariable = feature[key];",
      'const inner = { suppressed: true }.suppressedCount;',
      "const lookup = params.get('suppressed') ?? cache.has('suppressed') ?? params['get']('suppressed');",
      "if (issue === 'suppressed') report(issue);",
      "switch (issue) { case 'suppressed': break; }",
      'const keys = Object.keys(feature); const copy = { ...feature };',
      'class Toggle { suppressed = false; #suppressed = true; read() { return this.#suppressed; } }',
      "const element = <Row suppressed={true} />;"
    ].join('\n');
    expect(featureActivityReadsIn('fixture.tsx', source)).toEqual([]);
  });

  // Parses every source file, so its time grows with the repository and the runner's load.
  it('passes on the repository, where only the activity module reads the flag', async () => {
    const result = await checkFeatureActivity();
    expect(result.problems).toEqual([]);
    expect(result.checked).toBeGreaterThan(500);
  }, 30_000);
});
