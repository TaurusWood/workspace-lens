import { SERVER_VERSION } from "../version.js";
import { runServe } from "./commands/serve.js";

const USAGE = `workspace-lens — read-only MCP context server for local workspaces

Usage:
  workspace-lens serve                       Start the MCP server on stdio
  workspace-lens version                     Print the version

More commands (add, list, remove, doctor) are added in later phases.
`;

function printUsage(): void {
  process.stdout.write(USAGE);
}

export function runCli(args: readonly string[]): void {
  const command = args[0];

  switch (command) {
    case "serve":
      void runServe();
      return;
    case "version":
    case "--version":
    case "-V":
      process.stdout.write(`${SERVER_VERSION}\n`);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return;
    default:
      process.stderr.write(`Unknown command: ${command ?? ""}\n\n`);
      printUsage();
      process.exitCode = 2;
  }
}
