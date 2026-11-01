import { commitWorkbenchFileTransaction, WorkbenchFileConflictError } from '@/domain/storage/workbenchFileTransaction';
import { withWorkbenchMutationLock } from '@/domain/storage/workbenchMutationLock';
import type { WorkbenchStorageAdapter } from '@/domain/storage/workbenchStorageAdapter';
import { projectNameError } from '@/domain/workbench-catalog/projectName';
import type { CadDocument } from './cadDocument';
import { parseCadDocument } from './cadSchema';
import { storedCadDocument } from './cadStoredDocument';

const prefix = 'cad/documents/';
export interface SavedCadDocument {
  readonly document: CadDocument;
  readonly savedVersion: string;
  readonly updatedAt: string;
}
export interface CadLibraryEntry {
  readonly id: string; readonly name: string; readonly savedVersion: string;
  readonly updatedAt: string; readonly featureCount: number;
}
export interface ArchivedCadLibraryEntry extends CadLibraryEntry {
  readonly archivePath: string;
  readonly archivedAt: string;
}
type SavedCadChangeOptions = { expectedSavedVersion: string; signal?: AbortSignal };
export class CadStorageError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function cadDocumentPath(id: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) {
    throw new CadStorageError('INVALID_ID', 'CAD document identity is not a portable file name.');
  }
  return `${prefix}${id}.cad.json`;
}

async function fingerprint(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function readRaw(adapter: WorkbenchStorageAdapter, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const raw = await (adapter.readExactText?.(path, signal) ?? adapter.readText(path));
  signal?.throwIfAborted();
  return raw;
}
async function parseSaved(raw: string, id: string): Promise<SavedCadDocument> {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'wireedm-cad-save' ||
      !('schemaVersion' in value) || value.schemaVersion !== 1 || !('document' in value) ||
      !('updatedAt' in value) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      Object.keys(value).sort().join(',') !== 'document,format,schemaVersion,updatedAt') {
    throw new CadStorageError('INVALID_SAVED_DOCUMENT', 'Unsupported CAD save. Preserve the original; no data was changed.');
  }
  const document = parseCadDocument(value.document);
  if (document.id !== id) throw new CadStorageError('IDENTITY_MISMATCH', 'CAD document identity differs from its file name.');
  return { document, updatedAt: value.updatedAt, savedVersion: await fingerprint(raw) };
}

export async function loadCadDocument(adapter: WorkbenchStorageAdapter, id: string, signal?: AbortSignal): Promise<SavedCadDocument> {
  return withWorkbenchMutationLock(adapter, async () => {
    const raw = await readRaw(adapter, cadDocumentPath(id), signal);
    if (raw === null) throw new CadStorageError('NOT_FOUND', 'The CAD document no longer exists in this workbench.');
    const saved = await parseSaved(raw, id);
    signal?.throwIfAborted();
    return saved;
  });
}

export async function renameCadDocument(adapter: WorkbenchStorageAdapter, id: string, name: string, options: SavedCadChangeOptions) {
  const error = projectNameError(name);
  if (error) throw new CadStorageError('INVALID_NAME', error);
  const saved = await loadCadDocument(adapter, id, options.signal);
  requireSavedVersion(saved, options.expectedSavedVersion);
  return saveCadDocument(adapter, { ...saved.document, name: name.trim() }, options);
}

function requireSavedVersion(saved: SavedCadDocument, expectedSavedVersion: string) {
  if (saved.savedVersion !== expectedSavedVersion) {
    throw new CadStorageError('SAVED_DOCUMENT_CHANGED', 'This CAD project changed in storage. Refresh the project library before trying again.');
  }
}

function archiveIdentity(path: string) {
  const match = /^cad\/trash\/([a-z0-9][a-z0-9_-]{0,95})\/(\d{13})-([a-f0-9]{64})\.cad\.json$/.exec(path);
  if (!match) throw new CadStorageError('INVALID_ARCHIVE', 'Unsupported CAD archive path. Preserve the original.');
  cadDocumentPath(match[1]);
  return { id: match[1], archivedAt: new Date(Number(match[2])).toISOString(), savedVersion: match[3] };
}

