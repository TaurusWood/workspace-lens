import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function initRepo(root: string, files: Record<string, string> = {}): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main", root);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  if (Object.keys(files).length > 0) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
}

export function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
