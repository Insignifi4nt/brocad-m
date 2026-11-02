import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { jsonByteLength, summarizeMessage } from './diagnosticSummaries';

export interface SiteTool {
  name: string;
  description: string;
  inputSchema: TSchema;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface ModelContext {
  registerTool(tool: SiteTool, options: { signal: AbortSignal }): Promise<void> | void;
}
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Readonly<Record<string, unknown>>) { super(message); }
}
export const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const pageFields = {
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
};
export const SITE_TOOL_PAGE_BYTE_BUDGET = 24 * 1024;
/** Leave room for the envelope and query metadata; never truncate an individual row. */
export function page<T, R = T>(rows: readonly T[], input: { offset?: number; limit?: number }, project: (row: T) => R = row => row as unknown as R) {
  const offset = input.offset ?? 0;
  const end = Math.min(rows.length, offset + (input.limit ?? 10));
  const items: R[] = [];
  let bytes = 2;
  let next = offset;
  for (; next < end; next += 1) {
    const item = project(rows[next]);
    const itemBytes = jsonByteLength(item) + (items.length ? 1 : 0);
    if (bytes + itemBytes > SITE_TOOL_PAGE_BYTE_BUDGET) {
      if (!items.length) throw new ToolError('OUTPUT_TOO_LARGE', 'This individual row exceeds the tool response budget. Use the visible page or exported project for its complete details; reducing the page size cannot shorten this row.', { offset: next });
      break;
    }
    items.push(item);
    bytes += itemBytes;
  }
  return { items, total: rows.length, nextOffset: next < rows.length ? next : null };
}
export function siteTool<S extends TSchema>(
  name: string, description: string, inputSchema: S,
  run: (input: Static<S>, signal: AbortSignal) => unknown | Promise<unknown>,
  readOnlyHint = true,
  /** Refuses unchecked input with a reason its schema check would not give, before that check. */
  refuse?: (input: unknown) => void
): SiteTool {
  return { name, description, inputSchema, annotations: { readOnlyHint, untrustedContentHint: true },
    async execute(input, options) {
      const signal = options?.signal ?? new AbortController().signal;
      try {
        signal.throwIfAborted();
        refuse?.(input);
        if (!Value.Check(inputSchema, input)) {
          const issues = [];
          for (const issue of Value.Errors(inputSchema, input)) {
            issues.push({ path: (issue.path || '/').slice(0, 240), message: issue.message.slice(0, 240) });
            if (issues.length === 5) break;
          }
          throw new ToolError('INVALID_ARGUMENT', 'Arguments must match the tool schema.', { issues });
        }
        const data = await run(input, signal);
        // Once a mutation commits, return its receipt even if cancellation arrived during the write.
        if (readOnlyHint) signal.throwIfAborted();
        const result = { ok: true, data };
        if (jsonByteLength(result) > 32 * 1024) {
          throw new ToolError('OUTPUT_TOO_LARGE', 'Request fewer rows or use the visible page report for full details.');
        }
        return result;
      } catch (error) {
        return { ok: false, error: signal.aborted ? { code: 'CANCELLED', message: 'Operation cancelled.' }
          : error instanceof ToolError ? { code: error.code, ...summarizeMessage(error.message),
            ...(error.details ? jsonByteLength(error.details) <= 24 * 1024 ? { details: error.details } : { omittedDetails: true } : {}) }
          : { code: 'OPERATION_FAILED', message: 'Operation failed. Review the page or retry with corrected inputs.' } };
      }
    }
  };
}

