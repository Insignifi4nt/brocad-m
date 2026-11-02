import { beforeAll, describe, expect, it } from 'vitest';
// TypeScript 7 ships no compiler API yet; AST tooling uses the TypeScript 6 package.
import ts from '@typescript/typescript6';
import { CadSourceIndex, cadDiagnosticReach, type CadDiagnosticReach, type CadDiagnosticRoot } from './cadDiagnosticReach';
import { cadSkippedMemberReads } from './cadMemberReads';
import { CAD_CAM_STEP_CODES, CAD_EXPORT_STEP_CODES, isCadRefusalFactCode, type CadCamOperation, type CadExportFormat } from '../cadIssueCodes';

const KERNEL = 'src/features/cad/kernel/cadKernelModel.ts', CONTROLLER = 'src/features/cad/useCadController.ts', CAM = 'src/domain/cad/cadCam.ts';

/**
 * Where a CAM or export step's walk stops, and why what lies beyond raises no refusal of the step:
 * - the document check, which the step runs again on the document the session accepted, so it refuses nothing there; a check that did
 *   refuse records the feature or input slot it was reading before the step records itself;
 * - the body lineage, which the rebuild kept; a section only looks a built body up.
 */
const STOPS = ['src/domain/cad/cadSchema.ts:parseCadDocument', `${KERNEL}:lineage`];

const PATH_DIAGNOSTIC = 'A diagnostic the path planner records on the CAM document it returns. A document with an error diagnostic or an open contour is refused as cam-geometry.';
const GRAPH_ISSUE = 'A sketch graph issue, refused with the code of the check that finds it.';
const ARRANGEMENT_ISSUE = 'A sketch arrangement issue. Cells refuse an arrangement with issues as unsupported-sketch-cells.';
/** Codes the walk finds that are no refusal of a CAM or export step, and why. */
const NOT_REFUSALS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['ambiguous-endpoint-cluster', 'branching-topology', 'closed-chain-gap', 'degenerate-contour', 'duplicate-segment', 'dxf-import-warning',
    'endpoint-cluster-snap', 'intersecting-topology', 'invalid-arc', 'invalid-polyline', 'layer-filtered', 'non-finite-geometry', 'open-chain',
    'overlapping-segment', 'route-dependency-cycle', 'units-assumed-millimeters', 'zero-length-segment'].map(code => [code, PATH_DIAGNOSTIC])),
  'relation-residual': GRAPH_ISSUE, 'invalid-coordinate': GRAPH_ISSUE, 'degenerate-entity': GRAPH_ISSUE, 'arc-radius-mismatch': GRAPH_ISSUE,
  overlap: ARRANGEMENT_ISSUE, 'ambiguous-tangency': ARRANGEMENT_ISSUE, precision: ARRANGEMENT_ISSUE, 'non-simple-boundary': ARRANGEMENT_ISSUE
};
/** Codes the walk cannot read, and why none is a refusal. */
const UNREAD: Readonly<Record<string, string>> = {
  'src/domain/dxf/parseDxf.ts: code, from src/domain/cad/cadCam.ts: 4': 'A DXF unit record\'s code is its INSUNITS number: the handoff declares millimetres (4).'
};

let index: CadSourceIndex;
/** A CAM step, or an export step, which is no CAM step and lists its codes apart. */
type Step = CadCamOperation | CadExportFormat;
const STEP_CODES: { readonly [S in Step]: readonly string[] } = { ...CAD_CAM_STEP_CODES, ...CAD_EXPORT_STEP_CODES };
let roots: { readonly [S in Step]: readonly CadDiagnosticRoot[] };

