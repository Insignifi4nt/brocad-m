import { describe, expect, it } from 'vitest';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraph, type CadSketchGraphEntity } from '../cadSketchGraph';
import { setCadDevelopmentChecks } from '../cadDevelopmentChecks';
import { expandCadSketchGenerators } from '../sketch-generators/cadSketchGenerators';
import { resolveCadSketchPointIdentities } from '../cadSketchGraphJoints';
import { CadError } from '../cadError';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { cadAnalyticSegments } from '../cadAnalyticSegments';
import { signedAreaOfPath } from '@/domain/path-intel/segments';

const square = () => ({
  points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: ['width', 0] }, { id: 'c', position: ['width', 10] }, { id: 'd', position: [0, 10] }],
  entities: [
    { id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
    { id: 'cb', kind: 'line', startPointId: 'c', endPointId: 'b', construction: false },
    { id: 'cd', kind: 'line', startPointId: 'c', endPointId: 'd', construction: false },
    { id: 'ad', kind: 'line', startPointId: 'a', endPointId: 'd', construction: false }
  ], relations: []
});

describe('identity-connected sketch graph geometry', () => {
  it('closes only declared coincident endpoint identities while preserving exact source supports', () => {
    const raw = square();
    for (const gap of [0, 5e-13]) {
      const source = { ...raw, points: [...raw.points, { id: 'near', position: [0, gap] }],
        entities: raw.entities.map(entity => entity.id === 'ad' ? { ...entity, startPointId: 'near' } : entity),
        relations: [{ id: 'join', kind: 'coincident', pointIds: ['a', 'near'] }] };
      const graph = parseCadSketchGraph(source), before = JSON.stringify(graph);
      const compiled = compileCadSketchGraph(graph, { width: 20 });
      expect(compiled.cycles).toHaveLength(1);
      expect(compiled.openEntityIds).toEqual([]); expect(compiled.arrangementEntityIds).toEqual([]);
      expect(compiled.cycles[0].sourceRefs).toEqual([{ entityId: 'ab', reversed: false }, { entityId: 'cb', reversed: true },
        { entityId: 'cd', reversed: false }, { entityId: 'ad', reversed: true }]);
      expect(compiled.segments.find(segment => segment.id === 'ad')?.start).toEqual({ x: 0, y: gap });
      expect(JSON.stringify(graph)).toBe(before);
      const undeclared = compileCadSketchGraph(parseCadSketchGraph({ ...source, relations: [] }), { width: 20 });
      expect(undeclared.cycles).toEqual([]); expect(undeclared.openEntityIds).toHaveLength(4);
    }
  });
  it('keeps transitive orphan/construction aliases source-order independent without flipping original cycle witnesses', () => {
    const raw = square(), original = compileCadSketchGraph(parseCadSketchGraph(raw), { width: 20 });
    const graph = parseCadSketchGraph({ ...raw, points: [...raw.points, { id: 'near', position: [0, 5e-13] },
      { id: 'joint', position: [0, 2e-13] }, { id: '0alias', position: [' width ', 0] }],
      entities: [...raw.entities.map(entity => entity.id === 'ad' ? { ...entity, startPointId: 'near' } : entity),
        { id: 'guide', kind: 'circle', construction: true, centerPointId: 'joint', radius: 1 }],
      relations: [{ id: 'join-a', kind: 'coincident', pointIds: ['a', 'joint'] }, { id: 'join-near', kind: 'coincident', pointIds: ['joint', 'near'] },
        { id: 'alias-b', kind: 'coincident', pointIds: ['b', '0alias'] }] });
    const before = JSON.stringify(graph), result = compileCadSketchGraph(graph, { width: 20 });
    expect(result.cycles.filter(cycle => !cycle.construction)[0].sourceRefs).toEqual(original.cycles[0].sourceRefs);
    const reordered = compileCadSketchGraph(parseCadSketchGraph({ points: [...graph.points].reverse(), entities: [...graph.entities].reverse(), relations: [...graph.relations].reverse() }), { width: 20 });
    expect(reordered).toEqual(result); expect(JSON.stringify(graph)).toBe(before);
  });
  it('rejects accumulated coincidence drift even through unused points whose individual pair residuals pass', () => {
    const raw = square();
    const graph = parseCadSketchGraph({ ...raw, points: [...raw.points, { id: 'joint', position: [0, 8e-13] }, { id: 'near', position: [0, 1.6e-12] }],
      relations: [{ id: 'join-a', kind: 'coincident', pointIds: ['a', 'joint'] }, { id: 'join-near', kind: 'coincident', pointIds: ['joint', 'near'] }] });
    expect(checkCadSketchGraph(graph, { width: 20 })).toEqual([]);
    for (const relations of [graph.relations, [...graph.relations].reverse()]) {
      expect(() => compileCadSketchGraph(parseCadSketchGraph({ ...graph, relations }), { width: 20 })).toThrowError(expect.objectContaining({ code: 'sketch-graph-precision' }));
    }
  });
  it('refuses a cycle whose arc end and joint each drift within tolerance but together leave the encoded arc short of its neighbour', () => {
    // The arc is encoded by its start radius, so its end lands on (0, 10); the next edge starts at the far coincident point.
    const loop = (arcEnd: number, lineStart: number) => parseCadSketchGraph({
      points: [{ id: 'c', position: [0, 0] }, { id: 's', position: [10, 0] }, { id: 'e', position: [0, 10 + arcEnd] }, { id: 'f', position: [0, 10 + lineStart] },
        { id: 'g', position: [0, 20] }, { id: 'h', position: [20, 0] }],
      entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'c', startPointId: 's', endPointId: 'e', direction: 'ccw' },
        { id: 'up', kind: 'line', construction: false, startPointId: 'f', endPointId: 'g' },
        { id: 'across', kind: 'line', construction: false, startPointId: 'g', endPointId: 'h' },
        { id: 'back', kind: 'line', construction: false, startPointId: 'h', endPointId: 's' }],
      relations: [{ id: 'join', kind: 'coincident', pointIds: ['e', 'f'] }] });
    for (const [arcEnd, lineStart] of [[0, 0], [9e-13, 9e-13], [0, 9e-13]]) expect(compileCadSketchGraph(loop(arcEnd, lineStart), {}).cycles).toHaveLength(1);
    const drifted = loop(9e-13, 1.8e-12);
    expect(checkCadSketchGraph(drifted, {})).toEqual([]);
    expect(() => compileCadSketchGraph(drifted, {})).toThrowError(expect.objectContaining({ code: 'sketch-graph-precision', message: expect.stringContaining('no longer meet exactly') }));
  });
  it('retains branches, construction separation and unsupported crossings at declared joints', () => {
    const raw = square(), source = { ...raw, points: [...raw.points, { id: 'near', position: [0, 0] }, { id: 'tip', position: [-5, 0] }],
      entities: raw.entities.map(entity => entity.id === 'ad' ? { ...entity, startPointId: 'near' } : entity),
      relations: [{ id: 'join', kind: 'coincident', pointIds: ['a', 'near'] }] };
    const branch = compileCadSketchGraph(parseCadSketchGraph({ ...source, entities: [...source.entities,
      { id: 'tail', kind: 'line', construction: false, startPointId: 'near', endPointId: 'tip' }] }), { width: 20 });
    expect(branch.cycles).toEqual([]); expect(branch.branchedEntityIds).toEqual(['ab', 'ad', 'cb', 'cd', 'tail']);
    const mixed = compileCadSketchGraph(parseCadSketchGraph({ ...source, entities: source.entities.map(entity => ({ ...entity, construction: entity.id === 'ad' })) }), { width: 20 });
    expect(mixed.cycles).toEqual([]); expect(mixed.openEntityIds).toEqual(['ab', 'ad', 'cb', 'cd']);
    const crossing = compileCadSketchGraph(parseCadSketchGraph({ ...source, points: [
      { id: 'a', position: [0, 0] }, { id: 'b', position: [10, 10] }, { id: 'c', position: [0, 10] }, { id: 'd', position: [10, 0] }, { id: 'near', position: [0, 0] }
    ] }), { width: 20 });
    expect(crossing.cycles).toEqual([]); expect(crossing.arrangementEntityIds).toContain('ab');
    const collapsed = parseCadSketchGraph({ points: [{ id: 'a', position: [9e8, 0] }, { id: 'b', position: [9e8 + 5e-7, 0] }],
      entities: [{ id: 'edge', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations: [{ id: 'join', kind: 'coincident', pointIds: ['a', 'b'] }] });
    expect(checkCadSketchGraph(collapsed, {})).toEqual([]);
    expect(() => compileCadSketchGraph(collapsed, {})).toThrow('both of its ends meet at the same point');
  });
  it('joins distinct line/arc and arc/arc endpoints without attaching a coincident circle center to its rim', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'o', position: [0, 0] }, { id: 'a', position: [5, 0] }, { id: 'b', position: [0, 5] },
      { id: 'a2', position: [5, 0] }, { id: 'b2', position: [0, 5] }],
      entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 'a', endPointId: 'b', direction: 'cw' },
        { id: 'chord', kind: 'line', construction: false, startPointId: 'b2', endPointId: 'a2' }],
      relations: [{ id: 'join-a', kind: 'coincident', pointIds: ['a', 'a2'] }, { id: 'join-b', kind: 'coincident', pointIds: ['b', 'b2'] }] });
    const compiled = compileCadSketchGraph(graph, {});
    expect(compiled.cycles).toHaveLength(1); expect(compiled.cycles[0].path[0]).toMatchObject({ kind: 'arc', radius: 5, sweep: -270 });
    const twoArcs = compileCadSketchGraph(parseCadSketchGraph({ ...graph, entities: graph.entities.map(entity => entity.kind === 'line'
      ? { id: entity.id, kind: 'arc', construction: false, centerPointId: 'o', startPointId: 'b2', endPointId: 'a2', direction: 'cw' } : entity) }), {});
    expect(twoArcs.cycles).toHaveLength(1); expect(twoArcs.cycles[0].path.map(segment => segment.kind)).toEqual(['arc', 'arc']);
    const centerOnly = compileCadSketchGraph(parseCadSketchGraph({ points: [{ id: 'o', position: [0, 0] }, { id: 'start', position: [0, 0] }, { id: 'end', position: [1, 0] }],
      entities: [{ id: 'circle', kind: 'circle', construction: false, centerPointId: 'o', radius: 5 },
        { id: 'line', kind: 'line', construction: false, startPointId: 'start', endPointId: 'end' }],
      relations: [{ id: 'center', kind: 'coincident', pointIds: ['o', 'start'] }] }), {});
    expect(centerOnly.cycles).toHaveLength(1); expect(centerOnly.openEntityIds).toEqual(['line']);
  });
  it('compiles stable oriented analytic cycles independent of source array order and leaves expressions intact', () => {
    const raw = square(), graph = parseCadSketchGraph(raw), compiled = compileCadSketchGraph(graph, { width: 20 });
    expect(compiled.cycles).toHaveLength(1);
    expect(compiled.cycles[0].sourceRefs).toEqual([
      { entityId: 'ab', reversed: false }, { entityId: 'cb', reversed: true },
      { entityId: 'cd', reversed: false }, { entityId: 'ad', reversed: true }
    ]);
    const path = cadAnalyticSegments(compiled.cycles[0].path);
    expect(signedAreaOfPath(path.refs, path.byId)).toBe(200);
    const reordered = compileCadSketchGraph(parseCadSketchGraph({ ...raw, points: [...raw.points].reverse(), entities: [...raw.entities].reverse() }), { width: 20 });
    expect(reordered.cycles).toEqual(compiled.cycles);
    expect(graph.points[1].position).toEqual(['width', 0]);
    expect(compiled.segments.map(segment => segment.id).sort()).toEqual(['ab', 'ad', 'cb', 'cd']);
  });

  it('retains open and branched components without healing coincident or near-coincident identities into cells', () => {
    const raw = square(); raw.entities.pop();
    const open = compileCadSketchGraph(parseCadSketchGraph(raw), { width: 20 });
    expect(open.cycles).toEqual([]); expect(open.openEntityIds).toEqual(['ab', 'cb', 'cd']);
    const branch = compileCadSketchGraph(parseCadSketchGraph({ ...square(), points: [...square().points, { id: 'tip', position: [-5, 0] }],
      entities: [...square().entities, { id: 'tail', kind: 'line', startPointId: 'a', endPointId: 'tip', construction: false }] }), { width: 20 });
    expect(branch.cycles).toEqual([]); expect(branch.branchedEntityIds).toEqual(['ab', 'ad', 'cb', 'cd', 'tail']);
    const almost = compileCadSketchGraph(parseCadSketchGraph({ ...square(), points: [...square().points, { id: 'near', position: [0, 1e-8] }],
      entities: square().entities.map(item => item.id === 'ad' ? { ...item, startPointId: 'near' } : item) }), { width: 20 });
    expect(almost.cycles).toEqual([]); expect(almost.openEntityIds).toHaveLength(4);
    const mixed = square(); mixed.entities[0].construction = true;
    expect(compileCadSketchGraph(parseCadSketchGraph(mixed), { width: 20 })).toMatchObject({ cycles: [], openEntityIds: ['ab', 'ad', 'cb', 'cd'] });
  });

  it('keeps arc traversal and circle/construction boundaries analytic and rejects unsatisfied graph geometry', () => {
    const graph = parseCadSketchGraph({
      points: [{ id: 'o', position: [0, 0] }, { id: 'a', position: [5, 0] }, { id: 'b', position: [0, 5] }, { id: 'remote', position: [20, 0] }],
      entities: [
        { id: 'arc', kind: 'arc', centerPointId: 'o', startPointId: 'a', endPointId: 'b', direction: 'cw', construction: false },
        { id: 'chord', kind: 'line', startPointId: 'b', endPointId: 'a', construction: false },
        { id: 'reference', kind: 'circle', centerPointId: 'remote', radius: 'radius', construction: true }
      ], relations: []
    });
    const compiled = compileCadSketchGraph(graph, { radius: 2 });
    expect(compiled.cycles).toHaveLength(2);
    expect(compiled.cycles[0].path[0]).toMatchObject({ kind: 'arc', sweep: -270 });
    const reversed = compileCadSketchGraph(parseCadSketchGraph({ ...graph, entities: graph.entities.map(item => item.kind === 'arc'
      ? { ...item, startPointId: 'b', endPointId: 'a', direction: 'ccw' } : item) }), { radius: 2 });
    expect(reversed.cycles[0].sourceRefs[0]).toEqual({ entityId: 'arc', reversed: true });
    expect(reversed.cycles[0].path[0]).toMatchObject({ kind: 'arc', sweep: -270 });
    expect(compiled.cycles[1]).toMatchObject({ construction: true, sourceRefs: [{ entityId: 'reference', reversed: false }], path: [{ kind: 'arc', radius: 2, sweep: 360 }] });
    expect(() => compileCadSketchGraph(graph, { radius: -2 })).toThrow();
  });

  it('withholds self-crossing and overlapping cycle candidates rather than inventing arrangement cells', () => {
    const bow = compileCadSketchGraph(parseCadSketchGraph({ points: [
      { id: 'a', position: [0, 0] }, { id: 'b', position: [10, 10] }, { id: 'c', position: [0, 10] }, { id: 'd', position: [10, 0] }
    ], entities: square().entities, relations: [] }), {});
    expect(bow.cycles).toEqual([]); expect(bow.arrangementEntityIds).toContain('ab');
    const duplicate = compileCadSketchGraph(parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }], entities: [
      { id: 'one', kind: 'circle', centerPointId: 'a', radius: 5, construction: false },
      { id: 'two', kind: 'circle', centerPointId: 'a', radius: 5, construction: false }
    ], relations: [] }), {});
    expect(duplicate.cycles).toEqual([]); expect(duplicate.arrangementEntityIds).toEqual(['one', 'two']);
  });
  it('walks cycles, open chains and branches as plain lookups by joint find them, in every source order and direction, with generated members trusted or checked', () => {
    // The reference: each pass's edges in id order, each joint's edges as a list, components by search, cycles walked from the first edge.
    const reference = (graph: CadSketchGraph) => {
      const joint = resolveCadSketchPointIdentities(graph), cycles: { construction: boolean; sourceRefs: { entityId: string; reversed: boolean }[] }[] = [];
      const open: string[] = [], branched: string[] = [], sorted = [...graph.entities].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const construction of [false, true]) {
        const adjacency = new Map<string, Exclude<CadSketchGraphEntity, { kind: 'circle' }>[]>(), edges: Exclude<CadSketchGraphEntity, { kind: 'circle' }>[] = [];
        for (const entity of sorted) {
          if (entity.construction !== construction) continue;
          if (entity.kind === 'circle') { cycles.push({ construction, sourceRefs: [{ entityId: entity.id, reversed: false }] }); continue; }
          edges.push(entity);
          for (const id of [joint(entity.startPointId), joint(entity.endPointId)]) adjacency.set(id, [...adjacency.get(id) ?? [], entity]);
        }
        const visited = new Set<string>();
        for (const first of edges) {
          if (visited.has(first.id)) continue;
          const component = [first], vertices = new Set<string>();
          visited.add(first.id);
          for (let at = 0; at < component.length; at++) for (const id of [joint(component[at].startPointId), joint(component[at].endPointId)]) {
            vertices.add(id);
            for (const next of adjacency.get(id)!) if (!visited.has(next.id)) { visited.add(next.id); component.push(next); }
          }
          const degrees = [...vertices].map(id => adjacency.get(id)!.length);
          if (degrees.some(degree => degree > 2)) { branched.push(...component.map(edge => edge.id)); continue; }
          if (degrees.some(degree => degree < 2)) { open.push(...component.map(edge => edge.id)); continue; }
          const start = joint(first.startPointId < first.endPointId ? first.startPointId : first.endPointId), sourceRefs: { entityId: string; reversed: boolean }[] = [];
          let current = start, edge = first;
          for (let count = 0; count < component.length; count++) {
            const reversed = joint(edge.startPointId) !== current;
            sourceRefs.push({ entityId: edge.id, reversed });
            current = joint(reversed ? edge.startPointId : edge.endPointId);
            edge = adjacency.get(current)!.find(item => item.id !== edge.id)!;
          }
          cycles.push({ construction, sourceRefs });
        }
      }
      return { cycles, open: open.sort(), branched: branched.sort() };
    };
    const walk = () => {
    let seed = 7, compared = 0, refused = 0, generated = 0, walkedGenerated = 0;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const found = { cycles: 0, open: 0, branched: 0 }, outcomes: string[] = [];
    for (let trial = 0; trial < 600; trial++) {
      const count = 3 + Math.floor(random() * 10), grid = 2 + Math.floor(random() * 5);
      const points = Array.from({ length: count }, (_, at) => ({ id: `p${String(at).padStart(2, '0')}`, position: [Math.floor(random() * grid) * 10, Math.floor(random() * grid) * 10] }));
      const entities: Record<string, unknown>[] = [], line = (id: string, a: number, b: number, construction: boolean) => {
        if (a !== b && !entities.some(entity => entity.id === id)) entities.push({ id, kind: 'line', construction, startPointId: points[a].id, endPointId: points[b].id });
      };
      // Loops through points in a random order with edges in random directions, sometimes a second one as construction, and stray edges.
      if (random() < 0.6) for (let loop = 0; loop < (random() < 0.3 ? 2 : 1); loop++) {
        const order = points.map((_, at) => at).sort(() => random() - 0.5).slice(0, 2 + Math.floor(random() * Math.min(6, count - 2)));
        order.forEach((a, at) => { const b = order[(at + 1) % order.length], id = `L${loop}_${String(Math.floor(random() * 1000)).padStart(3, '0')}`;
          if (random() < 0.5) line(id, a, b, loop === 1 && random() < 0.5); else line(id, b, a, false); });
      }
      for (let at = random() < 0.6 ? 0 : 1 + Math.floor(random() * 8); at > 0; at--) line(`e${Math.floor(random() * 1000)}`, Math.floor(random() * count), Math.floor(random() * count), random() < 0.2);
      if (random() < 0.3) entities.push({ id: `c${trial}`, kind: 'circle', construction: false, centerPointId: points[0].id, radius: 3 });
      const relations: Record<string, unknown>[] = [];
      for (let at = 0; at < count; at++) for (let other = at + 1; other < count; other++)
        if (points[at].position.every((value, axis) => value === points[other].position[axis]) && random() < 0.6) relations.push({ id: `k${at}_${other}`, kind: 'coincident', pointIds: [points[at].id, points[other].id] });
      // A generated rectangle on the grid in some trials, drawn from a stream of its own so the other trials stay as they were, sometimes
      // sharing its first corner with a point.
      let mark = trial * 7919 + 1;
      const pick = () => { mark = (mark * 1103515245 + 12345) & 0x7fffffff; return mark / 0x7fffffff; };
      if (pick() < 0.35) {
        const x = Math.floor(pick() * grid) * 10, y = Math.floor(pick() * grid) * 10, round = pick() < 0.5;
        relations.push({ id: 'gen', kind: 'generator', idPrefix: 'gen', construction: pick() < 0.2,
          geometry: { kind: 'rectangle', x, y, width: 10 + Math.floor(pick() * 2) * 10, height: 10, cornerRadius: round ? 2 : 0 } });
        const corner = points.findIndex(point => point.position[0] === x && point.position[1] === y);
        if (!round && corner >= 0 && pick() < 0.7) relations.push({ id: 'tie', kind: 'coincident', pointIds: ['gen_p0', points[corner].id] });
        generated += 1;
      }
      let graph: CadSketchGraph, compiled: ReturnType<typeof compileCadSketchGraph>;
      try { graph = expandCadSketchGenerators({ points, entities, relations }, {}); } catch (error) { outcomes.push(`parse ${(error as CadError).code}`); continue; }
      try { compiled = compileCadSketchGraph(graph, {}); } catch (error) {
        // Only an edge too short to join, or geometry the check refuses, stops the walk: a cycle it starts always closes.
        expect(error).toBeInstanceOf(CadError); expect((error as CadError).code).toMatch(/^(sketch-graph-precision|invalid-sketch-graph-geometry)$/);
        outcomes.push(`compile ${(error as CadError).code}`); refused += 1; continue;
      }
      const expected = reference(graph), arrangement = new Set(compiled.arrangementEntityIds);
      expect({ cycles: compiled.cycles.map(cycle => ({ construction: cycle.construction, sourceRefs: cycle.sourceRefs })), open: compiled.openEntityIds, branched: compiled.branchedEntityIds })
        .toEqual({ ...expected, cycles: expected.cycles.filter(cycle => cycle.sourceRefs.every(ref => !arrangement.has(ref.entityId)))
          .sort((a, b) => a.sourceRefs[0].entityId < b.sourceRefs[0].entityId ? -1 : 1) });
      outcomes.push(`walk ${JSON.stringify([compiled.cycles.map(cycle => cycle.sourceRefs), compiled.openEntityIds, compiled.branchedEntityIds, compiled.arrangementEntityIds])}`);
      if (graph.relations.some(relation => relation.kind === 'generator')) walkedGenerated += 1;
      compared += 1; found.cycles += compiled.cycles.length; found.open += compiled.openEntityIds.length; found.branched += compiled.branchedEntityIds.length;
    }
    expect(compared).toBeGreaterThan(300); expect(refused).toBeGreaterThan(20); expect(generated).toBeGreaterThan(150); expect(walkedGenerated).toBeGreaterThan(100);
    expect(found.cycles).toBeGreaterThan(50); expect(found.open).toBeGreaterThan(100); expect(found.branched).toBeGreaterThan(100);
    return outcomes;
    };
    // In production a generator's members are trusted, and under development checks every item is checked: each trial is refused,
    // compiled and walked alike either way.
    const outcomes = [false, true].map(checks => { setCadDevelopmentChecks(checks); try { return walk(); } finally { setCadDevelopmentChecks(true); } });
    expect(outcomes[0]).toEqual(outcomes[1]);
  });
});
