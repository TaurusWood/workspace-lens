/**
 * Control Runtime server assembly (Slice 7).
 *
 * `createControlRuntime` is the in-process entry used by the security
 * contracts: it starts the standard runtime (whose default wiring already
 * includes the privileged Control API behind the full browser-session
 * security gate — see `runtime.ts`) and additionally exposes the security
 * evidence surface:
 *
 * - the runtime binds loopback only — `rebind` is refused unconditionally;
 * - metadata-only log capture and child-argv capture hooks (security
 *   contract §18) so secret-leak checks have a real evidence surface;
 * - capability separation: the browser session is never accepted on /mcp.
 */
import {
  startControlRuntime,
  type CredentialStoreAdapter,
  type ManagedRuntimeAdapter,
} from "./runtime.js";

export type {
  CredentialStoreAdapter,
  ManagedRuntimeAdapter,
} from "./runtime.js";

export interface ControlRuntimeServerOptions {
  configPath: string;
  controlStatePath?: string;
  runtimeStatePath: string;
  port?: number;
  /** Credential adapter (injected object); absent means no store is available. */
  secretAdapter?: CredentialStoreAdapter;
  secretNamespace?: string;
  /** Managed-runtime adapter (injected object); absent means the real binary. */
  tunnelAdapter?: ManagedRuntimeAdapter;
  startupAdapter?: unknown;
}

export interface ControlRuntimeServer {
  baseUrl: string;
  instanceId: string;
  /** Metadata-only log capture (security contract §18); bounded. */
  capturedLogs: unknown[];
  /** Captured child-process argv (reference arguments only); bounded. */
  capturedChildArgv: string[][];
  /** The runtime binds loopback only: rebinding is refused unconditionally. */
  rebind(options: { host: string }): never;
  stop(): Promise<void>;
  runtime: { stop(): Promise<void> };
}

export async function createControlRuntime(
  options: ControlRuntimeServerOptions,
): Promise<ControlRuntimeServer> {
  const started = await startControlRuntime(options);

  return {
    baseUrl: started.baseUrl,
    instanceId: started.instanceId,
    capturedLogs: started.capturedLogs,
    capturedChildArgv: started.capturedChildArgv,
    rebind(): never {
      throw new Error("Control Runtime binds loopback only; rebinding is not supported.");
    },
    stop: () => started.runtime.stop(),
    runtime: { stop: () => started.runtime.stop() },
  };
}
