import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from '@wire-edm/icons-react';
import type { CadDocument } from '@/domain/cad/cadDocument';
import { inspectCadLoftSectionPair, resolveCadLoftSectionPlacements, MAX_CAD_LOFT_SECTIONS, MIN_CAD_LOFT_SECTIONS } from '@/domain/cad/cadLoft';
import { CadError } from '@/domain/cad/cadError';
import { inspectCadLoftCandidates } from './cadLoftUi';
import { cadPlacementLabel } from './cadPlacementUi';
import { CadReferencePickButton } from './CadFields';
import { formatCadQuantity } from './cadDisplayQuantity';

export function CadLoftSections({ document, featureId, sketchIds, onChange, applyError = null }: {
  document: CadDocument;
  featureId: string;
  sketchIds: readonly string[];
  onChange(sketchIds: readonly string[]): void;
  applyError?: string | null;
}) {
  // Region analysis belongs to the immutable document, not each draft field edit.
  const candidates = useMemo(() => inspectCadLoftCandidates(document, featureId), [document.features, document.parameters, featureId]);
  const candidatesById = useMemo(() => new Map(candidates.map(candidate => [candidate.sketch.id, candidate])), [candidates]);
  const chosenIds = useMemo(() => new Set(sketchIds), [sketchIds]);
  const [addId, setAddId] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const focusAfterChange = useRef<string | null>(null);
  const first = candidatesById.get(sketchIds[0]);
  const pairs = useMemo(() => new Map(candidates.flatMap(candidate => first?.inspection.eligible && candidate.inspection.eligible
    ? [[candidate.sketch.id, inspectCadLoftSectionPair(first.inspection.section, candidate.inspection.section)] as const] : [])), [candidates, first]);
  const placement = useMemo(() => {
    try {
      const sections = sketchIds.map(id => {
        const candidate = candidatesById.get(id);
        if (!candidate) throw new CadError('invalid-reference', 'Choose an earlier sketch.');
        if (!candidate.inspection.eligible) throw CadError.checked(candidate.inspection.code, candidate.inspection.message);
        return candidate.inspection.section;
      });
      return { resolved: resolveCadLoftSectionPlacements(sections), error: null };
    } catch (error) {
      if (!(error instanceof CadError)) throw error;
      return { resolved: null, error: error.message };
    }
  }, [sketchIds, candidatesById]);
  const candidateDisabled = (id: string, currentId?: string) => {
    const candidate = candidatesById.get(id);
    return !candidate?.inspection.eligible || id !== currentId && chosenIds.has(id) || currentId !== sketchIds[0] && pairs.get(id)?.compatible === false;
  };
  const available = candidates.filter(candidate => !candidateDisabled(candidate.sketch.id));
  const selectedAddId = available.some(candidate => candidate.sketch.id === addId) ? addId : available[0]?.sketch.id ?? '';
  useLayoutEffect(() => {
    const requested = focusAfterChange.current;
    if (!requested) return;
    focusAfterChange.current = null;
    const fields = [...host.current?.querySelectorAll<HTMLSelectElement>('select') ?? []];
    fields.find(field => field.getAttribute('data-sketch-id') === requested)?.focus();
  }, [sketchIds]);
  const move = (index: number, direction: number) => {
    const ids = [...sketchIds];
    const current = ids[index], other = ids[index + direction];
    if (!current || !other) return;
    ids[index] = other; ids[index + direction] = current;
    focusAfterChange.current = current; onChange(ids);
  };
  return <div ref={host} className="cad-loft-sections">
    <div className="cad-field-section">Sections <small>{sketchIds.length} / {MAX_CAD_LOFT_SECTIONS}</small></div>
    <ol className="cad-loft-section-list" aria-label="Loft sections">
      {sketchIds.map((id, index) => {
        const candidate = candidatesById.get(id);
        const inspection = candidate?.inspection;
        const pair = pairs.get(id);
        const problem = !inspection ? 'Choose an earlier sketch.' : !inspection.eligible ? inspection.message
          : pair?.compatible === false ? pair.message : null;
        const placed = placement.resolved?.sections[index];
        const name = inspection?.eligible ? cadPlacementLabel(inspection.section.plane, document.features) : '';
        const number = formatCadQuantity;
        const metadata = placed ? placement.resolved?.legacyPrincipalPlane !== null ? `${name} · ${number(placed.offset)} mm`
          : `${name} · station ${number(placed.stationMm)} mm` : problem ? 'Unavailable section' : name;
        const metadataTitle = placed && placement.resolved?.legacyPrincipalPlane === null
          ? `Station from first placed section (${first?.sketch.name ?? ''}). Authored offset: ${number(placed.offset)} mm; in-plane shift: ${placed.tangentialOffsetMm.map(number).join(', ')} mm.` : problem ?? undefined;
        return <li key={id} className="cad-loft-section-row">
          <span className="cad-loft-section-number">{index + 1}</span>
          <Select aria-label={`Section ${index + 1}`} data-sketch-id={id} value={id} aria-invalid={problem ? true : undefined}
            onChange={event => { const nextId = event.target.value; if (!candidateDisabled(nextId, id)) { focusAfterChange.current = nextId; onChange(sketchIds.map((entry, position) => position === index ? nextId : entry)); } }}>
            {!candidate && <option value={id} disabled>{document.features.find(feature => feature.id === id)?.name ?? 'Sketch'} (unavailable)</option>}
            {candidates.map(entry => {
              const pair = id !== sketchIds[0] ? pairs.get(entry.sketch.id) : undefined;
              const message = !entry.inspection.eligible ? entry.inspection.message : pair?.compatible === false ? pair.message : null;
              const reason = !entry.inspection.eligible ? entry.inspection.message.slice(0, 90) : pair?.compatible === false
                ? pair.code === 'unsupported-loft-planes' ? 'Incompatible frame' : 'Unsupported placement' : null;
              return <option key={entry.sketch.id} value={entry.sketch.id} disabled={candidateDisabled(entry.sketch.id, id)} data-description={message ?? entry.sketch.name}>
                {entry.sketch.name}{reason ? ` — ${reason}` : ''}
              </option>;
            })}
          </Select>
          <CadReferencePickButton label={`Section ${index + 1}`} options={candidates.map(candidate => ({ value: candidate.sketch.id, disabled: candidateDisabled(candidate.sketch.id, id) }))} onSelect={nextId => {
            if (!candidateDisabled(nextId, id)) { focusAfterChange.current = nextId; onChange(sketchIds.map((entry, position) => position === index ? nextId : entry)); }
          }} />
          <Button type="button" aria-label={`Move section ${index + 1} up`} title="Move section up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></Button>
          <Button type="button" aria-label={`Move section ${index + 1} down`} title="Move section down" disabled={index === sketchIds.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></Button>
          <Button type="button" aria-label={`Remove section ${index + 1}`} title="Remove section" disabled={sketchIds.length <= MIN_CAD_LOFT_SECTIONS} onClick={() => {
            focusAfterChange.current = sketchIds[index + 1] ?? sketchIds[index - 1] ?? null; onChange(sketchIds.filter((_, position) => position !== index));
          }}><X size={12} /></Button>
          <Tooltip content={metadataTitle}><small className={placement.resolved ? 'cad-loft-section-metadata' : 'cad-loft-section-status'} >{metadata}</small></Tooltip>
        </li>;
      })}
    </ol>
    {available.length > 0 && <div className="cad-loft-section-add">
      <Select aria-label="Sketch to add" value={selectedAddId} disabled={!selectedAddId || sketchIds.length >= MAX_CAD_LOFT_SECTIONS} onChange={event => setAddId(event.target.value)}>
        {!selectedAddId && <option value="">No compatible sketch</option>}
        {available.map(candidate => <option key={candidate.sketch.id} value={candidate.sketch.id}>{candidate.sketch.name}</option>)}
      </Select>
      <CadReferencePickButton label="New section" disabled={sketchIds.length >= MAX_CAD_LOFT_SECTIONS} options={available.map(candidate => ({ value: candidate.sketch.id }))} onSelect={nextId => {
        if (sketchIds.length < MAX_CAD_LOFT_SECTIONS && !candidateDisabled(nextId)) { focusAfterChange.current = nextId; onChange([...sketchIds, nextId]); }
      }} />
      <Button type="button" aria-label="Add section" title="Add section" disabled={!selectedAddId || sketchIds.length >= MAX_CAD_LOFT_SECTIONS} onClick={() => {
        if (selectedAddId && sketchIds.length < MAX_CAD_LOFT_SECTIONS && !candidateDisabled(selectedAddId)) { focusAfterChange.current = selectedAddId; onChange([...sketchIds, selectedAddId]); }
      }}><Plus size={13} /></Button>
    </div>}
    {placement.error && placement.error !== applyError && <p className="cad-error">{placement.error}</p>}
  </div>;
}
