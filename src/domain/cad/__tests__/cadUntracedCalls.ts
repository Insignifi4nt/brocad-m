// TypeScript 7 ships no compiler API yet; AST tooling uses the TypeScript 6 package.
import ts from '@typescript/typescript6';
import { bareExpression, declarationName, type CadDiagnosticReach, type CadDiagnosticRoot, type CadSourceIndex } from './cadDiagnosticReach';

/** The diagnostics suites whose walks report untraced calls: the feature diagnostics', and the CAM and export steps'. */
export type CadUntracedSuite = 'feature' | 'cam';
/**
 * A call a diagnostics walk reports because it cannot tell the function the call runs, read by hand: why, and the functions it may run.
 * A walk of those functions shows each code they raise is one the reporting walk lists already.
 */
export interface CadUntracedCall {
  readonly reason: string;
  /** The suites whose walks report it. */
  readonly suites: readonly CadUntracedSuite[];
  /** The functions the call may run, found in the source; absent when nothing of the source calls it. */
  readonly runs?: (index: CadSourceIndex) => readonly CadDiagnosticRoot[];
  /**
   * The constants, as `file:name`, those functions read only for their data, and why: a walk of them stops there, as it would otherwise
   * enter every function the constant holds.
   */
  readonly reads?: Readonly<Record<string, string>>;
}

