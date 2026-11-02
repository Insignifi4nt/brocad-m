import { userFacingMessage } from '@/lib/userMessage';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon, DownloadIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadMesh, CadPlane } from '@/domain/cad/cadDocument';
import type { CadSectionRequest, CadSectionResult } from '@/domain/cad/cadSection';
import type { DxfEntity } from '@/domain/dxf/types';
import { cadSketchToEntities } from '@/domain/cad/cadSketchGeometry';
import { resolveCadCurveGeometry } from '@/domain/cad/cadCurve';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { cadBodyFeatureId, cadBodyLineage } from '@/domain/cad/cadBodies';
import { CadContextHelp } from './CadContextHelp';
import { CadSectionPreview } from './CadSectionDialog';
import { cadSectionMiddleOffset } from './cadSectionMidpoint';
import './cad-dxf-export.css';

type SourceKind = 'sketch' | 'curve' | 'section';
export interface CadDxfExportDialogProps {
  document: CadDocument;
  bodies: readonly CadMesh[];
  version: string;
  currentVersion: string;
  initialFeatureId?: string;
  onClose(): void;
  onExportSketch(id: string, version: string, signal: AbortSignal): Promise<unknown>;
  onExportCurve(id: string, version: string, signal: AbortSignal): Promise<unknown>;
  onInspectSection(request: CadSectionRequest, version: string, signal: AbortSignal): Promise<CadSectionResult>;
  onExportSection(request: CadSectionRequest, version: string, signal: AbortSignal): Promise<unknown>;
}

