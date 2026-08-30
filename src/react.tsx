import { createContext, type ReactNode, useContext } from "react";
import type { OqtoHost } from "./types.js";

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
