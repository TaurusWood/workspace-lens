import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { PathResolver } from "../../src/core/path-resolver.js";

/**
 * Canonical containment invariant (`security-model.md` §4.4) — including the
 * mandatory acceptance cases from `implementation-plan.md` §10.
 */
describe("PathResolver canonical containment", () => {
  let scratch: string;
  let outside: string;
  let root: string;
  let resolver: PathResolver;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wl-resolver-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wl-outside-")));
    root = path.join(scratch, "workspace");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
    fs.mkdirSync(path.join(root, "secrets"));
    fs.writeFileSync(path.join(root, "secrets", "real.txt"), "inside\n");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");

    // Escaping symlinks
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "link-out"));
    fs.symlinkSync(outside, path.join(root, "link-dir-out"));
    // Contained symlink
    fs.symlinkSync(path.join(root, "src", "index.ts"), path.join(root, "link-in"));
    fs.symlinkSync(path.join(root, "secrets"), path.join(root, "link-dir-in"));
    // Broken symlink
    fs.symlinkSync(path.join(root, "nope"), path.join(root, "broken"));
    // Relative-looking escape: src/../../outside
    fs.symlinkSync(scratch, path.join(root, "link-parent"));

    resolver = new PathResolver(root);
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  async function expectError(input: string, code: string, options?: { mustExist?: boolean }) {
    let thrown: unknown;
    try {
      await resolver.resolve(input, options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `expected ${code} for ${input}`).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(code);
  }

  it("resolves the workspace root", async () => {
    const resolved = await resolver.resolve(".");
    expect(resolved.absolutePath).toBe(root);
    expect(resolved.relativePath).toBe(".");
  });

  it("resolves normal nested files to canonical paths", async () => {
    const resolved = await resolver.resolve("src/index.ts");
    expect(resolved.absolutePath).toBe(path.join(root, "src", "index.ts"));
    expect(resolved.relativePath).toBe("src/index.ts");
  });

  it("rejects ../ traversal before any filesystem access", async () => {
    await expectError("../secret", "PATH_INVALID");
    await expectError("src/../../secret", "PATH_INVALID");
  });

  it("rejects absolute Unix paths", async () => {
    await expectError("/etc/passwd", "PATH_INVALID");
  });

  it("rejects Windows drive paths", async () => {
    await expectError("C:/Users/me/secret", "PATH_INVALID");
    await expectError("C:\\Users\\me\\secret", "PATH_INVALID");
  });

  it("rejects UNC paths", async () => {
    await expectError("\\\\server\\share\\file", "PATH_INVALID");
  });

  it("rejects symlinks that resolve outside the workspace", async () => {
    await expectError("link-out", "PATH_OUTSIDE_WORKSPACE");
    await expectError("link-dir-out", "PATH_OUTSIDE_WORKSPACE");
    await expectError("link-dir-out/whatever", "PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects a symlink to a parent directory that escapes the workspace", async () => {
    // link-parent -> scratch; scratch/.. would leave, but scratch itself is
    // outside the workspace root, so resolution must be denied outright.
    await expectError("link-parent", "PATH_OUTSIDE_WORKSPACE");
  });

  it("allows symlinks whose canonical target stays inside the workspace", async () => {
    const file = await resolver.resolve("link-in");
    expect(file.absolutePath).toBe(path.join(root, "src", "index.ts"));

    const dir = await resolver.resolve("link-dir-in");
    expect(dir.absolutePath).toBe(path.join(root, "secrets"));
  });

  it("reports PATH_NOT_FOUND for missing paths and broken symlinks", async () => {
    await expectError("src/missing.ts", "PATH_NOT_FOUND");
    await expectError("missing-dir/deeper/file.ts", "PATH_NOT_FOUND");
    await expectError("broken", "PATH_NOT_FOUND");
  });

  it("fails closed on inaccessible paths without revealing existence", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      it.skip("skipped when running as root", () => {});
      return;
    }
    const locked = path.join(root, "locked-dir");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "inside.txt"), "x");
    fs.chmodSync(locked, 0o000);
    try {
      // The path itself stays a valid contained workspace path, but reading
      // through it fails closed (adapter-level) and resolution of deeper
      // inaccessible targets reports no existence information.
      await expectError("locked-dir/inside.txt", "PATH_NOT_FOUND");
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("treats a vanished root as WORKSPACE_UNAVAILABLE", async () => {
    const goneRoot = path.join(scratch, "gone-root");
    fs.mkdirSync(goneRoot);
    const goneResolver = new PathResolver(goneRoot);
    fs.rmSync(goneRoot, { recursive: true });
    try {
      await goneResolver.resolve(".");
      expect.unreachable("expected WORKSPACE_UNAVAILABLE");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("WORKSPACE_UNAVAILABLE");
    }
  });

  it("contains paths whose lexical form stays inside but symlinks escape", async () => {
    // A contained directory holding an escaping symlink must not be readable
    // through the link even when addressed via several segments.
    fs.mkdirSync(path.join(root, "deep", "deeper"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "deep", "deeper", "escape"));
    await expectError("deep/deeper/escape", "PATH_OUTSIDE_WORKSPACE");
    await expectError("deep/deeper/escape/file.txt", "PATH_OUTSIDE_WORKSPACE");
  });
});
