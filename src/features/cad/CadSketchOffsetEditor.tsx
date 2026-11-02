import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { CadDocument, CadScalar, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { inspectCadScalarValue } from '@/domain/cad/cadScalarValueIntent';
import { compileCadSketchGraph } from '@/domain/cad/cadSketchGraphGeometry';
import type { CadSketchOffsetSource } from '@/domain/cad/cadSketchOffset';
import { cadSketchGeneratorMembers } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CAD_SKETCH_OFFSET_LINKS_MAX } from '@/domain/cad/sketch-generators/cadSketchGeneratorSchema';
import { cadSketchProfileGenerator } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import type { CadSketchGraphSelection } from './cadSketchGraphInteraction';
import { ScalarField } from './CadFields';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import { CadSketchCommandForm, useCadSketchCommandSession, type CadSketchCommandSessionProps } from './useCadSketchCommandSession';

/**
 * A selected edge identifies its exact whole compiler cycle; points and multiple loops do not guess a source. A generated shape selected
 * by its interior or from the tree names the cycle made of exactly its edges, so it offsets as a selected edge of it would; a saved
 * profile names itself.
 */
export function cadSketchOffsetSource(sketch: CadSketchFeature, parameters: CadDocument['parameters'], selection: readonly CadSketchGraphSelection[], profileId: string | null): CadSketchOffsetSource | null {
  const cycle = (matches: (refs: readonly { readonly entityId: string }[]) => boolean): CadSketchOffsetSource | null => {
    const cycles = sketch.graph ? compileCadSketchGraph(sketch.graph, parameters).cycles.filter(cycle => !cycle.construction && matches(cycle.sourceRefs)) : [];
    return cycles.length === 1 ? { kind: 'graph-cycle', sourceRefs: cycles[0].sourceRefs } : null;
  };
  if (selection.length) {
    if (selection.some(item => item.kind !== 'entity') || !sketch.graph) return null;
    // One edge names its loop, and so do several edges of the same loop, as a finished Offset or Mirror leaves the whole copy selected.
    const ids = selection.map(item => item.id);
    return cycle(refs => ids.every(id => refs.some(ref => ref.entityId === id)));
  }
  const generator = profileId ? cadSketchProfileGenerator(sketch, profileId) : undefined;
  if (generator) {
    // A construction shape's cycle is construction, so it names none, as a construction profile does not. Every kind draws one loop, a
    // plugin's outline too, so a shape the sketch leaves unbranched has exactly one.
    if (!sketch.graph) return null;
    const edges = new Set(cadSketchGeneratorMembers(sketch.graph, generator).entityIds);
    return cycle(refs => refs.length === edges.size && refs.every(ref => edges.has(ref.entityId)));
  }
  const profile = sketch.profiles.find(profile => profile.id === profileId);
  return profile && !profile.construction && profile.geometry.kind !== 'plugin' ? { kind: 'profile', profileId: profile.id } : null;
}

interface Props extends CadSketchCommandSessionProps {
  sketch: CadSketchFeature;
  source: CadSketchOffsetSource;
  onPrepareEdits?: CadPrepareEdits;
  onAccepted(entityIds: readonly string[]): void;
}

/**
 * The edit that offsets `source` by `distance`: an independent copy, or, for a loop of sketch curves, a linked offset whose edges its
 * generator `generatorId` keeps following the loop and the distance.
 */
export function cadSketchOffsetEdits(sketchId: string, source: CadSketchOffsetSource, distance: CadScalar, linked: boolean, ids: { readonly idPrefix: string; readonly generatorId: string }): readonly CadEdit[] {
  if (!linked || source.kind !== 'graph-cycle') return [{ kind: 'offset-sketch-loop', sketchId, source, distance, idPrefix: ids.idPrefix }];
  const chain = source.sourceRefs.map(({ entityId, reversed }) => ({ entityId, reversed }));
  return [{ kind: 'set-sketch-generator', sketchId, generator: { id: ids.generatorId, kind: 'generator', idPrefix: ids.generatorId, construction: false, geometry: { kind: 'offset', chain, distance } } }];
}

