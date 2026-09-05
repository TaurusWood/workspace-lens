import { describe, expect, it } from "vitest";
import { AccessPolicy, compilePattern } from "../../src/core/access-policy.js";

/**
 * Sensitive-path policy contract (`security-model.md` §6) — including the
 * mandatory Phase 3 cases from `implementation-plan.md` §10.
 */
describe("AccessPolicy default patterns", () => {
  const policy = new AccessPolicy();

  function expectSensitive(relativePath: string): void {
    const decision = policy.decide(relativePath);
    expect(decision, relativePath).toEqual({ decision: "blocked", reason: "sensitive" });
  }

  function expectExcluded(relativePath: string): void {
    const decision = policy.decide(relativePath);
    expect(decision, relativePath).toEqual({ decision: "blocked", reason: "excluded" });
  }

  function expectAllowed(relativePath: string): void {
    expect(policy.decide(relativePath), relativePath).toEqual({ decision: "allowed" });
  }

  it("blocks .env files at any depth", () => {
    expectSensitive(".env");
    expectSensitive("src/.env");
    expectSensitive("deep/nested/.env");
  });

  it("blocks .env.* variants", () => {
    expectSensitive(".env.local");
    expectSensitive("config/.env.production");
  });

  it("blocks private key patterns", () => {
    expectSensitive("id_rsa");
    expectSensitive("keys/id_rsa");
    expectSensitive("deep/.ssh/id_ed25519");
    expectSensitive("server.pem");
    expectSensitive("certs/localhost.key");
  });

  it("blocks .ssh content", () => {
    expectSensitive(".ssh");
    expectSensitive(".ssh/authorized_keys");
    expectSensitive("home/user/.ssh/config");
  });

  it("blocks .git content", () => {
    expectSensitive(".git");
    expectSensitive(".git/config");
    expectSensitive(".git/objects/ab/cdef");
  });

  it("blocks credential stores", () => {
    expectSensitive(".aws/credentials");
    expectSensitive("users/home/.aws/credentials");
    expectSensitive(".npmrc");
    expectSensitive(".pypirc");
    expectSensitive("credentials.json");
    expectSensitive("src/credentials.json");
    expectSensitive("service-account.json");
    expectSensitive("deploy/service-account-prod.json");
  });

  it("blocks dependency and build trees as excluded", () => {
    expectExcluded("node_modules");
    expectExcluded("node_modules/pkg/index.js");
    expectExcluded("dist/bundle.js");
    expectExcluded("packages/app/dist/x.js");
    expectExcluded("build/output.txt");
    expectExcluded(".next/static/x.js");
    expectExcluded("coverage/lcov.info");
    expectExcluded("target/debug/app");
    expectExcluded("vendor/lib.go");
  });

  it("allows the workspace root and ordinary source files", () => {
    expectAllowed(".");
    expectAllowed("src/index.ts");
    expectAllowed("docs/security-model.md");
    expectAllowed("package.json");
  });

  it("does not use naive substring rules on common source names", () => {
    expectAllowed("src/token.ts");
    expectAllowed("src/secret-manager.ts");
    expectAllowed("src/credentials.ts");
    expectAllowed("env/example.env.txt");
    expectAllowed("src/envdir/load.ts");
    expectAllowed("keys/id_rsa.pub.txt");
  });

  it("matches the documented pattern list precisely", () => {
    // Filenames that are close to, but not, the documented patterns stay
    // available so legitimate code remains reviewable.
    expectAllowed(".envdir");
    expectAllowed("id_rsa2");
    expectAllowed("src/id_rsa.backup");
    expectAllowed("x.pem.txt");
    expectAllowed("my.keyring");
    expectAllowed("service-account-json.txt");
    expectAllowed("src/git/config.ts");
  });
});

describe("compilePattern", () => {
  it("rejects structurally invalid patterns", () => {
    expect(() => compilePattern("")).toThrow();
    expect(() => compilePattern("/absolute")).toThrow();
    expect(() => compilePattern("a//b")).toThrow();
    expect(() => compilePattern("trailing/")).toThrow();
  });

  it("treats ** as zero or more directories", () => {
    const compiled = compilePattern("**/id_rsa");
    const match = (p: string): boolean => {
      const policy = new AccessPolicy({ sensitivePatterns: ["**/id_rsa"], excludedPatterns: [] });
      return policy.decide(p).decision === "blocked";
    };
    expect(match("id_rsa")).toBe(true);
    expect(match("a/b/id_rsa")).toBe(true);
    void compiled;
  });
});
