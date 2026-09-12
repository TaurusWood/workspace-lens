/**
 * Test adapter objects injected into product code by the v0.3 contract suite.
 *
 * Per the Test CR: Secret/Startup/Tunnel adapters must be injected as REAL
 * OBJECTS provided by the tests — never as magic production-mode strings
 * ("test"/"stub") — so a product implementation that ignores the injected
 * dependencies and reaches for the real OS keychain, real login-startup
 * entries, or the real tunnel binary is exercising a genuinely different code
 * path than the one under test. Child-process harnesses inline these same
 * object factories into the generated child script.
 */

export interface InMemorySecretAdapter {
  available(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Test inspection only. */
  dump(): Record<string, string>;
}

export function inMemorySecretAdapter(): InMemorySecretAdapter {
  const map = new Map<string, string>();
  return {
    available: async () => true,
    get: async (name) => map.get(name),
    set: async (name, value) => {
      map.set(name, value);
    },
    delete: async (name) => {
      map.delete(name);
    },
    dump: () => Object.fromEntries(map),
  };
}

export function unavailableSecretAdapter(): InMemorySecretAdapter {
  const unavailable = async (): Promise<never> => {
    throw new Error("credential store unavailable (test adapter)");
  };
  return {
    available: async () => false,
    get: unavailable,
    set: unavailable,
    delete: unavailable,
    dump: () => ({}),
  };
}

export type TunnelSimulatedState = "stopped" | "starting" | "healthy" | "unhealthy";

export interface StubTunnelAdapter {
  detect(): Promise<{ installed: boolean; version?: string }>;
  connect(input: { alias: string; mcpServerUrl: string; runtimeApiKey: string }): Promise<{ alias: string }>;
  status(alias: string): Promise<{ alias: string; state: TunnelSimulatedState }>;
  stop(alias: string): Promise<void>;
  restart(input: { alias: string; mcpServerUrl: string; runtimeApiKey: string }): Promise<{ alias: string }>;
  /** Test inspection: the secret value must never reach argv-shaped fields. */
  invocations(): { argv: string[] }[];
}

export function stubTunnelAdapter(simulatedState: TunnelSimulatedState = "healthy"): StubTunnelAdapter {
  const invocations: { argv: string[] }[] = [];
  return {
    detect: async () => ({ installed: true, version: "test-stub" }),
    connect: async (input) => {
      invocations.push({
        argv: ["runtimes", "connect", "--alias", input.alias, "--mcp-server-url", input.mcpServerUrl],
      });
      return { alias: input.alias };
    },
    status: async (alias) => {
      invocations.push({ argv: ["runtimes", "status", alias] });
      return { alias, state: simulatedState };
    },
    stop: async (alias) => {
      invocations.push({ argv: ["runtimes", "stop", alias] });
    },
    restart: async (input) => {
      invocations.push({ argv: ["runtimes", "restart", "--alias", input.alias] });
      return { alias: input.alias };
    },
    invocations: () => invocations,
  };
}

export interface InMemoryStartupAdapter {
  status(): Promise<{ enabled: boolean; entries: { id: string }[] }>;
  enable(input: { executable: string; args: string[] }): Promise<void>;
  disable(): Promise<void>;
  buildDefinition(input: { executable: string; args: string[] }): Promise<{ executable: string; args: string[]; id: string }>;
  reconcile(): Promise<{ state: string; runtimeCanStart: boolean }>;
}

export function inMemoryStartupAdapter(): InMemoryStartupAdapter {
  let enabled = false;
  let definition: { executable: string; args: string[]; id: string } | undefined;
  return {
    status: async () => ({
      enabled,
      entries: definition && enabled ? [{ id: definition.id }] : [],
    }),
    enable: async (input) => {
      // Idempotent: a single fixed entry, never duplicated.
      definition = {
        executable: input.executable,
        args: [...input.args],
        id: "workspace-lens-test-startup",
      };
      enabled = true;
    },
    disable: async () => {
      enabled = false;
    },
    buildDefinition: async (input) => ({
      executable: input.executable,
      args: [...input.args],
      id: "workspace-lens-test-startup",
    }),
    reconcile: async () => ({ state: "healthy", runtimeCanStart: true }),
  };
}
