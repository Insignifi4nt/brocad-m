import { userFacingMessage } from '@/lib/userMessage';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useEffect, useRef, useState } from 'react';
import type { CadDxfUnits } from '@/domain/cad/cadDxfSource';
import { CadKernelMessage, cadKernelMessageOf } from './CadKernelMessage';

export function CadImportDialog({ file, onImport, onCancel }: {
  file: File; onImport(units: CadDxfUnits | 'file', dxfKind?: 'sketch' | 'curve'): Promise<unknown>; onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [units, setUnits] = useState<CadDxfUnits | 'file'>(/\.stl$/i.test(file.name) ? 'mm' : 'file');
  const [dxfKind, setDxfKind] = useState<'sketch' | 'curve'>('sketch');
  const [busy, setBusy] = useState(false);
  /** The failure shown, with the kernel's own words when it gave any. */
  const [error, setError] = useState<{ readonly message: string; readonly kernelMessage: string | null } | null>(null);
  const stl = /\.stl$/i.test(file.name);
  const dxf = /\.dxf$/i.test(file.name);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function confirm() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await onImport(units, dxf ? dxfKind : undefined); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError({ message: userFacingMessage(cause, 'Import failed.'), kernelMessage: cadKernelMessageOf(cause) }); }
    finally { pending.current = false; setBusy(false); }
  }
  const button = 'border border-border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-accent';
  return <dialog ref={dialog} aria-label="Import CAD file" className="m-auto w-[420px] border border-border bg-card p-4 text-foreground backdrop:bg-black/60"
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <Tooltip content={file.name}><h2 className="truncate text-sm font-medium" >{file.name}</h2></Tooltip>
      <p className="mt-1 text-xs text-muted-foreground">{stl ? 'STL · Faceted solid' : dxf ? 'DXF' : 'STEP · Exact solid'} · {(file.size / 1024).toFixed(1)} KiB</p>
      {dxf && <label className="mt-4 block text-xs">Import as<Select className="ml-4 px-2 py-1" value={dxfKind} disabled={busy}
        onChange={event => setDxfKind(event.target.value === 'curve' ? 'curve' : 'sketch')}>
        <option value="sketch">Sketch · Closed contours</option><option value="curve">Curve · Open chain</option></Select></label>}
      {stl || dxf ? <label className="mt-4 block text-xs">Source units<Select autoFocus className="ml-4 px-2 py-1" value={units} disabled={busy}
        onChange={event => { const next = event.target.value; if (next === 'mm' || next === 'inch' || next === 'cm' || next === 'm' || next === 'file') setUnits(next); }}>
        {dxf && <option value="file">Use file declaration</option>}<option value="mm">Millimeters</option><option value="inch">Inches</option>{dxf && <><option value="cm">Centimeters</option><option value="m">Meters</option></>}</Select></label>
        : <p className="mt-4 text-xs text-muted-foreground">Uses the file’s units.</p>}
      {error && <p role="alert" className="mt-3 text-xs text-destructive">{error.message}</p>}
      {error && <CadKernelMessage text={error.kernelMessage} />}
      <div className="mt-5 flex justify-end gap-2"><Button type="button" className={button} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" autoFocus={!stl && !dxf} className={`${button} bg-primary text-primary-foreground`} disabled={busy}>{busy ? 'Importing…' : 'Import'}</Button></div>
    </form>
  </dialog>;
}
