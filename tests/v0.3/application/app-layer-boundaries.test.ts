import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Slice 0 boundary guard (`docs/v0.3-implementation-plan.md` §4: "verify
 * application layer has no dependency on Hono/React"). The shared
 * application/config/core layers must stay framework-independent: Hono is
 * only the later HTTP adapter and React only the later UI, never imports of
 * the business layer (`docs/v0.3-technical-architecture-rfc.md` §15).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FORBIDDEN = /(from\s*["']|import\s*["'])[^"']*\b(hono|react)\b/i;

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(absolute));
    } else if (entry.name.endsWith(".ts")) {
      found.push(absolute);
    }
  }
  return found;
}

describe("APP — application layer framework boundaries", () => {
  it("application/config/core sources never import Hono or React", () => {
    const sourceRoots = ["application", "config", "core"].map((dir) => path.join(REPO_ROOT, "src", dir));
    const violations: string[] = [];
    for (const root of sourceRoots) {
      for (const file of collectSourceFiles(root)) {
        const content = fs.readFileSync(file, "utf8");
        if (FORBIDDEN.test(content)) {
          violations.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("production dependencies declare no Hono or React packages", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const violations = deps.filter((dep) => /^(hono|react|react-dom)(@.*)?$/i.test(dep) || dep.startsWith("@hono/"));
    expect(violations).toEqual([]);
  });
});