function libraryEntry(saved: SavedCadDocument): CadLibraryEntry {
  return { id: saved.document.id, name: saved.document.name, savedVersion: saved.savedVersion,
    updatedAt: saved.updatedAt, featureCount: saved.document.features.length };
}

/** Exact original moves through the same recoverable transaction used by saves. No catalog rewrite. */
export async function archiveCadDocument(adapter: WorkbenchStorageAdapter, id: string, options: SavedCadChangeOptions): Promise<ArchivedCadLibraryEntry> {
  return withWorkbenchMutationLock(adapter, async () => {
    const path = cadDocumentPath(id);
    const raw = await readRaw(adapter, path, options.signal);
    if (raw === null) throw new CadStorageError('NOT_FOUND', 'The CAD project no longer exists in this workbench.');
    const saved = await parseSaved(raw, id);
    requireSavedVersion(saved, options.expectedSavedVersion);
    const archivedAt = new Date().toISOString();
    const archivePath = `cad/trash/${id}/${Date.parse(archivedAt)}-${saved.savedVersion}.cad.json`;
    await commitWorkbenchFileTransaction(adapter, [
      { path: archivePath, contents: raw, expectedPrevious: null },
      { path, contents: null, expectedPrevious: raw }
    ], () => options.signal?.throwIfAborted());
    return { ...libraryEntry(saved), archivePath, archivedAt };
  });
}

export async function restoreCadDocument(adapter: WorkbenchStorageAdapter, archivePath: string, signal?: AbortSignal) {
  const identity = archiveIdentity(archivePath);
  return withWorkbenchMutationLock(adapter, async () => {
    const raw = await readRaw(adapter, archivePath, signal);
    if (raw === null) throw new CadStorageError('NOT_FOUND', 'The archived CAD project no longer exists.');
    const saved = await parseSaved(raw, identity.id);
    requireSavedVersion(saved, identity.savedVersion);
    const path = cadDocumentPath(identity.id);
    if (await readRaw(adapter, path, signal) !== null) {
      throw new CadStorageError('RESTORE_CONFLICT', 'A CAD project with this identity already exists. Export it before restoring the archived project.');
    }
    await commitWorkbenchFileTransaction(adapter, [
      { path, contents: raw, expectedPrevious: null },
      { path: archivePath, contents: null, expectedPrevious: raw }
    ], () => signal?.throwIfAborted());
    return saved;
  });
}

