import { getOC, type Shape3D } from 'replicad';
import { CadError } from '../../../domain/cad/cadError';
import { cadKernelDisposeOwned } from './cadKernelShapes';

/** Replicad's named STEP assembly semantics with explicit native ownership.
 * Shapes are borrowed; labels, tools, document, session and writers are scoped
 * until Perform completes rather than awaiting vendor JS finalizers. */
export function exportCadKernelStep(shapes: readonly { readonly shape: Shape3D; readonly name: string }[]): Blob {
  const oc = getOC(), owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(value: T): T => { owned.push(value); return value; };
  const text = (value: string) => own(new oc.TCollection_ExtendedString(value, true));
  // Worker native operations are serialized. Preserve the existing STEP header
  // filename and release only the scratch file this invocation produces.
  const filename = 'export.step', path = '/export.step';
  let attemptedWrite = false, failed = false;
  try {
    const document = own(new oc.TDocStd_Document(text('XmlOcaf')));
    oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
    const main = own(document.Main());
    const tool = own(oc.XCAFDoc_DocumentTool.ShapeTool(main)), colors = own(oc.XCAFDoc_DocumentTool.ColorTool(main));
    for (const { shape, name } of shapes) {
      const node = own(tool.NewShape());
      tool.SetShape(node, shape.wrapped);
      own(oc.TDataStd_Name.Set(node, text(name)));
      colors.SetColor(node, own(new oc.Quantity_ColorRGBA(1, 0, 0, 1)), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
    }
    tool.UpdateAssemblies();
    own(new oc.STEPCAFControl_Writer());
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    const session = own(new oc.XSControl_WorkSession()), writer = own(new oc.STEPCAFControl_Writer(session, false));
    writer.SetColorMode(true); writer.SetLayerMode(true); writer.SetNameMode(true);
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1);
    oc.Interface_Static.SetIVal('write.precision.mode', 0);
    oc.Interface_Static.SetIVal('write.step.assembly', 2);
    oc.Interface_Static.SetIVal('write.step.schema', 5);
    const progress = own(new oc.Message_ProgressRange());
    attemptedWrite = true;
    if (!writer.Perform(document, filename, progress)) throw new CadError('step-export', 'The bodies could not be written as a STEP file. A body may hold geometry the STEP writer cannot store; rebuild the part and export again, or export STL instead.');
    const file = oc.FS.readFile(path);
    // FS.readFile owns its allocated bytes; Blob snapshots the exact view. Copy
    // shared/native memory if an alternative FS supplies borrowed storage.
    const bytes = file.buffer instanceof ArrayBuffer && file.buffer !== oc.wasmMemory.buffer
      ? new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
      : Uint8Array.from(file);
    return new Blob([bytes], { type: 'application/STEP' });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { if (attemptedWrite) oc.FS.unlink(path); } catch (error) { cleanupError = error; }
    for (const value of owned.reverse()) {
      try { cadKernelDisposeOwned(value); } catch (error) { cleanupError ??= error; }
    }
    // Finish releasing every resource and retain the actual export failure.
    // oxlint-disable-next-line no-unsafe-finally -- cleanup failures surface only after a successful export.
    if (!failed && cleanupError !== undefined) throw cleanupError;
  }
}
