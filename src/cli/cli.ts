import { SERVER_VERSION } from "../version.js";
import { runAdd } from "./commands/add.js";
import { runDoctor } from "./commands/doctor.js";
import { runList } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";
import { runServe } from "./commands/serve.js";
import type { CliIo } from "./io.js";
import { defaultIo } from "./io.js";

const USAGE = `workspace-lens — read-only MCP context server for local workspaces

Usage:
  workspace-lens add <path> [--name <name>] [--id <id>]  Authorize a local workspace root
  workspace-lens list                                    List authorized workspaces
  workspace-lens remove <workspace>                      Remove an authorized workspace
  workspace-lens serve                                   Start the MCP server on stdio
  workspace-lens doctor                                  Check local setup prerequisites
  workspace-lens version                                 Print the version
`;

function printUsage(io: CliIo): void {
  io.out.write(USAGE);
}

async function dispatch(args: readonly string[], io: CliIo): Promise<number> {
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "add":
      return runAdd(rest, io);
    case "list":
      return runList(rest, io);
    case "remove":
      return runRemove(rest, io);
    case "serve":
      return runServe();
    case "doctor":
      return runDoctor(rest, io);
    case "version":
    case "--version":
    case "-V":
      io.out.write(`${SERVER_VERSION}\n`);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage(io);
      return 0;
    default:
      io.err.write(`Unknown command: ${command}\n\n`);
      printUsage(io);
      return 2;
  }
}

export function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<void> {
  return dispatch(args, io).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      io.err.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
