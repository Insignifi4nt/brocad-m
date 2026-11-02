import { createCadDocument, parseCadDocument } from '../cadSchema';
import { importCadDxfSketch } from '../cadDxfImport';

export const slotProfileCopyRequest = { sourceSketchId: 'source', profileId: 'slot', newSketchId: 'copy', name: 'Editable outline', idPrefix: 'copy' } as const;
export const dxfProfileCopyRequest = { ...slotProfileCopyRequest, profileId: 'contour_1' } as const;

export function profileCopySlotPart() {
  return parseCadDocument({ ...createCadDocument('Exact rotated Slot', 'slot-source'), parameters: { slotLength: 30, sourceOffset: 2.5 },
    parameterGroups: [{ id: 'sizes', name: 'Source sizes' }], parameterMetadata: { slotLength: { groupId: 'sizes', source: { kind: 'manual' } } },
    features: [{ id: 'source', kind: 'sketch', name: 'Rotated Slot', suppressed: false, plane: 'XZ', offset: ' sourceOffset ', profiles: [{
      id: 'slot', name: 'Rotated outline', construction: false, geometry: { kind: 'slot', x: '11.00', y: '-7.00', length: ' slotLength ', width: '10.0000', angle: '30.00' }
    }] }] });
}

export function profileCopyDxfPart() {
  const text = '\ufeff' + ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '999', '原本 • Major arc 😀',
    '0', 'ARC', '8', 'OUTLINE', '10', '0', '20', '0', '40', '1', '50', '0', '51', '270',
    '0', 'LINE', '8', 'OUTLINE', '10', '0', '20', '-1', '11', '1', '21', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
  const imported = importCadDxfSketch({ fileName: 'Major-孔.dxf', text, sketchId: 'source', name: 'Accepted inch major arc' });
  return parseCadDocument({ ...createCadDocument('Accepted DXF', 'dxf-source'), schemaVersion: 2, features: [imported.sketch] });
}