/** Standalone CAD export. Exact sections are recomputed by the guarded controller before download. */
export function CadDxfExportDialog({ document: cadDocument, bodies, version, currentVersion, initialFeatureId,
  onClose, onExportSketch, onExportCurve, onInspectSection, onExportSection }: CadDxfExportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef<AbortController | null>(null);
  const sketches = cadDocument.features.filter(feature => feature.kind === 'sketch' && cadFeatureActive(feature, cadDocument));
  const curves = cadDocument.features.filter(feature => feature.kind === 'curve' && cadFeatureActive(feature, cadDocument));
  const initialFeature = cadDocument.features.find(feature => feature.id === initialFeatureId);
  // The body the initial feature leads to by key, wherever that feature is in the body's history; a mesh without a key by the feature that
  // made the body what it is now; with neither, the first body.
  const initialState = useMemo(() => initialFeatureId === undefined ? undefined : cadBodyLineage(cadDocument.features, cadDocument).of(initialFeatureId), [cadDocument, initialFeatureId]);
  const initialOf = (list: readonly CadMesh[]) => (initialState && (list.find(body => body.bodyKey === initialState.key)
    ?? list.find(body => body.featureId === cadBodyFeatureId(initialState)))) ?? list[0];
  const initialBody = initialOf(bodies);
  const [kind, setKind] = useState<SourceKind>(initialFeature?.kind === 'curve' && cadFeatureActive(initialFeature, cadDocument) ? 'curve'
    : initialFeature?.kind === 'sketch' && cadFeatureActive(initialFeature, cadDocument) ? 'sketch'
      : initialBody ? 'section' : sketches.length ? 'sketch' : 'curve');
  const [sketchId, setSketchId] = useState(sketches.find(feature => feature.id === initialFeatureId)?.id ?? sketches[0]?.id ?? '');
  const [curveId, setCurveId] = useState(curves.find(feature => feature.id === initialFeatureId)?.id ?? curves[0]?.id ?? '');
  const [bodyId, setBodyId] = useState(initialBody?.featureId ?? '');
  const [plane, setPlane] = useState<CadPlane>('XY'), [offset, setOffset] = useState(cadSectionMiddleOffset(initialBody, 'XY'));
  const [review, setReview] = useState<{ key: string; result: CadSectionResult } | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<'preview' | 'export' | null>(null);
  const stale = version !== currentVersion;
  const request: CadSectionRequest = { bodyId, plane, offset };
  const key = JSON.stringify([version, currentVersion, kind, kind === 'sketch' ? sketchId : kind === 'curve' ? curveId : request]);
  const liveKey = useRef(key); liveKey.current = key;
  useEffect(() => { dialog.current?.showModal(); return () => pending.current?.abort(); }, []);
  useEffect(() => { if (stale) pending.current?.abort(); }, [stale]);
  useLayoutEffect(() => {
    if (stale || bodies.some(body => body.featureId === bodyId)) return;
    const next = initialOf(bodies);
    if (!next) return;
    // A same-version build can finish while a sketch export dialog is already open.
    // Preserve valid selections and custom heights; initialize only a missing body.
    setBodyId(next.featureId); setOffset(cadSectionMiddleOffset(next, plane)); setReview(null); setError(null);
  }, [bodies, bodyId, plane, initialState, stale]);
  const source = useMemo<{ entities: readonly DxfEntity[]; error: string | null }>(() => {
    try {
      if (kind === 'section') { evaluateCadScalar(offset, cadDocument.parameters); return { entities: [], error: null }; }
      const feature = cadDocument.features.find(candidate => candidate.id === (kind === 'sketch' ? sketchId : curveId) && cadFeatureActive(candidate, cadDocument));
      const entities = feature?.kind === 'sketch' && kind === 'sketch' ? cadSketchToEntities(feature, cadDocument.parameters)
        : feature?.kind === 'curve' && kind === 'curve' ? resolveCadCurveGeometry(feature, cadDocument.parameters).entities : [];
      return { entities, error: entities.length ? null : 'Choose a source with exportable geometry.' };
    } catch (cause) { return { entities: [], error: userFacingMessage(cause, 'Cannot resolve this source.') }; }
  }, [cadDocument, kind, sketchId, curveId, offset]);
  const reviewed = !stale && review?.key === key ? review.result : null;
  const previewEntities = kind === 'section' ? reviewed?.entities ?? [] : source.entities;
  const hasSource = kind === 'section' ? bodies.some(body => body.featureId === bodyId) : source.entities.length > 0;
  const close = () => { pending.current?.abort(); onClose(); };
  const changeSource = (next: SourceKind) => { setKind(next); setError(null); };
  async function execute(action: 'preview' | 'export') {
    if (pending.current || stale || !hasSource || source.error || action === 'export' && kind === 'section' && !reviewed) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(action); setError(null);
    try {
      if (action === 'preview') {
        setReview(null);
        const result = await onInspectSection(request, version, controller.signal);
        if (!controller.signal.aborted && liveKey.current === key) setReview({ key, result });
      } else {
        await (kind === 'sketch' ? onExportSketch(sketchId, version, controller.signal)
          : kind === 'curve' ? onExportCurve(curveId, version, controller.signal) : onExportSection(request, version, controller.signal));
        if (!controller.signal.aborted && liveKey.current === key) onClose();
      }
    } catch (cause) {
      if (!controller.signal.aborted && liveKey.current === key) setError(userFacingMessage(cause, 'DXF export failed.'));
    } finally { if (pending.current === controller) { pending.current = null; setBusy(null); } }
  }
  return <dialog ref={dialog} aria-label="Export DXF" className="cad-dxf-export" onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><h2>Export DXF</h2><span>{cadDocument.name} · millimetres</span></div><Button type="button" className="cad-dxf-close" aria-label="Close DXF export" onClick={close}><CloseIcon size={15} /></Button></header>
    <div className="cad-dxf-content">
      <div className="cad-dxf-source-heading"><span>Geometry source</span><CadContextHelp label="DXF geometry source"><p>Sketch exports its local 2D contours, excluding construction geometry. Reference curve exports one open chain with its traversal preserved.</p><p>Section cuts a current final solid at the chosen plane and height, including downstream pockets and Boolean changes. It exports exact lines, circular arcs and circles. A solid silhouette or arbitrary projection is currently unavailable.</p><p>DXF is independent of CAD saving and CAM. Existing generated gear chords retain their declared approximation; export adds no tessellation.</p></CadContextHelp></div>
      <fieldset className="cad-dxf-source-types" disabled={busy !== null || stale}><legend className="sr-only">Geometry source</legend>
        {([{ value: 'sketch', label: 'Sketch', count: sketches.length }, { value: 'curve', label: 'Reference curve', count: curves.length }, { value: 'section', label: 'Solid section', count: bodies.length }] as const).map(choice =>
          <label key={choice.value} className={kind === choice.value ? 'is-active' : ''}><Input type="radio" name="dxf-source" value={choice.value} checked={kind === choice.value} disabled={!choice.count} onChange={() => changeSource(choice.value)} />{choice.label}</label>)}
      </fieldset>
      <div className="cad-dxf-settings">
        {kind === 'sketch' ? <label>Sketch<Select aria-label="Sketch source" value={sketchId} disabled={busy !== null || stale} onChange={event => { setSketchId(event.target.value); setError(null); }}>{sketches.map(feature => <option key={feature.id} value={feature.id}>{feature.name}</option>)}</Select></label>
          : kind === 'curve' ? <label>Reference curve<Select aria-label="Reference curve source" value={curveId} disabled={busy !== null || stale} onChange={event => { setCurveId(event.target.value); setError(null); }}>{curves.map(feature => <option key={feature.id} value={feature.id}>{feature.name}</option>)}</Select></label>
            : <><label>Solid body<Select value={bodyId} disabled={busy !== null || stale} onChange={event => { setBodyId(event.target.value); setOffset(cadSectionMiddleOffset(bodies.find(body => body.featureId === event.target.value), plane)); setError(null); }}>{bodies.map(body => <option key={body.featureId} value={body.featureId}>{body.name}</option>)}</Select></label>
              <div className="cad-dxf-plane-row"><label>Plane<Select value={plane} disabled={busy !== null || stale} onChange={event => { const next = event.target.value; if (next === 'XY' || next === 'XZ' || next === 'YZ') { setPlane(next); setOffset(cadSectionMiddleOffset(bodies.find(body => body.featureId === bodyId), next)); setError(null); } }}><option>XY</option><option>XZ</option><option>YZ</option></Select></label>
                <label><span>Offset <small>mm</small><CadContextHelp label="Section offset"><p>The plane moves along {plane === 'XY' ? '+Z' : plane === 'XZ' ? '−Y' : '+X'}. The initial value cuts through the middle of the selected body's bounds. Set a height inside the material; parameter expressions such as thickness / 2 are accepted.</p><p>Tangent, open, branching, elliptical or spline sections are rejected explicitly. Choose another plane or height if this section is unsupported.</p></CadContextHelp></span><Input aria-label="Section offset (mm)" value={offset} disabled={busy !== null || stale} onChange={event => { setOffset(event.target.value); setError(null); }} /></label></div>
              <Button type="button" className="cad-dxf-secondary" disabled={busy !== null || stale || !hasSource || Boolean(source.error)} onClick={() => { void execute('preview'); }}>Preview section</Button></>}
        <div className="cad-dxf-coordinate-note">{kind === 'section' ? `${plane} · offset along ${plane === 'XY' ? '+Z' : plane === 'XZ' ? '−Y' : '+X'}` : 'Source-local 2D coordinates'}</div>
      </div>
      <div className="cad-dxf-preview">{previewEntities.length ? <CadSectionPreview entities={previewEntities} label={kind === 'section' ? 'Exact section preview' : kind === 'sketch' ? 'Sketch DXF preview' : 'Reference curve DXF preview'} />
        : <p>{busy === 'preview' ? 'Computing exact section…' : kind === 'section' ? 'Preview the section to review its exported contours.' : 'No exportable geometry.'}</p>}</div>
      <div className="cad-dxf-status" role="status">{busy === 'export' ? 'Preparing DXF download…' : busy === 'preview' ? 'Computing exact section…' : reviewed ? `${reviewed.contourCount} closed contours · ${reviewed.entities.length} analytic curves` : kind !== 'section' && previewEntities.length ? `${previewEntities.length} analytic curves${kind === 'curve' ? ' · open chain' : ''}` : ' '}</div>
      {(stale || error || source.error) && <p role="alert" className="cad-dxf-error">{stale ? 'The CAD draft changed. Close this export and reopen it to review the current geometry.' : error ?? source.error}</p>}
    </div>
    <footer><span>Standalone 2D DXF · no CAD save required</span><div><Button type="button" className="cad-dxf-secondary" onClick={busy ? () => pending.current?.abort() : close}>{busy ? 'Cancel operation' : 'Cancel'}</Button><Button variant="primary" type="button" className="cad-dxf-primary" disabled={busy !== null || stale || !hasSource || Boolean(source.error) || kind === 'section' && !reviewed} onClick={() => { void execute('export'); }}><DownloadIcon size={13} />Download DXF</Button></div></footer>
  </dialog>;
}
