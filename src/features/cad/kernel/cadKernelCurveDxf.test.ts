// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { importCadDxfCurve } from '../../../domain/cad/cadCurveDxf';
import { createCadDocument } from '../../../domain/cad/cadSchema';
import { createCadKernelClient, type CadWorkerTransport } from './cadKernelClient';
import { createCadKernelRuntime } from './cadKernelRuntime';
import { isCadKernelReply, type CadKernelRequest } from './cadKernelProtocol';

const input={fileName:'rail.dxf',curveId:'rail',name:'Ordered rail',text:[
  '0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC','0','SECTION','2','ENTITIES',
  '0','LWPOLYLINE','90','3','70','0','10','0','20','0','42','0','10','10','20','0','42',String(Math.tan(Math.PI/8)),'10','15','20','5','0','ENDSEC','0','EOF',''
].join('\n')};
class Transport implements CadWorkerTransport {
  onmessage: CadWorkerTransport['onmessage']=null; onerror: CadWorkerTransport['onerror']=null; onmessageerror: CadWorkerTransport['onmessageerror']=null;
  messages: CadKernelRequest[]=[]; terminated=false;
  postMessage(message:CadKernelRequest){this.messages.push(message);} terminate(){this.terminated=true;}
  reply(data:unknown){this.onmessage?.(new MessageEvent('message',{data}));}
}

describe('Curve DXF worker and client boundaries',()=>{
  it('imports and builds reference-only documents without loading the native kernel',async()=>{
    let initialized=0; const runtime=createCadKernelRuntime(async()=>{++initialized;throw new Error('Must not initialize');});
    try {
      const reply=await runtime.evaluate({id:1,kind:'import-dxf-curve',input}); expect(isCadKernelReply(reply)).toBe(true);
      if(reply.kind!=='dxf-curve-imported') throw new Error('Expected Curve');
      expect(reply.result).toMatchObject({sourceEntityCount:1,scaleToMillimeters:1,curve:{id:'rail',name:'Ordered rail',source:{text:input.text}}});
      const document={...createCadDocument('Curve only'),features:[reply.result.curve]};
      const build=await runtime.evaluate({id:2,kind:'build',document}); expect(build).toMatchObject({kind:'built',result:{meshes:[],diagnostics:[]}});
      expect(await runtime.evaluate({id:3,kind:'export',document,format:'step'})).toMatchObject({kind:'error',code:'empty-export'});
      expect(await runtime.evaluate({id:4,kind:'import-dxf-curve',input:{...input,units:'inch'}})).toMatchObject({kind:'error',code:'dxf-units-conflict'});
      expect(await runtime.evaluate({id:5,kind:'import-dxf-curve',input:{...input,extra:true}})).toMatchObject({kind:'error'});
      expect(initialized).toBe(0);
    } finally {runtime.dispose();}
  });
  it('copies submitted input and accepts only the exact requested original, ID and name',async()=>{
    const transport=new Transport(); const client=createCadKernelClient(()=>transport);
    try {
      const changed={...input}; const pending=client.importDxfCurve(changed); changed.text='edited after submission'; changed.name='changed';
      expect(transport.messages[0]).toMatchObject({kind:'import-dxf-curve',input});
      transport.reply({id:1,kind:'dxf-curve-imported',result:importCadDxfCurve(input)});
      expect((await pending).curve.source?.text).toBe(input.text);
      const mismatch=client.importDxfCurve(input); const rejected=expect(mismatch).rejects.toThrow('does not match');
      transport.reply({id:2,kind:'dxf-curve-imported',result:importCadDxfCurve({...input,curveId:'wrong_id'})});
      await rejected; expect(transport.terminated).toBe(true);
    } finally {client.dispose();}
  });
  it.each(['fileName','text','units','name'] as const)('rejects a valid detached reply with different %s',async(field)=>{
    const transport=new Transport(); const client=createCadKernelClient(()=>transport);
    const changes=field==='fileName'?{fileName:'other.dxf'}:field==='text'?{text:input.text.replace('Ordered','Other')+'\n'}:field==='name'?{name:'Other'}:{units:'mm' as const};
    try {
      const pending=client.importDxfCurve(input); const rejected=expect(pending).rejects.toThrow('does not match');
      transport.reply({id:1,kind:'dxf-curve-imported',result:importCadDxfCurve({...input,...changes})}); await rejected;
      expect(transport.terminated).toBe(true);
    } finally {client.dispose();}
  });
  it('cancels active work, restarts the queue and ignores late replies from either generation',async()=>{
    const transports:Transport[]=[]; const client=createCadKernelClient(()=>{const transport=new Transport();transports.push(transport);return transport;});
    try {
      const abort=new AbortController(); const first=client.importDxfCurve(input,abort.signal); const rejected=expect(first).rejects.toMatchObject({name:'AbortError'});
      const queued=client.importDxfCurve(input); abort.abort(); await rejected;
      expect(transports[0].terminated).toBe(true); expect(transports).toHaveLength(2);
      const result=importCadDxfCurve(input); transports[0].reply({id:1,kind:'dxf-curve-imported',result});
      transports[1].reply({id:1,kind:'dxf-curve-imported',result}); transports[1].reply({id:2,kind:'dxf-curve-imported',result});
      expect((await queued).curve.id).toBe('rail');
      const aborted=new AbortController();aborted.abort(); await expect(client.importDxfCurve(input,aborted.signal)).rejects.toMatchObject({name:'AbortError'});
    } finally {client.dispose();}
  });
  it('rejects malformed or inherited geometry before accepting a response',async()=>{
    const transport=new Transport(); const client=createCadKernelClient(()=>transport);
    try {
      const pending=client.importDxfCurve(input);const rejected=expect(pending).rejects.toMatchObject({code:'kernel-unavailable',kernelMessage:'The reply does not follow the kernel protocol.'});
      const result=importCadDxfCurve(input); transport.reply({id:1,kind:'dxf-curve-imported',result:{...result,curve:Object.create(result.curve)}});
      await rejected;expect(transport.terminated).toBe(true);
    } finally {client.dispose();}
  });
});
