import { userFacingMessage } from '@/lib/userMessage';
import type { CadBuildResult, CadDocument, CadFeature } from '@/domain/cad/cadDocument';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import type { WorkbenchStorageAdapter } from '@/domain/storage/workbenchStorageAdapter';
import type { CadKernelClient } from './kernel/cadKernelClient';
import { cadGeneratorRemovals, cadGeneratorRemovalText, type CadGeneratorRemovals } from './cadGeneratorRemovals';

export type CadFeatureCandidateEdits = readonly [Extract<CadEdit, { kind: 'add-feature' | 'update-feature' }>, ...Extract<CadEdit, { kind: 'set-parameter' }>[]];
/** The edits that add or update `feature` and set `parameters`; the first parameter confirms the relations `removedRelationIds` its regeneration removes. */
export function cadFeatureCandidateEdits(input: { feature: CadFeature; isNew: boolean; parameters?: Readonly<Record<string, number>>; removedRelationIds?: readonly string[] }): CadFeatureCandidateEdits {
  const confirmed = input.removedRelationIds?.length ? { removedRelationIds: [...input.removedRelationIds] } : {};
  return [{ kind: input.isNew ? 'add-feature' : 'update-feature', feature: input.feature },
    ...Object.entries(input.parameters ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, value], index) => ({ kind: 'set-parameter' as const, name, value, ...index ? {} : confirmed }))];
}
export function cadFeatureCandidateKey(edits: CadFeatureCandidateEdits): string { return JSON.stringify(edits); }

export type CadFeaturePreviewCommand = { readonly kind: 'candidate'; readonly owner: string; readonly expectedVersion: string; readonly edits: CadFeatureCandidateEdits }
  | { readonly kind: 'blocked'; readonly owner: string; readonly expectedVersion: string; readonly edits: CadFeatureCandidateEdits; readonly message: string }
  | { readonly kind: 'clear'; readonly owner: string };
interface PreviewIdentity { readonly owner: string; readonly baseVersion: string; readonly candidateId: string; readonly featureId: string; readonly definitionKey: string }
export interface CadFeaturePreviewSnapshot extends PreviewIdentity { readonly document: CadDocument; readonly result: CadBuildResult }
export type CadFeaturePreviewState = { readonly kind: 'idle' }
  | (PreviewIdentity & { readonly kind: 'waiting'; readonly lastValid?: CadFeaturePreviewSnapshot })
  | (PreviewIdentity & { readonly kind: 'building'; readonly lastValid?: CadFeaturePreviewSnapshot })
  | (CadFeaturePreviewSnapshot & { readonly kind: 'ready' })
  | (PreviewIdentity & { readonly kind: 'error'; readonly stage: 'validation' | 'kernel'; readonly message: string; readonly diagnostics: CadBuildResult['diagnostics']; readonly lastValid?: CadFeaturePreviewSnapshot;
    /** The relations the candidate removes as generators regenerate; the preview applies none, so its editor asks and sends them confirmed. */
    readonly removals?: CadGeneratorRemovals });
interface Candidate extends PreviewIdentity {
  readonly serial: number;
  readonly document: CadDocument | null;
  readonly edits: CadFeatureCandidateEdits;
  readonly baseDocument: CadDocument;
  readonly storage: WorkbenchStorageAdapter;
}
const idle: CadFeaturePreviewState = Object.freeze({ kind: 'idle' });
/** Why a candidate failed: what it would remove, in the words its editor asks with, or the error's message. */
function failure(error: unknown, fallback: string, document: CadDocument | undefined) {
  const removals = document ? cadGeneratorRemovals(error) : undefined;
  return removals && document ? { message: cadGeneratorRemovalText(document, removals), removals } : { message: userFacingMessage(error, fallback) };
}

