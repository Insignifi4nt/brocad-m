import { readableMessage, userFacingMessage } from '@/lib/userMessage';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CadDocument, CadSketchFeature } from '@/domain/cad/cadDocument';
import { Button } from '@/components/ui/button';
import { InfoTip } from '@/components/ui/info-tip';
import { CadContextHelp } from './CadContextHelp';
import type { CadSketchConstraintAnalysis, CadSketchConstraintInspection } from './cadSketchConstraintInspection';
import { cadSketchFeaturesEqualButPlacement } from '@/domain/cad/cadSketchPlacedDimensions';
import { cadDocumentsPlacedAlike } from '@/domain/cad/cadSchema';
import { Value } from '@sinclair/typebox/value';
import { solveFixedCadSketch } from './sketch-solver/cadSketchFixedSolve';

export type CadInspectSketchConstraints = (sketchId: string, expectedVersion?: string, signal?: AbortSignal) => Promise<CadSketchConstraintInspection>;
/**
 * The latest analysis of one sketch and the accepted version it belongs to, which may be older than the shown one.
 * `live` is false while editing or when analysis is unavailable: such a report may keep colours but never counts or locks.
 */
export interface CadSketchConstraintReport {
  readonly document: CadDocument; readonly version: string; readonly sketchId: string;
  readonly analysis: CadSketchConstraintAnalysis; readonly live: boolean;
}
/** Whether `to` differs from `from` only in where the dimensions of sketch `sketchId` are drawn. */
function placementOnly(from: CadDocument, to: CadDocument, sketchId: string) {
  return from !== to && (cadDocumentsPlacedAlike(from, to, sketchId) || (from.parameters === to.parameters || Value.Equal(from.parameters, to.parameters)) && from.features.length === to.features.length
    && from.features.every((feature, index) => feature === to.features[index] || feature.id === sketchId && cadSketchFeaturesEqualButPlacement(feature, to.features[index])));
}
const colourLegend ='Green: fully defined by dimensions and relations. Blue grey: under defined, or not known yet. Red and purple: geometry held by conflicting or redundant relations, shown for a rejected preview or Apply and for a sketch that fails analysis.';

/**
 * Freedom and definition are observations of the accepted source, never saved state or a preview result. `enabled` is false while the
 * sketch is edited, which leaves the last result shown but not live. `paused`, as while the draft is saved, opened or captured, only keeps a
 * new analysis from starting: the result shown stays live, so a capture sees the view it asked for.
 */
