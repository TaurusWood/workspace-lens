import { WorkspaceAdminService } from "../../application/workspace-admin-service.js";
import { ConfigStore } from "../../config/config-store.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

export async function runList(_args: readonly string[], io: CliIo): Promise<number> {
  const service = new WorkspaceAdminService({ configStore: new ConfigStore() });
  const workspaces = service.list();

  if (workspaces.length === 0) {
    writeLine(io.out, "No workspaces authorized. Use: workspace-lens add <path>");
    return 0;
  }

  const rows: string[][] = [["ID", "NAME", "ENABLED", "ROOT"]];
  for (const ws of workspaces) {
    rows.push([ws.workspace_id, ws.name, ws.enabled ? "yes" : "no", ws.root]);
  }
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  for (const row of rows) {
    writeLine(
      io.out,
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]! + 2)))
        .join("")
        .trimEnd(),
    );
  }
  return 0;
}
