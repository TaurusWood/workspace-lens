/**
 * AccessPolicy — the single shared decision layer for every content-bearing
 * operation (`security-model.md` §4.5, §6; `mcp-tools-spec.md` §5.2).
 *
 * It classifies a workspace-relative path as:
 *   allowed                       — accessible through read tools
 *   blocked (sensitive)           — credential/secret store, default deny
 *   blocked (excluded)            — dependency/build trees, data minimization
 *
 * A file blocked here cannot be read, listed, searched, or diffed through
 * any tool. There is no MCP-level override for sensitive paths.
 */

export type PolicyDecision =
  | { decision: "allowed" }
  | { decision: "blocked"; reason: "sensitive" | "excluded" };

const ALLOWED: PolicyDecision = { decision: "allowed" };

/**
 * Default-deny sensitive patterns (`security-model.md` §6.1). Patterns use
 * `/`-separated segments where `**` matches zero or more directories and
 * `*` matches within one segment.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/.ssh/**",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
  "**/.aws/credentials",
  "**/.npmrc",
  "**/.pypirc",
  "**/credentials.json",
  "**/service-account*.json",
  "**/.git/**",
];

/**
 * Default dependency/build exclusions (`security-model.md` §6.2).
 * Non-sensitive; a future local configuration may override them.
 */
export const DEFAULT_EXCLUDED_PATTERNS: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/target/**",
  "**/vendor/**",
];

export interface AccessPolicyOptions {
  sensitivePatterns?: readonly string[];
  excludedPatterns?: readonly string[];
}

type PatternSegment =
  | { kind: "doublestar" }
  | { kind: "segment"; test: (segment: string) => boolean };

export interface CompiledPattern {
  readonly source: string;
  readonly segments: PatternSegment[];
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function compileSegment(segment: string): (value: string) => boolean {
  let source = "^";
  for (const ch of segment) {
    if (ch === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegexChar(ch);
    }
  }
  source += "$";
  const regex = new RegExp(source);
  return (value: string) => regex.test(value);
}

export function compilePattern(pattern: string): CompiledPattern {
  if (pattern.length === 0 || pattern.startsWith("/") || pattern.endsWith("/")) {
    throw new Error(`Invalid access-policy pattern: ${JSON.stringify(pattern)}`);
  }
  const segments: PatternSegment[] = [];
  for (const raw of pattern.split("/")) {
    if (raw === "") {
      throw new Error(`Invalid access-policy pattern: ${JSON.stringify(pattern)}`);
    }
    if (raw === "**") {
      segments.push({ kind: "doublestar" });
    } else {
      segments.push({ kind: "segment", test: compileSegment(raw) });
    }
  }
  return { source: pattern, segments };
}

function matchPattern(compiled: CompiledPattern, pathSegments: readonly string[]): boolean {
  const segments = compiled.segments;

  const matchFrom = (patternIndex: number, segmentIndex: number): boolean => {
    if (patternIndex === segments.length) {
      return segmentIndex === pathSegments.length;
    }
    const segment = segments[patternIndex]!;
    if (segment.kind === "doublestar") {
      // `**` matches zero or more directories.
      for (let skip = segmentIndex; skip <= pathSegments.length; skip += 1) {
        if (matchFrom(patternIndex + 1, skip)) {
          return true;
        }
      }
      return false;
    }
    if (segmentIndex === pathSegments.length) {
      return false;
    }
    return segment.test(pathSegments[segmentIndex]!) && matchFrom(patternIndex + 1, segmentIndex + 1);
  };

  return matchFrom(0, 0);
}

export class AccessPolicy {
  private readonly sensitiveMatchers: CompiledPattern[];
  private readonly excludedMatchers: CompiledPattern[];

  constructor(options: AccessPolicyOptions = {}) {
    this.sensitiveMatchers = (options.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS).map(
      compilePattern,
    );
    this.excludedMatchers = (options.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS).map(
      compilePattern,
    );
  }

  /** Decide access for a normalized workspace-relative path (or `.`). */
  decide(relativePath: string): PolicyDecision {
    if (relativePath === "." || relativePath === "") {
      return ALLOWED;
    }
    const pathSegments = relativePath.split("/");
    for (const matcher of this.sensitiveMatchers) {
      if (matchPattern(matcher, pathSegments)) {
        return { decision: "blocked", reason: "sensitive" };
      }
    }
    for (const matcher of this.excludedMatchers) {
      if (matchPattern(matcher, pathSegments)) {
        return { decision: "blocked", reason: "excluded" };
      }
    }
    return ALLOWED;
  }

  isAllowed(relativePath: string): boolean {
    return this.decide(relativePath).decision === "allowed";
  }
}
