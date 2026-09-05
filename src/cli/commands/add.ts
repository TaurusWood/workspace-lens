import { ConfigStore, describeError } from "../../config/config-store.js";
import { ConfigError } from "../../config/config-schema.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

const ADD_USAGE = `Usage: workspace-lens add <path> [--name <name>] [--id <id>]`;

export interface AddOptions {
  name?: string;
  id?: string;
}

export function parseAddArgs(args: readonly string[]): { path: string; options: AddOptions } | { error: string } {
  const positional: string[] = [];
  const options: AddOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--name") {
      const value = args[i + 1];
      if (value === undefined) return { error: "Missing value for --name" };
      options.name = value;
      i += 1;
    } else if (arg === "--id") {
      const value = args[i + 1];
      if (value === undefined) return { error: "Missing value for --id" };
      options.id = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    return { error: "Exactly one workspace root path is required" };
  }
  return { path: positional[0]!, options };
}

export async function runAdd(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseAddArgs(args);
  if ("error" in parsed) {
    writeLine(io.err, `error: ${parsed.error}`);
    writeLine(io.err, ADD_USAGE);
    return 2;
  }

  try {
    const store = new ConfigStore();
    const workspace = store.add(parsed.path, parsed.options);
    writeLine(io.out, `Authorized workspace "${workspace.name}" (id: ${workspace.workspace_id})`);
    writeLine(io.out, `  root: ${workspace.root}`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      writeLine(io.err, `error: ${describeError(error)}`);
      return 1;
    }
    throw error;
  }
}
