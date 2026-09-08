import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isOqtoAppError } from "./errors.js";
import type {
  JsonValue,
  OqtoContextSnapshot,
  OqtoGrantSnapshot,
  OqtoHost,
  OqtoOperationInvokeOptions,
  OqtoOperationResult,
  OqtoPresentationContext,
  OqtoSuspension,
  OqtoThemeSnapshot,
} from "./types.js";

const HostContext = createContext<OqtoHost | undefined>(undefined);

export interface OqtoHostProviderProps {
  readonly host: OqtoHost;
  readonly children: ReactNode;
}

/** Optional React adapter. The core SDK has no React runtime dependency. */
export function OqtoHostProvider({ host, children }: OqtoHostProviderProps) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useOqtoHost(): OqtoHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("useOqtoHost must be used inside OqtoHostProvider");
  return host;
}

/** Exactly what this mount may do. Stable for the lifetime of the mount. */
export function useOqtoGrants(): OqtoGrantSnapshot {
  return useOqtoHost().context.grants;
}

/**
 * Track a host-owned snapshot that also emits updates.
 *
 * The initial read and the subscription are set up together, and a late
 * response is discarded once the effect is torn down, so an unmounted tree
 * never receives state.
 */
function useHostSnapshot<T>(
  read: (() => Promise<T>) | undefined,
  watch: ((listener: (value: T) => void) => Promise<() => void>) | undefined,
  initial: T | undefined,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);

  useEffect(() => {
    if (read === undefined || watch === undefined) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;

    void read()
      .then((next) => {
        if (active) setValue(next);
      })
      .catch(() => undefined);
    void watch((next) => {
      if (active) setValue(next);
    })
      .then((stop) => {
        if (!active) {
          stop();
          return;
        }
        unsubscribe = stop;
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [read, watch]);

  return value;
}

/** Live host theme, or `undefined` until the first snapshot arrives. */
export function useOqtoTheme(): OqtoThemeSnapshot | undefined {
  const host = useOqtoHost();
  const theme = host.theme;
  const read = useMemo(() => theme?.get.bind(theme), [theme]);
  const watch = useMemo(() => theme?.watch.bind(theme), [theme]);
  return useHostSnapshot(read, watch, undefined);
}

/**
 * Live container geometry.
 *
 * Size against this rather than the viewport: an App may be mounted in a narrow
 * split pane or a phone-sized sheet, and the window says nothing about either.
 */
export function useOqtoPresentation(): OqtoPresentationContext | undefined {
  const host = useOqtoHost();
  const presentation = host.presentation;
  const read = useMemo(() => presentation?.get.bind(presentation), [presentation]);
  const watch = useMemo(() => presentation?.watch.bind(presentation), [presentation]);
  return useHostSnapshot(read, watch, host.context.presentation);
}

/** Live value for one App-defined Agent Context topic. */
export function useOqtoContextTopic(topic: string): OqtoContextSnapshot | undefined {
  const host = useOqtoHost();
  const context = host.agentContext;
  const read = useMemo(
    () => (context === undefined ? undefined : () => context.get(topic)),
    [context, topic],
  );
  const watch = useMemo(
    () =>
      context === undefined
        ? undefined
        : async (listener: (value: OqtoContextSnapshot | undefined) => void) =>
            context.watch([topic], (change) => listener(change.snapshot)),
    [context, topic],
  );
  return useHostSnapshot(read, watch, undefined);
}

/**
 * Suspension state for this mount.
 *
 * Once set, every capability call rejects. Render a read-only explanation
 * rather than retrying.
 */
export function useOqtoSuspension(): OqtoSuspension | undefined {
  const host = useOqtoHost();
  const [suspension, setSuspension] = useState<OqtoSuspension | undefined>(() => host.isSuspended());

  useEffect(() => {
    const current = host.isSuspended();
    if (current !== undefined) {
      setSuspension(current);
      return;
    }
    let active = true;
    const unsubscribe = host.onSuspended((next) => {
      if (active) setSuspension(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host]);

  return suspension;
}

export interface UseOqtoOperationState {
  readonly pending: boolean;
  readonly result: OqtoOperationResult | undefined;
  /** Transport, authorization, or suspension failure. Not an operation failure. */
  readonly error: Error | undefined;
}

export interface UseOqtoOperation extends UseOqtoOperationState {
  invoke(input?: JsonValue, options?: OqtoOperationInvokeOptions): Promise<OqtoOperationResult>;
  /** Cancel the in-flight invocation, if any. */
  cancel(): void;
  reset(): void;
}

/**
 * Invoke one granted operation with pending, result, and error state.
 *
 * Only the newest invocation may update state, so an overlapping call cannot
 * resurrect a stale result. Unmounting cancels the in-flight request.
 */
export function useOqtoOperation(id: string): UseOqtoOperation {
  const host = useOqtoHost();
  const operations = host.operations;
  const [state, setState] = useState<UseOqtoOperationState>({
    pending: false,
    result: undefined,
    error: undefined,
  });
  const activeRef = useRef<{ token: symbol; controller: AbortController } | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current?.controller.abort();
      activeRef.current = undefined;
    };
  }, []);

  const cancel = useCallback(() => {
    activeRef.current?.controller.abort();
    activeRef.current = undefined;
  }, []);

  const reset = useCallback(() => {
    setState({ pending: false, result: undefined, error: undefined });
  }, []);

  const invoke = useCallback(
    async (input?: JsonValue, options?: OqtoOperationInvokeOptions): Promise<OqtoOperationResult> => {
      if (!operations) {
        const error = new Error("Operations capability is not granted");
        if (mountedRef.current) setState({ pending: false, result: undefined, error });
        throw error;
      }
      activeRef.current?.controller.abort();
      const controller = new AbortController();
      const token = Symbol(id);
      activeRef.current = { token, controller };
      if (options?.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const isCurrent = () => mountedRef.current && activeRef.current?.token === token;
      if (mountedRef.current) setState({ pending: true, result: undefined, error: undefined });

      try {
        const timeoutMs = options?.timeoutMs;
        const result = await operations.invoke(id, input, {
          signal: controller.signal,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        if (isCurrent()) {
          activeRef.current = undefined;
          setState({ pending: false, result, error: undefined });
        }
        return result;
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause
            : new Error(isOqtoAppError(cause) ? cause.message : "Operation failed");
        if (isCurrent()) {
          activeRef.current = undefined;
          setState({ pending: false, result: undefined, error });
        }
        throw error;
      }
    },
    [id, operations],
  );

  return { ...state, invoke, cancel, reset };
}