/** Candidates never enter session history or the accepted kernel's exact cache. */
export function createCadFeaturePreviewCoordinator(options: {
  assertCurrent(expectedVersion: string): { readonly document: CadDocument; readonly storage: WorkbenchStorageAdapter };
  createKernel(): Promise<Pick<CadKernelClient, 'build' | 'dispose'>>;
  prepare?(document: CadDocument, edits: CadFeatureCandidateEdits, signal: AbortSignal): Promise<CadDocument>;
  onChange(state: CadFeaturePreviewState): void;
  debounceMs?: number;
}) {
  let owner: string | null = null, serial = 0, disposed = false;
  let latest: Candidate | null = null;
  let lastValid: CadFeaturePreviewSnapshot | null = null;
  let environment: { readonly document: CadDocument; readonly storage: WorkbenchStorageAdapter } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: { readonly candidate: Candidate; readonly controller: AbortController } | null = null;
  let client: Promise<Pick<CadKernelClient, 'build' | 'dispose'>> | null = null;
  const publish = (state: CadFeaturePreviewState) => { if (!disposed) options.onChange(Object.freeze(state)); };
  function clear() {
    if (timer !== null) clearTimeout(timer); timer = null;
    owner = null; latest = null; lastValid = null; environment = null; ++serial;
    active?.controller.abort(); active = null;
    const previous = client; client = null;
    void previous?.then(value => value.dispose(), () => undefined);
    publish(idle);
  }
  function owns(candidate: Candidate) { return owner === candidate.owner && serial === candidate.serial; }
  function current(candidate: Candidate) {
    if (!owns(candidate)) return false;
    try {
      const accepted = options.assertCurrent(candidate.baseVersion);
      return accepted.document === candidate.baseDocument && accepted.storage === candidate.storage;
    } catch { return false; }
  }
  function identity(candidate: PreviewIdentity): PreviewIdentity {
    return { owner: candidate.owner, baseVersion: candidate.baseVersion, candidateId: candidate.candidateId, featureId: candidate.featureId, definitionKey: candidate.definitionKey };
  }
  function retained(candidate: PreviewIdentity) {
    return lastValid && lastValid.owner === candidate.owner && lastValid.baseVersion === candidate.baseVersion && lastValid.featureId === candidate.featureId ? { lastValid } : {};
  }
  function run() {
    if (disposed || active || timer !== null || !latest) return;
    const candidate = latest; latest = null;
    if (!current(candidate)) { if (owns(candidate)) clear(); return; }
    const job = { candidate, controller: new AbortController() }; active = job;
    publish({ ...identity(candidate), ...retained(candidate), kind: 'building' });
    let stage: 'validation' | 'kernel' = 'validation';
    void Promise.resolve().then(() => candidate.document ?? options.prepare?.(candidate.baseDocument, candidate.edits, job.controller.signal)).then(document => {
      job.controller.signal.throwIfAborted();
      if (!current(candidate)) { if (owns(candidate)) clear(); return; }
      if (!document) throw new Error('The feature candidate has no prepared document.');
      stage = 'kernel';
      const kernel = client ??= Promise.resolve().then(options.createKernel);
      void kernel.catch(() => { if (client === kernel) client = null; });
      return kernel.then(value => value.build(document, job.controller.signal)).then(result => {
        if (!current(candidate)) { if (owns(candidate)) clear(); return; }
        if (result.diagnostics.length) publish({ ...identity(candidate), ...retained(candidate), kind: 'error', stage: 'kernel', message: result.diagnostics[0].message, diagnostics: result.diagnostics });
        else {
          lastValid = { ...identity(candidate), document, result };
          publish({ ...lastValid, kind: 'ready' });
        }
      });
    }).catch((error: unknown) => {
      if (job.controller.signal.aborted) return;
      if (!current(candidate)) { if (owns(candidate)) clear(); return; }
      publish({ ...identity(candidate), ...retained(candidate), kind: 'error', stage, ...failure(error, 'The candidate could not be prepared.', candidate.baseDocument), diagnostics: [] });
    }).finally(() => {
      if (active === job) { active = null; run(); }
    });
  }
  function update(command: CadFeaturePreviewCommand) {
    if (disposed) return;
    if (command.kind === 'clear') { if (owner === command.owner) clear(); return; }
    if (owner !== command.owner) clear();
    owner = command.owner;
    latest = null; ++serial;
    const request: PreviewIdentity = { owner, baseVersion: command.expectedVersion, candidateId: crypto.randomUUID(), featureId: command.edits[0].feature.id, definitionKey: cadFeatureCandidateKey(command.edits) };
    try {
      let accepted: ReturnType<typeof options.assertCurrent>;
      try { accepted = options.assertCurrent(command.expectedVersion); }
      catch (error) { clear(); throw error; }
      if (environment && (environment.document !== accepted.document || environment.storage !== accepted.storage)) { clear(); owner = command.owner; }
      environment = accepted;
      if (command.kind === 'blocked') {
        active?.controller.abort();
        publish({ ...request, ...retained(request), kind: 'error', stage: 'validation', message: command.message, diagnostics: [] });
        return;
      }
      const edits = structuredClone(command.edits);
      const document = options.prepare ? null : applyCadEdits(accepted.document, edits);
      latest = { ...request, serial, document, edits, baseDocument: accepted.document, storage: accepted.storage };
      publish({ ...request, ...retained(request), kind: 'waiting' });
      // A short throttle, not a debounce: a dragged handle keeps changing, and restarting the wait would show nothing until the pointer stops.
      timer ??= setTimeout(() => { timer = null; run(); }, options.debounceMs ?? 50);
    } catch (error) {
      publish({ ...request, ...retained(request), kind: 'error', stage: 'validation', ...failure(error, 'The candidate is not valid.', environment?.document), diagnostics: [] });
    }
  }
  return { update, invalidate: clear, dispose() { if (disposed) return; disposed = true; clear(); } };
}
