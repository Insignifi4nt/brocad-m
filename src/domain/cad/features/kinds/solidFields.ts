import { Type } from '@sinclair/typebox';
import { CadError } from '../../cadError';
import type { CadRefusalCode } from '../../cadIssueCodes';
import { CadSketchRegionSelectionSchema, validateCadSketchRegionSelection, type CadSketchRegionSelection } from '../../cadSketchRegionSelection';
import type { CadFeatureChoice } from '../cadFeatureDefinitionTypes';
import { cadFeatureField, cadFeatureOptionalReference, cadFeatureReference } from '../cadFeatureFields';

// Fields that several kinds store alike.

const operationChoices: readonly CadFeatureChoice<'new' | 'join' | 'cut'>[] = [
  { value: 'new', label: 'New body' }, { value: 'join', label: 'Join to body' }, { value: 'cut', label: 'Cut from body' }];
/** Whether a sketch-based solid makes a new body or joins or cuts its target. */
const solidOperation = Type.Union([Type.Literal('new'), Type.Literal('join'), Type.Literal('cut')]);
export const cadSolidOperationField = cadFeatureField<typeof solidOperation, 'new' | 'join' | 'cut'>(solidOperation, { choices: operationChoices });
/** The body a join or cut replaces, null for a new body. */
export const cadSolidTargetField = cadFeatureOptionalReference({ role: 'target', accepts: ['body'] },
  { field: 'operation', absentWhen: 'new', refusal: 'New bodies have no target; join and cut require a target body.' });
/** The body a feature replaces. */
export const cadTargetBodyField = cadFeatureReference({ role: 'target', accepts: ['body'] });
/** The body a feature takes as its source. */
export const cadSourceBodyField = cadFeatureReference({ role: 'source', accepts: ['body'] });
/** The sketch whose regions a feature uses. */
export const cadProfileSketchField = cadFeatureReference({ role: 'profile', accepts: ['sketch'] });
/** The sketch areas a Pad or Pocket uses, absent for the whole sketch's automatic regions. */
const optionalRegionSelection = Type.Optional(CadSketchRegionSelectionSchema);
export const cadRegionSelectionField = cadFeatureField<typeof optionalRegionSelection, CadSketchRegionSelection>(optionalRegionSelection, {
    // The places along their supports where a selected area's boundary and holes run.
    quantities: ['outer.*{range}.from', 'outer.*{range}.to', 'holes.*.*{range}.from', 'holes.*.*{range}.to']
      .map(path => ({ path: `{graph-cells}.cells.*.${path}`, quantity: 'index' })),
    check(selection, context) {
      validateCadSketchRegionSelection(selection);
      if (!Array.isArray(selection) && context.document.schemaVersion !== 2)
        throw new CadError('unsupported-sketch-format', 'Graph cell area selections require CAD schema 2. Preserve the schema 1 original when saving an upgrade.');
    }
  });

// Refusals that several kinds share.

/** Reading a solid's material regions from its sketch: an empty sketch or profile, or a region selection that no longer fits it. */
export const cadSketchRegionDiagnostics: readonly CadRefusalCode[] = ['empty-sketch', 'empty-profile', 'invalid-profile', 'invalid-region-selection', 'stale-sketch-region',
  'invalid-sketch-cells', 'invalid-sketch-cell-id', 'unsupported-sketch-cells'];
/** Confirming the material a cut (`cut`) or a Pocket (`pocket`) removes, as the kernel's material evidence names its refusals. */
export function cadMaterialDiagnostics(operation: 'cut' | 'pocket'): readonly CadRefusalCode[] {
  return [`${operation}-tool`, `${operation}-invalid`, `${operation}-open`, `${operation}-no-material`, `${operation}-erased`,
    `unsupported-${operation}-target`, `unsupported-${operation}-removal`, `unsupported-${operation}-precision`];
}