export function CadSketchConstraintStatus({ document, sketch, version, inspect, enabled, paused = false, onReport }: {
  document: CadDocument; sketch: CadSketchFeature; version: string; inspect?: CadInspectSketchConstraints; enabled: boolean; paused?: boolean;
  onReport?(report: CadSketchConstraintReport | null): void;
}) {
  const callback = useRef(inspect); callback.current = inspect;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ document: CadDocument; version: string; sketchId: string; inspection: CadSketchConstraintInspection } | null>(null);
  const [failure, setFailure] = useState<{ document: CadDocument; version: string; sketchId: string; message: string } | null>(null);
  const available = Boolean(inspect), hasGraph = Boolean(sketch.graph);
  // A sketch with nothing free to move, as one made only of generated and referenced geometry, is analysed here from its first render: its
  // colours and count never arrive after the view is shown, and the solver never starts for it.
  const fixed = useMemo<CadSketchConstraintAnalysis | null>(() => {
    const solved = sketch.graph ? solveFixedCadSketch({ graph: sketch.graph, parameters: document.parameters, analyseDefinition: true }) : null;
    return solved && { kind: 'solved', diagnostics: solved.diagnostics };
  }, [sketch.graph, document.parameters]);
  const latest = useRef(result); latest.current = result;
  // The version the analysis last ran for.
  const analysed = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || paused || !available || !hasGraph || fixed) return;
    const last = latest.current, previous = analysed.current; analysed.current = version;
    // Where dimensions are drawn is display data, so the version after an analysed one that changes only that keeps its analysis.
    // Any other version, including the same document restored by undo after other edits, is analysed again.
    if (last && last.version === previous && last.version !== version && last.sketchId === sketch.id && placementOnly(last.document, document, sketch.id)) {
      setResult({ document, version, sketchId: sketch.id, inspection: last.inspection });
      return;
    }
    const controller = new AbortController();
    void callback.current?.(sketch.id, version, controller.signal).then(inspection => {
      if (!controller.signal.aborted) { setResult({ document, version, sketchId: sketch.id, inspection }); setFailure(null); }
    }, cause => {
      if (!controller.signal.aborted) { setResult(null); setFailure({ document, version, sketchId: sketch.id, message: userFacingMessage(cause, 'Constraint analysis is unavailable.') }); }
    });
    return () => controller.abort();
  }, [document, sketch.id, version, enabled, paused, available, hasGraph, fixed, retry]);
  // The analysis the effect above keeps for a version that only moves a dimension is shown from that version's first render.
  const carried = (shown: NonNullable<typeof result>) => enabled && available && hasGraph && shown.version === analysed.current && shown.version !== version
    && placementOnly(shown.document, document, sketch.id);
  const current = result && result.sketchId === sketch.id && (result.document === document && result.version === version || carried(result)) ? result.inspection : null;
  const analysis = fixed ?? current?.analysis, freedom = analysis?.diagnostics.degreesOfFreedom;
  const message = fixed ? null : failure?.document === document && failure.version === version && failure.sketchId === sketch.id ? failure.message : analysis && 'message' in analysis ? readableMessage(analysis.message) : null;
  const unavailable = Boolean(message) && (!analysis || analysis.kind === 'unavailable');
  // The last result stays reported until the next one arrives, so unchanged geometry keeps its colour across an edit.
  const report = useMemo<CadSketchConstraintReport | null>(() => fixed ? { document, version, sketchId: sketch.id, analysis: fixed, live: enabled }
    : result && { document: result.document, version: result.version, sketchId: result.sketchId, analysis: result.inspection.analysis, live: enabled && !unavailable },
  [fixed, document, version, sketch.id, result, enabled, unavailable]);
  const reportAnalysis = useRef(onReport); reportAnalysis.current = onReport;
  useLayoutEffect(() => { onReport?.(report); }, [report, onReport]);
  // Each report replaces the last one, so only a removed status reports that nothing is known.
  useLayoutEffect(() => () => reportAnalysis.current?.(null), []);
  if (!hasGraph) return null;
  const label = !enabled ? 'Editing…' : unavailable || !available && !fixed ? 'Freedom unavailable'
    : !analysis ? 'Checking freedom…' : analysis.kind === 'rejected' ? analysis.reason === 'redundant' ? 'Redundant relations' : 'Constraint issue'
      : freedom === 0 ? 'Fully defined' : freedom === null || freedom === undefined ? 'Definition unknown' : `Under defined · ${freedom} DOF`;
  return <div className="cad-sketch-freedom">
    <output aria-label="Sketch constraint status">{label}</output>
    <InfoTip label="Sketch colours" content={colourLegend} />
    <CadContextHelp label="Sketch freedom">
      <p>DOF counts the degrees of freedom left in the sketch. Each free point starts with two directions of movement. Dimensions, expressions and geometric relations remove those freedoms. Points and edges they fully define turn green, and a fully defined point or circle radius cannot be dragged or nudged.</p>
      {(fixed ? sketch.profiles.length : current?.legacyProfileCount) ? <p>This count covers sketch points and edges. Older profile groups keep their own dimensions.</p> : null}
      {message && <p>{message}</p>}
      {enabled && unavailable && <Button type="button" onClick={() => { setFailure(null); setResult(null); setRetry(value => value + 1); }}>Retry analysis</Button>}
    </CadContextHelp>
  </div>;
}