/** Registration lifetime and execution cancellation are separate in current WebMCP. */
export interface SiteToolActivity {
  readonly id: number;
  readonly toolName: string;
  readonly phase: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface SiteToolActivityState {
  readonly registration: 'unsupported' | 'pending' | 'ready' | 'failed';
  readonly calls: readonly SiteToolActivity[];
}

export function registerSiteTools(context: ModelContext, tools: readonly SiteTool[], onActivity?: (activity: SiteToolActivity) => void) {
  const lifetime = new AbortController();
  const running = new Set<AbortController>();
  let sequence = 0;
  const ready = (async () => {
    for (const tool of tools) {
      if (lifetime.signal.aborted) return;
      await context.registerTool({ ...tool, execute: async (input, options) => {
        if (lifetime.signal.aborted) return staleRegistration();
        const call = new AbortController();
        const abort = () => call.abort();
        if (lifetime.signal.aborted || options?.signal?.aborted) call.abort();
        options?.signal?.addEventListener('abort', abort, { once: true });
        running.add(call);
        const activity = { id: ++sequence, toolName: tool.name, startedAt: Date.now() };
        onActivity?.({ ...activity, phase: 'running' });
        try {
          const result = await tool.execute(input, { signal: call.signal });
          const outcome = activityOutcome(result);
          onActivity?.({ ...activity, ...outcome, completedAt: Date.now() });
          return result;
        } catch (error) {
          onActivity?.({ ...activity, phase: call.signal.aborted ? 'cancelled' : 'failed', completedAt: Date.now(), message: 'Tool execution failed.' });
          throw error;
        }
        finally { running.delete(call); options?.signal?.removeEventListener('abort', abort); }
      } }, { signal: lifetime.signal });
    }
  })();
  const dispose = () => { lifetime.abort(); for (const call of running) call.abort(); };
  return { ready: ready.catch((error: unknown) => { dispose(); throw error; }), dispose };
}

/** Stable registration; callbacks always see the most recently committed React state. */
export function useSiteTools(tools: readonly SiteTool[]) {
  const latest = useRef(tools);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const runningCalls = useRef(new Set<number>());
  const [activity, setActivity] = useState<SiteToolActivityState>({ registration: 'unsupported', calls: [] });
  useLayoutEffect(() => { latest.current = tools; });
  useEffect(() => {
    let mounted = true;
    let suspended = false;
    let generation = 0;
    let context: ModelContext | undefined;
    let registration: ReturnType<typeof registerSiteTools> | null = null;
    const readContext = () => (document as Document & { modelContext?: ModelContext }).modelContext;
    function start(force = false) {
      if (!mounted || suspended) return;
      const nextContext = readContext();
      if (!force && context === nextContext && registration) return;
      const currentGeneration = ++generation;
      registration?.dispose(); registration = null; context = nextContext;
      runningCalls.current.clear();
      if (typeof nextContext?.registerTool !== 'function') { setActivity({ registration: 'unsupported', calls: [] }); return; }
      setActivity({ registration: 'pending', calls: [] });
      registration = registerSiteTools(nextContext, latest.current.map(tool => ({ ...tool,
        execute: (input, options) => {
          if (!mounted || generation !== currentGeneration || readContext() !== nextContext) return Promise.resolve(staleRegistration());
          const current = latest.current.find(({ name }) => name === tool.name);
          return current ? current.execute(input, options) : Promise.resolve({ ok: false, error: { code: 'UNAVAILABLE', message: 'Tool is no longer available.' } });
        }
      })), call => {
        if (mounted && generation === currentGeneration) {
          if (call.phase === 'running') runningCalls.current.add(call.id); else runningCalls.current.delete(call.id);
        }
        if (mounted && generation === currentGeneration) setActivity(current => {
          const next = [call, ...current.calls.filter(previous => previous.id !== call.id)];
          return { ...current, calls: [...next.filter(item => item.phase === 'running'), ...next.filter(item => item.phase !== 'running')].slice(0, 8) };
        });
      });
      void registration.ready.then(() => {
        if (mounted && generation === currentGeneration) setActivity(current => ({ ...current, registration: 'ready' }));
      }).catch(() => {
        if (mounted && generation === currentGeneration) {
          setActivity(current => ({ ...current, registration: 'failed' }));
          console.warn('Site tools could not be registered; the normal interface remains available.');
        }
      });
    }
    const hide = () => { suspended = true; ++generation; registration?.dispose(); registration = null; };
    const show = (event: PageTransitionEvent) => {
      const restoring = suspended || event.persisted;
      suspended = false;
      start(restoring);
    };
    const resume = () => { if (document.visibilityState === 'visible') start(); };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    start();
    return () => {
      mounted = false; ++generation; registration?.dispose();
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume);
    };
  }, [refreshEpoch]);
  return { ...activity, refresh: () => { if (runningCalls.current.size === 0) setRefreshEpoch(epoch => epoch + 1); } };
}

function staleRegistration() {
  return { ok: false, error: { code: 'TOOL_REGISTRATION_STALE', message: 'This tool belongs to an earlier browser registration. Refresh agent tools in the notification panel, rediscover tools for this tab, then read fresh context. The project draft has not been changed.' } };
}

function activityOutcome(result: unknown): Pick<SiteToolActivity, 'phase' | 'errorCode' | 'message'> {
  if (!result || typeof result !== 'object') return { phase: 'succeeded' };
  const envelope = result as { ok?: boolean; error?: { code?: unknown; message?: unknown }; data?: { generated?: boolean; installed?: boolean; saved?: boolean; activated?: boolean; error?: { code?: unknown; message?: unknown }; status?: unknown } };
  if (envelope.ok !== false && envelope.data?.status === 'generated-download-not-requested') return {
    phase: 'succeeded', message: 'Controller artifact generated; download was not requested after cancellation.'
  };
  const error = envelope.ok === false ? envelope.error : envelope.data?.generated === false || envelope.data?.installed === false ||
    envelope.data?.saved === false || envelope.data?.activated === false ||
    envelope.data?.status === 'generated-download-failed' || envelope.data?.status === 'captured-download-failed' ? envelope.data.error : undefined;
  if (envelope.ok !== false && !error) return { phase: 'succeeded' };
  return { phase: error?.code === 'CANCELLED' ? 'cancelled' : 'failed',
    ...(typeof error?.code === 'string' ? { errorCode: error.code.slice(0, 160) } : {}),
    ...(typeof error?.message === 'string' ? { message: error.message.slice(0, 500) } : {}) };
}
