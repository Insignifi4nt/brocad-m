import { userFacingMessage } from '@/lib/userMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useEffect, useRef, useState } from 'react';
import type { CadMesh, CadPlane } from '@/domain/cad/cadDocument';
import type { CadSectionRequest, CadSectionResult } from '@/domain/cad/cadSection';
import type { DxfEntity } from '@/domain/dxf/types';
import { cadSectionMiddleOffset } from './cadSectionMidpoint';
import { cadRefusalIssue } from '@/domain/cad/cadRefusalIssues';

/** Display exact analytic curves. This preview never becomes the machining source. */
export function CadSectionPreview({ entities, label = 'Exact section preview' }: { entities: readonly DxfEntity[]; label?: string }) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const include = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const entity of entities) {
    if (entity.type === 'line') { include(entity.start.x, entity.start.y); include(entity.end.x, entity.end.y); }
    else if (entity.type === 'circle' || entity.type === 'arc') {
      include(entity.center.x - entity.radius, entity.center.y - entity.radius);
      include(entity.center.x + entity.radius, entity.center.y + entity.radius);
    }
  }
  if (minX === Infinity) return null;
  const margin = Math.max(maxX - minX, maxY - minY, 1) * 0.08;
  return <svg aria-label={label} role="img" className="h-72 w-full bg-[#152029]" viewBox={`${minX - margin} ${-maxY - margin} ${maxX - minX + 2 * margin} ${maxY - minY + 2 * margin}`}>
    <g transform="scale(1,-1)" fill="none" stroke="#79c8e6" strokeWidth={1.5}>
      {entities.map((entity, index) => {
        if (entity.type === 'line') return <line key={index} vectorEffect="non-scaling-stroke" x1={entity.start.x} y1={entity.start.y} x2={entity.end.x} y2={entity.end.y} />;
        if (entity.type === 'circle') return <circle key={index} vectorEffect="non-scaling-stroke" cx={entity.center.x} cy={entity.center.y} r={entity.radius} />;
        if (entity.type !== 'arc') return null;
        const sweep = Math.abs(entity.sweepRadians ?? ((entity.clockwise ? entity.startAngle - entity.endAngle : entity.endAngle - entity.startAngle) + 2 * Math.PI) % (2 * Math.PI));
        return <path key={index} vectorEffect="non-scaling-stroke" d={`M ${entity.start.x} ${entity.start.y} A ${entity.radius} ${entity.radius} 0 ${sweep > Math.PI ? 1 : 0} ${entity.clockwise ? 0 : 1} ${entity.end.x} ${entity.end.y}`} />;
      })}
    </g>
  </svg>;
}

