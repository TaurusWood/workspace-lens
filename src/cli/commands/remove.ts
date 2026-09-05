import { ConfigStore, describeError } from "../../config/config-store.js";
import { ConfigError } from "../../config/config-schema.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

export async function runRemove(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith("-")) {
    writeLine(io.err, "Usage: workspace-lens remove <workspace-id-or-name>");
    return 2;
  }
  const target = args[0]!;

  try {
    const store = new ConfigStore();
    const removed = store.remove(target);
    writeLine(io.out, `Removed workspace "${removed.name}" (id: ${removed.workspace_id})`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      writeLine(io.err, `error: ${describeError(error)}`);
      return 1;
    }
    throw error;
  }
}
