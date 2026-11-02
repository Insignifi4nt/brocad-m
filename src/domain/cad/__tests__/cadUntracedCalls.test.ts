import { describe, expect, it } from 'vitest';
import { CadSourceIndex, cadDiagnosticReach } from './cadDiagnosticReach';
import { CAD_UNTRACED_CALLS, cadUntracedCallProblems, cadUntracedCalls } from './cadUntracedCalls';

const PARAMETERS = 'src/domain/cad/cadParameters.ts', RELATIONS = 'src/domain/cad/cadSketchGraphReferences.ts', CHECK = 'src/check.ts';
const MAPPER = `(value: number, map: (value: number) => number) { return map(value); }`;
/**
 * What is wrong with the CAM suite's untraced calls in a source whose `check.ts` holds `check` beside a harmless mapper call, as its walk
 * reported exactly the calls listed and listed no code of its own.
 */
const problems = (check: string) => {
  const index = new CadSourceIndex({
    'src/errors.ts': `export class CadError extends Error { constructor(readonly code: string, message: string) { super(message); } }`,
    [PARAMETERS]: `export function mapCadFeatureScalars${MAPPER}`,
    [RELATIONS]: `export function mapCadSketchRelationScalars${MAPPER}`,
    'src/mappers.ts': `import { CadError } from './errors'; export function namedMapper(value: number): number { throw new CadError('unlisted-mapper-refusal', ''); }`,
    [CHECK]: `import { CadError } from './errors'; import { namedMapper } from './mappers'; import { mapCadFeatureScalars } from './domain/cad/cadParameters';
      export function harmless() { return mapCadFeatureScalars(1, value => value); }
      ${check}`
  });
  const reporting = { ...cadDiagnosticReach(index, []), unexpanded: cadUntracedCalls('cam') };
  return cadUntracedCallProblems(index, [['send-sketch', reporting]], 'cam', roots => cadDiagnosticReach(index, roots));
};

describe('CAD untraced calls', () => {
  // The listed calls that run a scalar mapper, each of which may run every mapper the source gives a mapper function.
  const mappers = cadUntracedCalls('cam').filter(entry => CAD_UNTRACED_CALLS[entry].runs);

  it('checks every mapper the source gives a mapper function, however the function is named and the mapper is written, beside a harmless one', () => {
    expect(mappers).toHaveLength(2);
    expect(problems(''), 'the harmless mapper alone').toEqual([]);
    const refused = mappers.map(entry => `${entry}, runs unlisted-mapper-refusal, which send-sketch does not list`);
    const checks: Readonly<Record<string, string>> = {
      inline: `export function check() { return mapCadFeatureScalars(1, value => { throw new CadError('unlisted-mapper-refusal', ''); }); }`,
      named: 'export function check() { return mapCadFeatureScalars(1, namedMapper); }',
      aliased: 'const alias = namedMapper; export function check() { return mapCadFeatureScalars(1, alias); }',
      renamed: `import { mapCadFeatureScalars as mapScalars } from './domain/cad/cadParameters'; export function check() { return mapScalars(1, namedMapper); }`,
      namespace: `import * as parameters from './domain/cad/cadParameters'; export function check() { return parameters.mapCadFeatureScalars(1, namedMapper); }`,
      held: 'const map = mapCadFeatureScalars; export function check() { return map(1, namedMapper); }'
    };
    for (const [name, check] of Object.entries(checks)) expect(problems(check), name).toEqual(refused);
  });

  it('flags a mapper it cannot establish, and the mapper function used other than called', () => {
    const unresolved = (place: string) => mappers.map(entry => `${entry}, may run what ${CHECK}: ${place}`);
    expect(problems('export function check(unknownMapper: (value: number) => number) { return mapCadFeatureScalars(1, unknownMapper); }'))
      .toEqual(unresolved('mapCadFeatureScalars(1, unknownMapper), a call of mapCadFeatureScalars whose function the check cannot establish'));
    expect(problems('export function check(values: [number, (value: number) => number]) { return mapCadFeatureScalars(...values); }'))
      .toEqual(unresolved('mapCadFeatureScalars(...values), a call of mapCadFeatureScalars whose function the check cannot establish'));
    expect(problems('export const table = [mapCadFeatureScalars];')).toEqual(unresolved('[mapCadFeatureScalars], mapCadFeatureScalars used other than called'));
  });
});
