import type { CadDocument } from './cadDocument';
import { storedCadSketchGraph } from './sketch-generators/cadSketchGenerators';

// The form a document is saved, exported, compared and kept in history in: each sketch generator's record without the members a parse
// generates from it again. Two documents that differ only by a regeneration have the same stored form, so it never marks a draft dirty.
const storedDocuments = new WeakMap<CadDocument, CadDocument>();
const storedTexts = new WeakMap<CadDocument, string>();

/** `document` as it is stored: sketch generators without their members. The document itself when it has none. */
export function storedCadDocument(document: CadDocument): CadDocument {
  const kept = storedDocuments.get(document);
  if (kept) return kept;
  let changed = false;
  const features = document.features.map(feature => {
    if (feature.kind !== 'sketch' || !feature.graph) return feature;
    const graph = storedCadSketchGraph(feature.graph);
    if (graph === feature.graph) return feature;
    changed = true;
    return { ...feature, graph };
  });
  const stored = changed ? Object.freeze({ ...document, features: Object.freeze(features) }) : document;
  // Only a frozen document cannot change under its stored form.
  if (Object.isFrozen(document)) storedDocuments.set(document, stored);
  return stored;
}

/** The JSON text of `document`'s stored form, which saves, exports and draft comparisons use. */
export function storedCadDocumentText(document: CadDocument): string {
  const kept = storedTexts.get(document);
  if (kept !== undefined) return kept;
  const text = JSON.stringify(storedCadDocument(document));
  if (Object.isFrozen(document)) storedTexts.set(document, text);
  return text;
}
