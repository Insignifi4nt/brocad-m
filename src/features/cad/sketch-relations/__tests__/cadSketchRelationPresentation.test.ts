import { describe, expect, it } from 'vitest';
import { CAD_SKETCH_RELATION_KINDS } from '@/domain/cad/sketch-relations/cadSketchRelationRegistry';
import { CAD_SKETCH_RELATION_ICONS, CAD_SKETCH_RELATION_PRESENTATION, type CadSketchRelationGlyphKind } from '../cadSketchRelationPresentation';

describe('sketch relation presentation', () => {
  it('present every relation kind once, in the order the definitions list them', () => {
    expect(Object.keys(CAD_SKETCH_RELATION_PRESENTATION)).toEqual(CAD_SKETCH_RELATION_KINDS);
    expect(Object.isFrozen(CAD_SKETCH_RELATION_PRESENTATION)).toBe(true);
  });

  it('show each glyph with its own drawing as the kind icon, and draw every glyph for some kind', () => {
    const drawn = new Set<CadSketchRelationGlyphKind>();
    for (const kind of CAD_SKETCH_RELATION_KINDS) {
      const { glyph, centred } = CAD_SKETCH_RELATION_PRESENTATION[kind];
      if (glyph) expect(CAD_SKETCH_RELATION_PRESENTATION[kind].icon, kind).toBe(CAD_SKETCH_RELATION_ICONS[glyph.glyph]);
      for (const shown of [glyph, centred]) if (shown) drawn.add(shown.glyph);
    }
    expect([...drawn].sort()).toEqual(Object.keys(CAD_SKETCH_RELATION_ICONS).sort());
  });

  it('read only a Coincident between centres as Concentric, and draw a held coordinate only while it keeps a point on an axis', () => {
    const centred = CAD_SKETCH_RELATION_KINDS.filter(kind => CAD_SKETCH_RELATION_PRESENTATION[kind].centred);
    const onAxisOnly = CAD_SKETCH_RELATION_KINDS.filter(kind => CAD_SKETCH_RELATION_PRESENTATION[kind].onAxisOnly);
    expect(centred).toEqual(['coincident']);
    expect(CAD_SKETCH_RELATION_PRESENTATION.coincident.centred).toEqual({ glyph: 'concentric', anchor: 'curves' });
    expect(onAxisOnly).toEqual(['fixed-axis']);
  });

  it('draw no glyph for dimensions, patterns, linked references, corners and generators', () => {
    expect(CAD_SKETCH_RELATION_KINDS.filter(kind => !CAD_SKETCH_RELATION_PRESENTATION[kind].glyph)).toEqual(['linear-pattern', 'reference-dimension', 'external-reference',
      'line-angle', 'radial-size', 'distance', 'point-line-distance', 'axis-distance', 'fillet-corner', 'chamfer-corner', 'generator']);
  });
});
