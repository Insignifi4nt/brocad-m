import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { parseCadDocument } from '@/domain/cad/cadSchema';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import { validateCadSketchRegionProposal, type CadSketchRegionProposal } from '@/domain/cad/cadSketchRegionInspection';
import { prepareCadEdits } from './cadEditPreparation';
import type { CadSketchSolverClient } from './sketch-solver/cadSketchSolverTypes';

/** A region proposal ready to read, with the document to read it from. */
export interface CadPreparedSketchRegionProposal { readonly document: CadDocument; readonly proposal: CadSketchRegionProposal }

/**
 * A region proposal read as the edit it describes would make it. A generator's set-sketch-generator fields, after its parameter values
 * as set-parameter edits, are prepared by `prepareCadEdits`: reduced, solved and settled, so free geometry related to the members moves
 * as the edit moves it, and an unconfirmed removal refuses as the edit refuses. Only the part up to the proposed sketch is prepared,
 * so a source whose later consumers need deliberate area repairs can still be read. The prepared sketch is returned as a complete
 * same-ID proposal with the same parameter values, to be read from that prepared part: the preceding sketches it uses are there as the
 * edit leaves them, solved for the parameter values, so their references to the proposed sketch agree. Other proposals, and those naming
 * no active sketch, are returned as given, with the document.
 */
export async function prepareCadSketchRegionProposal(document: CadDocument, sketchId: string, proposal: CadSketchRegionProposal,
  solver: Pick<CadSketchSolverClient, 'solve'>, signal?: AbortSignal): Promise<CadPreparedSketchRegionProposal> {
  validateCadSketchRegionProposal(proposal);
  if (proposal.generator === undefined) return { document, proposal };
  const validated = parseCadDocument(document), index = validated.features.findIndex(feature => feature.id === sketchId);
  const sketch = validated.features[index];
  if (sketch?.kind !== 'sketch' || !cadFeatureActive(sketch, validated)) return { document, proposal };
  const { generator, removedRelationIds } = proposal.generator, parameterValues = proposal.parameterValues ?? {};
  const edits: CadEdit[] = [...Object.entries(parameterValues).map(([name, value]): CadEdit => ({ kind: 'set-parameter', name, value })),
    { kind: 'set-sketch-generator', sketchId, generator, ...removedRelationIds === undefined ? {} : { removedRelationIds } }];
  const prepared = (await prepareCadEdits({ ...validated, features: validated.features.slice(0, index + 1) }, edits, solver, signal)).document;
  const source = prepared.features.find(feature => feature.id === sketchId);
  if (source?.kind !== 'sketch') throw new Error('The prepared proposal lost its sketch.');
  return { document: prepared, proposal: { sketch: source, ...proposal.parameterValues === undefined ? {} : { parameterValues: proposal.parameterValues } } };
}
