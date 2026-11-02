import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph } from '../cadSketchGraph';
import { measureCadSketchReferenceDimension, cadSketchReferenceDimensionToDriving } from '../cadSketchReferenceDimensions';
import { splitCadSketchEntity } from '../cadSketchSplit';
import { prepareCadSketchTrim, trimCadSketchEntity } from '../cadSketchTrimExtend';
import { deleteCadSketchElements } from '../cadSketchGraphEdits';
import { cadSketchRelationEntityIds, cadSketchRelationPointIds, mapCadSketchRelationScalars } from '../cadSketchGraphReferences';

const source = () => parseCadSketchGraph({ points: [{id:'a',position:[' 0.00 ',0]},{id:'b',position:[' span ',10]},{id:'o',position:[40,0]},{id:'same',position:[0,0]}],
  entities:[{id:'edge',kind:'line',startPointId:'a',endPointId:'b',construction:true},{id:'circle',kind:'circle',centerPointId:'o',radius:' bore / 2 ',construction:false}],
  relations:[{id:'diagonal',kind:'reference-dimension',measurement:{kind:'line-length',entityId:'edge'}},
    {id:'separation',kind:'reference-dimension',measurement:{kind:'point-distance',pointIds:['b','a']}},
    {id:'diameter',kind:'reference-dimension',measurement:{kind:'radial-size',entityId:'circle',quantity:'diameter'}},
    {id:'zero',kind:'reference-dimension',measurement:{kind:'point-distance',pointIds:['a','same']}}] });

describe('saved sketch reference dimensions', () => {
  it('persists only intent, follows actual geometry and retains dependency identities without visiting any driver scalar', () => {
    const graph=source(), exact=JSON.stringify(graph), refs=graph.relations.filter(r=>r.kind==='reference-dimension');
    expect(refs).toHaveLength(4);
    expect(refs.map(r=>measureCadSketchReferenceDimension(graph,{span:10,bore:6},r))).toEqual([Math.sqrt(200),Math.sqrt(200),6,0]);
    expect(refs.map(r=>measureCadSketchReferenceDimension(graph,{span:20,bore:8},r))).toEqual([Math.sqrt(500),Math.sqrt(500),8,0]);
    expect(cadSketchRelationEntityIds(refs[0])).toEqual(['edge']);expect(cadSketchRelationPointIds(graph,refs[0])).toEqual(['a','b']);
    expect(cadSketchRelationPointIds(graph,refs[1])).toEqual(['b','a']);
    expect(cadSketchRelationEntityIds(refs[2])).toEqual(['circle']);
    refs.forEach(r=>expect(mapCadSketchRelationScalars(r,()=>{throw Error('Reference has no driver scalar');})).toBe(r));
    expect(JSON.stringify(graph)).toBe(exact);
    expect(()=>parseCadSketchGraph({...graph,relations:[{...refs[0],value:15}]})).toThrow();
    expect(()=>parseCadSketchGraph({...graph,relations:[{...refs[0],measurement:{kind:'line-length',entityId:'circle'}}]})).toThrow();
    expect(()=>parseCadSketchGraph({...graph,relations:[{...refs[1],measurement:{kind:'point-distance',pointIds:['a','missing']}}]})).toThrow();
  });
  it('deliberately converts the same annotation identity to an ordinary unrounded driver without changing source', () => {
    const graph=source(), exact=JSON.stringify(graph), refs=graph.relations.filter(r=>r.kind==='reference-dimension');
    expect(cadSketchReferenceDimensionToDriving(graph,{span:10,bore:6},refs[0])).toEqual({id:'diagonal',kind:'distance',pointIds:['a','b'],value:Math.sqrt(200)});
    expect(cadSketchReferenceDimensionToDriving(graph,{span:10,bore:6},refs[1],' diagonalSize ')).toEqual({id:'separation',kind:'distance',pointIds:['b','a'],value:' diagonalSize '});
    expect(cadSketchReferenceDimensionToDriving(graph,{span:10,bore:6},refs[2],' bore ')).toEqual({id:'diameter',kind:'radial-size',entityId:'circle',quantity:'diameter',value:' bore '});
    expect(JSON.stringify(graph)).toBe(exact);
  });
});