export function CadSectionDialog({ bodies, initialBodyId, version, onClose, onInspect, onSend }: {
  bodies: readonly Pick<CadMesh, 'featureId' | 'name' | 'bounds'>[];
  initialBodyId: string;
  version: string;
  onClose(): void;
  onInspect(request: CadSectionRequest, version: string, signal: AbortSignal): Promise<CadSectionResult>;
  onSend(request: CadSectionRequest, version: string, signal: AbortSignal): Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<AbortController | null>(null);
  const initialBody = bodies.find(body => body.featureId === initialBodyId) ?? bodies[0];
  const [bodyId, setBodyId] = useState(initialBody?.featureId ?? '');
  const [plane, setPlane] = useState<CadPlane>('XY');
  const [offset, setOffset] = useState(cadSectionMiddleOffset(initialBody, 'XY'));
  const [result, setResult] = useState<CadSectionResult | null>(null);
  /** The failure shown: its message and, for a CAM step's refusal, the code of its CAM issue. */
  const [error, setError] = useState<{ readonly message: string; readonly code: string | null } | null>(null);
  const [busy, setBusy] = useState<'inspect' | 'send' | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const request: CadSectionRequest = { bodyId, plane, offset };
  const requestKey = JSON.stringify([version, request]);
  const currentKey = useRef(requestKey); currentKey.current = requestKey;
  useEffect(() => { dialog.current?.showModal(); return () => { pending.current?.abort(); }; }, []);
  async function execute(kind: 'inspect' | 'send') {
    if (pending.current || kind === 'send' && reviewed !== requestKey) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(kind); setError(null);
    try {
      if (kind === 'inspect') {
        const next = await onInspect(request, version, controller.signal);
        if (!controller.signal.aborted && currentKey.current === requestKey) { setResult(next); setReviewed(requestKey); }
      } else {
        await onSend(request, version, controller.signal);
        // A successful storage receipt remains successful even if cancellation arrived late.
        onClose();
      }
    } catch (error) {
      // A refusal of the Section step is a CAM issue about the operation and its body; the alert keeps the refusal's own message.
      if (!controller.signal.aborted) setError({ message: userFacingMessage(error, 'Section operation failed.'), code: cadRefusalIssue(error)?.code ?? null });
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(null); }
    }
  }
  const button = 'border border-border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-accent';
  const input = 'mt-1 w-full border border-border bg-background px-2 py-1.5 text-xs';
  return <dialog ref={dialog} aria-label="Section for CAM" className="m-auto w-[720px] max-h-[85vh] overflow-auto border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); else if (busy === 'inspect') pending.current?.abort(); }}>
    <div className="flex items-center justify-between border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Section for CAM</h2><Button className={button} disabled={busy !== null} onClick={onClose}>Close</Button></div>
    <div className="space-y-3 p-4 text-xs">
      <p className="text-muted-foreground">Cut the final solid with a plane and transfer its exact closed contours. The preview includes downstream cuts and Boolean operations.</p>
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
        <label>Solid body<Select className="mt-1 w-full px-2 py-1.5 text-xs" value={bodyId} disabled={busy !== null} onChange={event => {
          setBodyId(event.target.value); setOffset(cadSectionMiddleOffset(bodies.find(body => body.featureId === event.target.value), plane)); setError(null);
        }}>{bodies.map(body => <option key={body.featureId} value={body.featureId}>{body.name}</option>)}</Select></label>
        <label>Section plane<Select className="mt-1 w-full px-2 py-1.5 text-xs" value={plane} disabled={busy !== null} onChange={event => {
          const next = event.target.value;
          if (next === 'XY' || next === 'XZ' || next === 'YZ') { setPlane(next); setOffset(cadSectionMiddleOffset(bodies.find(body => body.featureId === bodyId), next)); setError(null); }
        }}><option>XY</option><option>XZ</option><option>YZ</option></Select></label>
        <label>Plane offset (mm)<Input className={input} value={offset} disabled={busy !== null} onChange={event => setOffset(event.target.value)} /></label>
      </div>
      <p className="text-muted-foreground">Offset follows {plane === 'XY' ? '+Z' : plane === 'XZ' ? '−Y' : '+X'}. Use a plane inside the material. Ellipse and spline sections are reported as unsupported.</p>
      <div className="flex items-center gap-3"><Button className={button} disabled={busy !== null || !bodies.length} onClick={() => { void execute('inspect'); }}>Preview section</Button>{busy === 'inspect' && <Button className={button} onClick={() => pending.current?.abort()}>Cancel section</Button>}<span role="status">{busy === 'inspect' ? 'Computing exact section…' : busy === 'send' ? 'Saving CAD and creating CAM project…' : reviewed === requestKey && result ? `${result.contourCount} closed contours · ${result.entities.length} analytic curves` : 'Preview the current plane before sending.'}</span></div>
      {error && <p role="alert" className="text-destructive" data-cad-issue-code={error.code ?? undefined}>{error.message}</p>}
      {reviewed === requestKey && result && <CadSectionPreview entities={result.entities} />}
      <div className="flex items-center justify-between gap-6 border-t border-border pt-3"><p className="text-muted-foreground">Saves CAD, then opens a new detached CAM project in local plane coordinates. Review stock, wire and machining settings in CAM.</p><Button className={`${button} shrink-0 bg-primary text-primary-foreground`} disabled={busy !== null || reviewed !== requestKey} onClick={() => { void execute('send'); }}>Send section to CAM</Button></div>
    </div>
  </dialog>;
}