/** The functions written as argument `position` of each call of the function named `callee`, in the files `keep` accepts. */
function functionsGiven(index: CadSourceIndex, callee: string, position: number, keep: (file: string) => boolean = () => true): CadDiagnosticRoot[] {
  const found: CadDiagnosticRoot[] = [];
  for (const [file, source] of index.files) {
    if (!keep(file) || !source.text.includes(callee)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
        const given = node.arguments[position] && bareExpression(node.arguments[position]);
        if (given && (ts.isArrowFunction(given) || ts.isFunctionExpression(given))) found.push({ file, node: given });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const FEATURES = 'src/domain/cad/features/', MAPPERS = `${FEATURES}cadFeatureScalarMaps.ts`, PROFILE_MAPPERS = 'src/domain/cad/cadProfileScalars.ts';
const REFERENCES = 'src/domain/cad/cadSketchExternalReferences.ts';
/** A call of a function's parameter that the walk sees no call of the function to give. */
const unseen = (site: string, file: string, parameter: string) =>
  `${site}, a call of a function a value gives, from ${file}: ${parameter}, a parameter of a function the walk sees no call of`;
/**
 * A scalar mapper: a field's `scalars`, or a point, path, profile or predicate mapper it gives its `map` on to. It runs when
 * `mapCadFeatureScalars` calls a field's `scalars` with the function it was given, which a walk that reaches that call reads there, or
 * when a sketch draft lists a relation's values. Its `map` is one of the functions given to either.
 */
const scalarMapper = (...suites: CadUntracedSuite[]): CadUntracedCall => ({
  reason: 'A scalar mapper runs only when mapCadFeatureScalars calls a field\'s scalars, or when a sketch draft lists a relation\'s values. The walk reaches '
    + 'neither, so it sees no call that gives map; each function either is given raises no code.',
  suites,
  runs: index => [...functionsGiven(index, 'mapCadFeatureScalars', 1), ...functionsGiven(index, 'mapCadSketchRelationScalars', 1, file => file !== MAPPERS)]
});

/** The calls the diagnostics walks report and cannot trace, by their exact report, each read by hand. */
export const CAD_UNTRACED_CALLS: Readonly<Record<string, CadUntracedCall>> = {
  [`${FEATURES}cadFeatureRegistry.ts: quantities(), a call of a function a value gives, from ${FEATURES}cadFeatureRegistry.ts: Object.entries(…)[][].quantities`]: {
    reason: 'A field gives its quantities as a function only for the sketch graph: cadSketchGraphQuantities, which lists the paths its relation and generator '
      + 'definitions declare and raises no code.',
    suites: ['feature'],
    runs: index => index.exported(MAPPERS, 'cadSketchGraphQuantities', new Set()),
    reads: {
      'src/domain/cad/sketch-relations/cadSketchRelationRegistry.ts:CAD_SKETCH_RELATION_DEFINITIONS': 'Each relation definition is read for its kind and its scalars\' '
        + 'keys and quantities, which are data; none of its functions is called.'
    }
  },
  [unseen(`${FEATURES}cadFeatureFields.ts: map(value, path)`, `${FEATURES}cadFeatureFields.ts`, 'map')]: scalarMapper('feature', 'cam'),
  [unseen(`${MAPPERS}: map(point[0], \`\${path}.0\`)`, MAPPERS, 'map')]: scalarMapper('feature'),
  [unseen(`${MAPPERS}: map(point[1], \`\${path}.1\`)`, MAPPERS, 'map')]: scalarMapper('feature'),
  [unseen(`${MAPPERS}: map(point[2], \`\${path}.2\`)`, MAPPERS, 'map')]: scalarMapper('feature'),
  [unseen(`${MAPPERS}: map(point[2], \`\${path}.2\`)`, `${FEATURES}kinds/references.ts`, 'map')]: scalarMapper('feature'),
  [unseen(`${PROFILE_MAPPERS}: map(point[1], \`\${path}.1\`)`, PROFILE_MAPPERS, 'map')]: scalarMapper('feature', 'cam'),
  [unseen(`${REFERENCES}: callback.call(thisArg, value, value, result)`, REFERENCES, 'callback')]: {
    reason: 'callback is what a forEach call on a set readonlyIds makes is given. Those sets are a sketch\'s fixed points and circles, which the source reads '
      + 'with has, size and iteration; nothing of the source calls their forEach, and the platform calls no set\'s forEach.',
    suites: ['feature', 'cam']
  }
};

/** The untraced calls the walks of `suite` report. */
export function cadUntracedCalls(suite: CadUntracedSuite): string[] {
  return Object.entries(CAD_UNTRACED_CALLS).filter(([, call]) => call.suites.includes(suite)).map(([entry]) => entry);
}

/**
 * What is wrong with the untraced calls listed for `suite`, whose walks are `walks`: a listed call no walk reports, one whose functions
 * cannot be found, a code those functions raise that a walk reporting the call does not list, and a call their own walk cannot trace
 * that is not listed either, or a constant listed as read that their walk does not stop at. `walk` walks those functions as the suite
 * walks its steps, stopping at the constants given as well. A walk's report of a call not listed for the suite fails where the walk's
 * codes are checked.
 */
export function cadUntracedCallProblems(index: CadSourceIndex, walks: readonly (readonly [string, CadDiagnosticReach])[], suite: CadUntracedSuite,
  walk: (roots: readonly CadDiagnosticRoot[], reads: readonly string[]) => CadDiagnosticReach): string[] {
  const problems: string[] = [];
  for (const entry of cadUntracedCalls(suite)) {
    const { runs, reads = {} } = CAD_UNTRACED_CALLS[entry], reporting = walks.filter(([, reach]) => reach.unexpanded.includes(entry));
    if (!reporting.length) problems.push(`${entry}, reported by no walk`);
    if (!runs) continue;
    const roots = runs(index);
    if (!roots.length) { problems.push(`${entry}, runs none of the functions it names`); continue; }
    const ran = walk(roots, Object.keys(reads)), stopped = new Set([...ran.stopped].map(node => `${index.where(node)}:${declarationName(node)}`));
    for (const [read, why] of Object.entries(reads)) if (!stopped.has(read) || !why) problems.push(`${entry}, reads ${read}, which its walk does not stop at or gives no reason for`);
    for (const reached of ran.unexpanded) if (!(reached in CAD_UNTRACED_CALLS)) problems.push(`${entry}, runs functions whose walk reports ${reached}`);
    for (const [name, reach] of reporting) for (const code of ran.codes) if (!reach.codes.has(code)) problems.push(`${entry}, runs ${code}, which ${name} does not list`);
  }
  return problems;
}