/** One disposable scalar request, sharing the ordinary prepared edit and submission lifetimes. */
export function CadSketchOffsetEditor(props: Props) {
  const session = useCadSketchCommandSession(props, () => {
    const unique = crypto.randomUUID().replaceAll('-', '');
    // A generator's prefix names its members' namespace, which takes letters, digits and hyphens only.
    return { sketch: props.sketch, source: props.source, ids: { idPrefix: `offset_${unique}`, generatorId: `offset-${unique.slice(0, 16)}` } };
  });
  const { owner, setError } = session;
  const [distance, setDistance] = useState<CadScalar>(1);
  const [linked, setLinked] = useState(false);
  const linkable = owner.source.kind === 'graph-cycle';
  // A linked offset's generator follows at most so many curves; a longer loop is copied independently.
  const links = owner.source.kind === 'graph-cycle' ? owner.source.sourceRefs.length : 0;
  const unlinkable = links > CAD_SKETCH_OFFSET_LINKS_MAX ? `A linked offset follows at most ${CAD_SKETCH_OFFSET_LINKS_MAX} curves, and this loop has ${links}. Copy it independently.` : null;
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => { form.current?.querySelector('input')?.select(); }, []);
  const quantity = useMemo(() => { try { return evaluateCadScalar(distance, owner.document.parameters); } catch { return null; } }, [distance, owner]);
  const edits = useMemo<readonly CadEdit[] | null>(() => quantity === 0 ? null : cadSketchOffsetEdits(owner.sketch.id, owner.source, distance, linked, owner.ids),
    [owner, distance, quantity, linked]);
  const prepared = useCadPreparedPreview(owner.document, edits, props.onPrepareEdits, session.previewEnabled);
  useLayoutEffect(() => { props.onPreviewDocument(prepared.kind === 'ready' ? prepared.document : null, cadPreviewMarks(prepared)); }, [prepared, props.onPreviewDocument]);
  const flip = (inside: boolean) => {
    if (quantity !== null && quantity !== 0 && (quantity < 0) !== inside) {
      setDistance(inspectCadScalarValue(distance, owner.document.parameters).kind === 'literal' ? -quantity : `-(${distance})`);
      setError(null);
    }
  };
  return <CadSketchCommandForm label="Offset loop" formRef={form} session={session} canApply={Boolean(edits) && prepared.kind === 'ready'}
    issue={session.error ?? (prepared.kind === 'error' ? prepared.message : null)}
    help={linked && linkable ? 'Linked offset. Its edges follow the loop and the distance, and any parameter it names. Select one to edit the offset; detach it to edit the edges on their own.'
      : 'Independent copy. No offset relation. Later changes to the source or distance parameter do not move the copy.'}
    onSubmit={() => {
      if (!edits || prepared.kind !== 'ready') return;
      const candidate = prepared.document.features.find(feature => feature.kind === 'sketch' && feature.id === owner.sketch.id);
      // The whole copied loop is selected, as Mirror selects its whole copy.
      const copied = candidate?.kind === 'sketch' ? candidate.graph?.entities.filter(entity => !owner.sketch.graph?.entities.some(original => original.id === entity.id)).map(entity => entity.id) : null;
      if (copied?.length) session.submit(edits, prepared.document, () => props.onAccepted(copied), 'The offset could not be applied.');
    }}>
    <fieldset className="cad-editor-fieldset" disabled={props.interactionLocked || session.applying}>
      <ScalarField label="Offset distance" value={distance} parameters={owner.document.parameters} onChange={value => { setDistance(value); setError(null); }} />
      <div className="cad-sketch-profile-actions" role="group" aria-label="Offset side">
        <Button type="button" aria-pressed={quantity !== null && quantity < 0} onClick={() => flip(true)}>Inside</Button>
        <Button type="button" aria-pressed={quantity !== null && quantity > 0} onClick={() => flip(false)}>Outside</Button>
      </div>
      {linkable && <div className="cad-sketch-profile-actions" role="group" aria-label="Offset link">
        <Button type="button" aria-pressed={!linked} onClick={() => { setLinked(false); setError(null); }}>Independent</Button>
        <Button type="button" aria-pressed={linked} disabled={Boolean(unlinkable)} title={unlinkable ?? undefined} onClick={() => { setLinked(true); setError(null); }}>Linked</Button>
      </div>}
    </fieldset>
  </CadSketchCommandForm>;
}