describe('reference dimension dependencies during edge edits', () => {
  const line = () => parseCadSketchGraph({ points: [{ id:'a',position:[0,0] },{ id:'b',position:[20,0] },{ id:'c',position:[5,-5] },{ id:'d',position:[5,5] }],
    entities: [{ id:'edge',kind:'line',startPointId:'a',endPointId:'b',construction:false },{ id:'fence',kind:'line',startPointId:'c',endPointId:'d',construction:true }],
    relations: [{ id:'length',kind:'reference-dimension',measurement:{kind:'line-length',entityId:'edge'} },
      { id:'span',kind:'reference-dimension',measurement:{kind:'point-distance',pointIds:['b','a']} }] });
  const values = (graph: ReturnType<typeof parseCadSketchGraph>) => graph.relations.filter(r=>r.kind==='reference-dimension').map(r=>measureCadSketchReferenceDimension(graph,{},r));
  it('blocks a whole-line length when Split or end Trim changes the line, and removes a point distance to a detached end', () => {
    const graph=line(), before=JSON.stringify(graph);
    // A length of the whole line would measure another span on a piece, so it is never kept with that new meaning.
    const request={kind:'line',entityId:'edge',parameter:.25,splitPointId:'cut',newEntityId:'piece',supportRelationId:'support'} as const;
    expect(()=>splitCadSketchEntity({graph,parameters:{},split:request})).toThrowError(expect.objectContaining({code:'dependent-sketch-split',relationIds:['length']}));
    const spanOnly=parseCadSketchGraph({...graph,relations:[graph.relations[1]]});
    const split=splitCadSketchEntity({graph:spanOnly,parameters:{},split:request});
    expect(values(split.graph)).toEqual([20]);expect(split.graph.relations.slice(0,1)).toEqual(spanOnly.relations);
    const prepared=prepareCadSketchTrim({graph,parameters:{},entityId:'edge',parameter:.1});
    if(prepared.target.kind!=='end')throw Error('Expected end trim');
    expect(prepared.target.removedRelationIds).toEqual(['length','span']);
    const end=prepared.target;
    expect(()=>trimCadSketchEntity({graph,parameters:{},trim:{...end,removedRelationIds:['span'],cutPointId:'cut'}}))
      .toThrowError(expect.objectContaining({code:'unconfirmed-sketch-trim-removals'}));
    const trimmed=trimCadSketchEntity({graph,parameters:{},trim:{...prepared.target,cutPointId:'cut'}});
    expect(trimmed.graph.relations).toEqual([]);
    expect(trimmed.graph.points.slice(0,3)).toEqual(graph.points.slice(1));expect(JSON.stringify(graph)).toBe(before);
    const pointOnly=parseCadSketchGraph({...graph,entities:[graph.entities[0]],relations:[graph.relations[1]]});
    const deletion=prepareCadSketchTrim({graph:pointOnly,parameters:{},entityId:'edge',parameter:.5});
    if(deletion.target.kind!=='delete')throw Error('Expected no-hit edge deletion');
    expect(deletion.target.removedRelationIds).toEqual(['span']);
    const deleted=trimCadSketchEntity({graph:pointOnly,parameters:{},trim:deletion.target});
    expect(deleted.graph.entities).toEqual([]);expect(deleted.graph.points).toEqual(pointOnly.points.slice(2));
    expect(deleted.graph.relations).toEqual([]);
    const shared=parseCadSketchGraph({...pointOnly,entities:[...pointOnly.entities,{id:'other',kind:'line',startPointId:'a',endPointId:'c',construction:true}],
      relations:[{id:'other-size',kind:'reference-dimension',measurement:{kind:'line-length',entityId:'other'}}]});
    expect(prepareCadSketchTrim({graph:shared,parameters:{},entityId:'edge',parameter:.5}).target.kind).toBe('delete');
  });
  it('retains a passive diameter when free circle Trim keeps its identity as an arc, and removes it with the deleted circle', () => {
    const graph=parseCadSketchGraph({points:[{id:'o',position:[0,0]},{id:'a',position:[-8,6]},{id:'b',position:[8,6]}],
      entities:[{id:'rim',kind:'circle',centerPointId:'o',radius:10,construction:false},{id:'chord',kind:'line',startPointId:'a',endPointId:'b',construction:false}],
      relations:[{id:'diameter',kind:'reference-dimension',measurement:{kind:'radial-size',entityId:'rim',quantity:'diameter'}}]});
    const preview=prepareCadSketchTrim({graph,parameters:{},entityId:'rim',parameter:.25});
    if(preview.target.kind!=='circle')throw Error('Expected circle trim');
    const trimmed=trimCadSketchEntity({graph,parameters:{},trim:{...preview.target,cutPointIds:['b','a']}});
    expect(values(trimmed.graph)).toEqual([20]);expect(trimmed.graph.relations).toEqual(graph.relations);
    const isolated=parseCadSketchGraph({...graph,entities:[graph.entities[0]]});
    expect(prepareCadSketchTrim({graph:isolated,parameters:{},entityId:'rim',parameter:0}).target).toEqual({kind:'delete',entityId:'rim',parameter:0,removedRelationIds:['diameter']});
    const sketch={id:'sketch',kind:'sketch' as const,name:'Sketch',suppressed:false,plane:'XY' as const,offset:0,profiles:[],graph};
    const request={sketch,pointIds:[],entityIds:['rim'],relationIds:[],cascade:false};
    expect(()=>deleteCadSketchElements(request)).toThrowError(expect.objectContaining({code:'dependent-sketch-element'}));
    expect(deleteCadSketchElements({...request,cascade:true}).graph?.relations).toEqual([]);
    expect(values(graph)).toEqual([20]);
  });
});