beforeAll(() => {
  index = new CadSourceIndex();
  const find = (file: string, test: (node: ts.Node) => boolean): ts.Node[] => {
    const found: ts.Node[] = [];
    const visit = (node: ts.Node) => { if (test(node)) found.push(node); ts.forEachChild(node, visit); };
    visit(index.files.get(file)!);
    return found;
  };
  const exported = (file: string, name: string) => index.exported(file, name, new Set());
  // The model's section, which the worker calls after reading the request again; the controller reads its result against the request.
  const [section] = find(KERNEL, node => ts.isMethodDeclaration(node) && node.name.getText() === 'section' && ts.isObjectLiteralExpression(node.parent));
  const [matching] = find(CONTROLLER, node => ts.isFunctionDeclaration(node) && node.name?.text === 'matchingSectionResult');
  roots = {
    // Sending a sketch: its entities, which the step evaluates again, and the path planner's contours.
    'send-sketch': exported(CAM, 'cadSketchToCam'),
    // A Section for CAM: the request, the model's section, the reply the worker gives a failure, the result read back, and the handoff of
    // its curves to the path planner.
    section: [{ file: KERNEL, node: section }, { file: CONTROLLER, node: matching }, ...exported('src/domain/cad/cadSection.ts', 'parseCadSectionRequest'),
      ...exported('src/features/cad/kernel/cadKernelFailures.ts', 'cadKernelRequestFailure'), ...exported(CAM, 'cadEntitiesToCam')],
    // A section DXF export: the same section, read back the same way, and the DXF writer its curves go to instead of the path planner.
    'dxf-section': [{ file: KERNEL, node: section }, { file: CONTROLLER, node: matching }, ...exported('src/domain/cad/cadSection.ts', 'parseCadSectionRequest'),
      ...exported('src/features/cad/kernel/cadKernelFailures.ts', 'cadKernelRequestFailure'), ...exported('src/domain/cad/cadDxfExport.ts', 'cadEntitiesToDxf')],
    // A sketch DXF export: the sketch's entities, as a sketch sent to CAM evaluates them, and the DXF writer they go to.
    'dxf-sketch': exported(CAM, 'cadSketchToDxf'),
    // A reference curve DXF export: the curve's resolved edges and the open polyline written from them, read back to check it keeps them.
    'dxf-curve': exported('src/domain/cad/cadCurveDxf.ts', 'cadCurveToDxf')
  };
}, 60_000);

const sorted = (codes: Iterable<string>) => [...codes].sort();
const reaches = new Map<Step, CadDiagnosticReach>();
const reach = (operation: Step) => reaches.get(operation)
  ?? reaches.set(operation, cadDiagnosticReach(index, roots[operation], { stop: new Set(STOPS) })).get(operation)!;
const operations = Object.keys(STEP_CODES) as Step[];

describe('CAM and export step diagnostics', () => {
  it.each(operations)('list every code the %s step can be refused with', operation => {
    const walked = reach(operation), listed = STEP_CODES[operation];
    expect(walked.unexpanded.filter(entry => !(entry in UNREAD))).toEqual([]);
    expect(new Set(listed).size, 'listed once').toBe(listed.length);
    expect(sorted(listed)).toEqual(sorted([...walked.codes].filter(code => !(code in NOT_REFUSALS))));
    // A code with facts would need them in its CAM or export issue, which carries none.
    expect(listed.filter(isCadRefusalFactCode)).toEqual([]);
  }, 60_000);

  it('stop only where a stop is read and every reason stays true', () => {
    // Without the stops, the walk reaches more: each stop is still on the step's path.
    for (const stop of STOPS) {
      const without = new Set(STOPS.filter(entry => entry !== stop));
      const walked = operations.map(operation => cadDiagnosticReach(index, roots[operation], { stop: without }));
      expect(walked.some((entry, at) => entry.declarations.has(stop) && entry.declarations.size > reach(operations[at]).declarations.size), stop).toBe(true);
    }
    for (const [name, reason] of [...Object.entries(NOT_REFUSALS), ...Object.entries(UNREAD)]) expect(reason, name).not.toBe('');
    // Each code listed as no refusal is still one the walk finds.
    const found = new Set(operations.flatMap(operation => [...reach(operation).codes]));
    expect(Object.keys(NOT_REFUSALS).filter(code => !found.has(code))).toEqual([]);
  }, 120_000);

  it('follow or report every member read in the code they walk', () => {
    for (const operation of operations) {
      const walked = reach(operation);
      expect(walked.accesses.size, operation).toBeGreaterThan(0);
      expect(cadSkippedMemberReads(index, walked), operation).toEqual([]);
    }
  }, 60_000);

  it('take no caught error\'s code', () => {
    expect(operations.flatMap(operation => reach(operation).taken)).toEqual([]);
  });
});
