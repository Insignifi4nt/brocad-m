import { expect, test } from './fixtures/native-sketch-solver';
import { prepareCadTools, callCadTool as call, cadContext as context, historyRow, openRelationsList, relationOffer, relationRow } from './cad-tool-helpers';

test('slides a bore on an angled guide, locates it and follows guide edits through private Finish, history, agent parity and save',async({page})=>{
  await prepareCadTools(page);await call(page,'cad_open_workspace');
  const sketch={id:'plate',kind:'sketch',name:'Guided bore plate',suppressed:false,plane:'XY',offset:0,profiles:[],graph:{
    points:[{id:'a',position:[' 0.00 ','0']},{id:'b',position:['70','0']},{id:'c',position:['70','30']},{id:'d',position:['0','30']},
      {id:'guide-a',position:['0.000','0']},{id:'guide-b',position:['60.00',' guideHeight ']},{id:'center',position:[20,14]}],
    entities:[{id:'ab',kind:'line',startPointId:'a',endPointId:'b',construction:false},{id:'bc',kind:'line',startPointId:'b',endPointId:'c',construction:false},
      {id:'cd',kind:'line',startPointId:'c',endPointId:'d',construction:false},{id:'da',kind:'line',startPointId:'d',endPointId:'a',construction:false},
      {id:'guide',kind:'line',startPointId:'guide-a',endPointId:'guide-b',construction:true},{id:'bore',kind:'circle',centerPointId:'center',radius:' 3.00 ',construction:false}],relations:[]}};
  await call(page,'cad_edit_document',{expectedVersion:(await context(page)).version,edits:[{kind:'set-parameter',name:'guideHeight',value:30},{kind:'add-feature',feature:sketch},
    {kind:'add-feature',feature:{id:'pad',kind:'extrude',name:'Thickness',suppressed:false,sketchId:'plate',distance:' 5e0 ',symmetric:false,operation:'new',targetId:null}}]});
  const base=await context(page),read=(version:string)=>call(page,'cad_get_feature',{expectedVersion:version,featureId:'plate'}).then(r=>r.feature);
  const edit=async()=>{await (await historyRow(page, 'Guided bore plate')).dblclick();await expect(page.getByRole('button',{name:'Cancel sketch edits',exact:true})).toBeVisible();};
  const apply=async()=>{await page.getByRole('button',{name:'Apply',exact:true}).click();await expect(page.getByRole('button',{name:'Apply',exact:true})).toHaveCount(0);};
  const pick=async(kind:'point'|'entity',id:string,add=false)=>page.locator(`[data-cad-sketch-${kind}="${id}"]`).press(add?'Shift+Enter':'Enter');
  // The icon row applies Point on line to the private draft at once, and removes it when pressed again; the part waits for Finish.
  const onLine=relationOffer(page,'Point on line');
  await edit();await pick('point','center');await pick('entity','guide',true);await onLine.click();await expect(onLine).toHaveAttribute('aria-pressed','true');
  await onLine.click();await expect(onLine).toHaveAttribute('aria-pressed','false');expect(await read(base.version)).toEqual(sketch);
  await onLine.click();await expect(onLine).toHaveAttribute('aria-pressed','true');
  // Dragging a member of a multi-selection moves the whole set, so drag the bore center on its own.
  await pick('point','center');
  const marker=page.locator('[data-cad-sketch-point="center"] .cad-sketch-point-mark'),box=await marker.boundingBox();if(!box)throw Error('Missing bore grip');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+80,box.y+box.height/2-60,{steps:5});await page.mouse.up();
  const position=()=>marker.evaluate(el=>{const origin=el.closest('svg')?.querySelector('[data-cad-sketch-point="guide-a"] .cad-sketch-point-mark');if(!origin)throw Error('Missing guide origin');return ['cx','cy'].map(axis=>Number(el.getAttribute(axis))-Number(origin.getAttribute(axis)));});
  await expect.poll(async()=>{const p=await position();return Math.abs(p[1]-p[0]/2);}).toBeLessThan(1e-9);
  const moved=await position();expect(moved[0]).toBeGreaterThan(25);
  // The center's distance from the V axis comes from the Dimension tool on the point and the axis, then its value is typed at the dimension.
  // The released drag shows its position at once but locks the canvas until the draft takes its edit; the V axis is a button again then.
  const canvas=page.getByLabel('Sketch drawing canvas'),vAxis=page.getByRole('button',{name:'Select the V axis',exact:true});await expect(vAxis).toBeVisible();
  await pick('point','center');await vAxis.press('Shift+Enter');await expect(vAxis).toHaveAttribute('aria-pressed','true');await relationOffer(page,'Dimension the selection').click();
  await expect(canvas).toHaveAccessibleDescription(/Click or press Enter to place/);await canvas.press('Enter');
  await openRelationsList(page);const distance=relationRow(page,'Distance relation 2');await expect(distance).toHaveCount(1);await canvas.press('Escape');
  await distance.dblclick();await page.getByRole('textbox',{name:'Distance mm',exact:true}).fill('30');await apply();
  await pick('point','guide-b');await page.getByRole('textbox',{name:'Y mm',exact:true}).fill('24');await apply();expect(await read(base.version)).toEqual(sketch);
  await page.getByRole('button',{name:'Finish sketch',exact:true}).click();await expect(page.getByRole('button',{name:'Finish sketch',exact:true})).toHaveCount(0);
  let current=await context(page);const human=await read(current.version),finalPoints=[...sketch.graph.points.slice(0,6),{id:'center',position:[expect.closeTo(30,10),expect.closeTo(12,10)]}];expect(human.graph.points).toEqual(finalPoints);
  expect(human.graph.entities).toEqual(sketch.graph.entities);expect(human.graph.relations).toEqual([{id:expect.any(String),kind:'point-on-line',pointId:'center',lineId:'guide'},
    {id:expect.any(String),kind:'fixed-axis',pointId:'center',axis:'x',value:30}]);expect(current.parameters).toEqual({guideHeight:24});
  let built=await call(page,'cad_build',{expectedVersion:current.version});expect(built.diagnostics).toEqual([]);expect(built.bodies[0]).toMatchObject({solidCount:1,boundsMm:{min:[0,0,0],max:[70,30,5]}});expect(built.bodies[0].volumeMm3).toBeCloseTo(10500-45*Math.PI,6);
  expect(await call(page,'cad_inspect_sketch_constraints',{expectedVersion:current.version,sketchId:'plate',section:'relations'})).toMatchObject({analysis:{degreesOfFreedom:0}});
  await edit();await pick('entity','guide');await pick('point','center',true);await expect(onLine).toHaveAttribute('aria-pressed','true');
  await onLine.click();await expect(onLine).toHaveAttribute('aria-pressed','false');await page.getByRole('button',{name:'Cancel sketch edits',exact:true}).click();await expect(page.getByRole('button',{name:'Cancel sketch edits',exact:true})).toHaveCount(0);expect(await read(current.version)).toEqual(human);
  await call(page,'cad_history',{expectedVersion:current.version,direction:'undo'});current=await context(page);expect(await read(current.version)).toEqual(sketch);expect(current.parameters).toEqual({guideHeight:30});
  await call(page,'cad_history',{expectedVersion:current.version,direction:'redo'});current=await context(page);expect(await read(current.version)).toEqual(human);
  await call(page,'cad_history',{expectedVersion:current.version,direction:'undo'});current=await context(page);
  await call(page,'cad_edit_document',{expectedVersion:current.version,edits:[{kind:'set-parameter',name:'guideHeight',value:24},...human.graph.relations.map((relation:unknown)=>({kind:'set-sketch-relation',sketchId:'plate',relation}))]});current=await context(page);const agent=await read(current.version);expect(agent).toEqual({...human,graph:{...human.graph,points:finalPoints}});
  built=await call(page,'cad_build',{expectedVersion:current.version});expect(built.diagnostics).toEqual([]);expect(built.bodies[0].volumeMm3).toBeCloseTo(10500-45*Math.PI,6);
  await call(page,'cad_save_document',{expectedVersion:current.version});await page.reload();await expect(page.getByRole('main',{name:'Parametric CAD workbench'})).toBeVisible();current=await context(page);expect(current.dirty).toBe(false);expect(await read(current.version)).toEqual(agent);
});