/** Same transaction and cross-tab lock for cache and folders. No index or catalog migration. */
export async function saveCadDocument(adapter: WorkbenchStorageAdapter, document: CadDocument, options: {
  expectedSavedVersion: string | null; signal?: AbortSignal; beforeWrite?: () => void;
}): Promise<SavedCadDocument> {
  const validated = parseCadDocument(document);
  const path = cadDocumentPath(validated.id);
  const updatedAt = new Date().toISOString();
  // The stored form: sketch generators without the members a load generates again.
  const raw = JSON.stringify({ format: 'wireedm-cad-save', schemaVersion: 1, updatedAt, document: storedCadDocument(validated) });
  options.signal?.throwIfAborted();
  // Prepare every fallible receipt field before a durable write. Once the
  // journal starts, cancellation or cleanup failure must retain this receipt.
  const savedVersion = await fingerprint(raw);
  return withWorkbenchMutationLock(adapter, async () => {
    options.signal?.throwIfAborted();
    const existing = await readRaw(adapter, path, options.signal);
    const previous = existing === null ? null : await parseSaved(existing, validated.id);
    if ((previous?.savedVersion ?? null) !== options.expectedSavedVersion) {
      throw new CadStorageError('SAVED_DOCUMENT_CHANGED', 'This CAD document changed in storage. Export your draft, then reopen the saved document before editing.');
    }
    const changes = [];
    if (existing !== null && previous !== null) {
      if (previous.document.schemaVersion < validated.schemaVersion) {
        const originalPath = `cad/originals/${validated.id}/schema-${previous.document.schemaVersion}-${previous.savedVersion}.cad.json`;
        const original = await readRaw(adapter, originalPath, options.signal);
        if (original !== null && original !== existing) {
          throw new CadStorageError('ORIGINAL_BACKUP_CONFLICT', 'The original CAD format backup contains different data. Preserve both files; the saved CAD document was not changed.');
        }
        // Verify and retain the exact older save before publishing its replacement.
        // A matching original stays in the journal so capture/readback also checks retries.
        changes.push({ path: originalPath, contents: existing, expectedPrevious: original });
      }
    }
    changes.push({ path, contents: raw, expectedPrevious: existing });
    try {
      await commitWorkbenchFileTransaction(adapter, changes, () => {
        options.signal?.throwIfAborted(); options.beforeWrite?.();
      });
    } catch (error) {
      if (error instanceof WorkbenchFileConflictError) {
        if (error.path !== path) throw new CadStorageError('ORIGINAL_BACKUP_CONFLICT', 'The original CAD format backup changed before saving. Preserve both files; the saved CAD document was not changed.');
        throw new CadStorageError('SAVED_DOCUMENT_CHANGED', 'This CAD document changed in storage. Export your draft, then reopen the saved document before editing.');
      }
      throw error;
    }
    return { document: validated, updatedAt, savedVersion };
  });
}

export async function listCadDocuments(adapter: WorkbenchStorageAdapter, signal?: AbortSignal): Promise<{
  entries: CadLibraryEntry[]; diagnostics: { path: string; message: string }[]; truncated: boolean;
}> {
  const { entries, diagnostics, truncated } = await readCadLibrary(adapter, false, signal);
  return { entries, diagnostics, truncated };
}

export function listCadProjectLibrary(adapter: WorkbenchStorageAdapter, signal?: AbortSignal) {
  return readCadLibrary(adapter, true, signal);
}

async function readCadLibrary(adapter: WorkbenchStorageAdapter, includeArchives: boolean, signal?: AbortSignal) {
  return withWorkbenchMutationLock(adapter, async () => {
    if (!adapter.listFiles) throw new CadStorageError('INVENTORY_UNAVAILABLE', 'This storage connection cannot list CAD documents.');
    const inventory = await adapter.listFiles(signal);
    const entries: CadLibraryEntry[] = [];
    const archivedEntries: ArchivedCadLibraryEntry[] = [];
    const diagnostics: { path: string; message: string }[] = [];
    for (const path of inventory.paths.filter(path => (path.startsWith(prefix) || (includeArchives && path.startsWith('cad/trash/'))) && path.endsWith('.cad.json'))) {
      signal?.throwIfAborted();
      try {
        const archived = path.startsWith('cad/trash/') ? archiveIdentity(path) : null;
        const id = archived?.id ?? path.slice(prefix.length, -'.cad.json'.length);
        if (!archived && cadDocumentPath(id) !== path) throw new Error('Unexpected CAD document path.');
        const raw = await readRaw(adapter, path, signal);
        if (raw === null) throw new Error('File disappeared during reading.');
        const saved = await parseSaved(raw, id);
        if (archived) {
          requireSavedVersion(saved, archived.savedVersion);
          archivedEntries.push({ ...libraryEntry(saved), archivePath: path, archivedAt: archived.archivedAt });
        } else entries.push(libraryEntry(saved));
      } catch (error) {
        signal?.throwIfAborted();
        diagnostics.push({ path, message: error instanceof Error ? error.message : 'Cannot read CAD document.' });
      }
    }
    return { entries: entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      archivedEntries: archivedEntries.sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt)), diagnostics, truncated: inventory.truncated };
  });
}
