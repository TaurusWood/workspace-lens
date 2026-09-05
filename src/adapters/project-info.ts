/**
 * Project-info adapter — best-effort, evidence-based project type and
 * technology inference for `workspace_info` (`mcp-tools-spec.md` §7,
 * `implementation-plan.md` §14).
 *
 * Detection is intentionally shallow: marker files at the workspace root
 * only. No AST parsing, no dependency installation, no deep framework
 * inspection. AccessPolicy gates every evidence probe.
 */
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { AccessPolicy } from "../core/access-policy.js";

export type Confidence = "low" | "medium" | "high";

export interface ProjectType {
  name: string;
  confidence: Confidence;
  evidence: string[];
}

export interface Technology {
  name: string;
  category: "language" | "runtime" | "tool";
  confidence: Confidence;
  evidence: string[];
}

export interface ProjectInfo {
  inferred: boolean;
  types: ProjectType[];
  technologies: Technology[];
}

export interface ProjectInfoAdapterOptions {
  policy: AccessPolicy;
}

interface DetectionRule {
  marker: string;
  type?: { name: string; confidence: Confidence };
  technology?: { name: string; category: Technology["category"]; confidence: Confidence };
}

const DETECTION_RULES: readonly DetectionRule[] = [
  { marker: "package.json", type: { name: "node", confidence: "high" }, technology: { name: "JavaScript", category: "language", confidence: "medium" } },
  { marker: "tsconfig.json", technology: { name: "TypeScript", category: "language", confidence: "high" } },
  { marker: "pyproject.toml", type: { name: "python", confidence: "high" }, technology: { name: "Python", category: "language", confidence: "high" } },
  { marker: "requirements.txt", type: { name: "python", confidence: "medium" }, technology: { name: "Python", category: "language", confidence: "medium" } },
  { marker: "go.mod", type: { name: "go", confidence: "high" }, technology: { name: "Go", category: "language", confidence: "high" } },
  { marker: "Cargo.toml", type: { name: "rust", confidence: "high" }, technology: { name: "Rust", category: "language", confidence: "high" } },
  { marker: "pom.xml", type: { name: "java", confidence: "medium" }, technology: { name: "Maven", category: "tool", confidence: "high" } },
  { marker: "build.gradle", type: { name: "java", confidence: "medium" }, technology: { name: "Gradle", category: "tool", confidence: "high" } },
];

export class ProjectInfoAdapter {
  private readonly policy: AccessPolicy;

  constructor(options: ProjectInfoAdapterOptions) {
    this.policy = options.policy;
  }

  async detect(root: string): Promise<ProjectInfo> {
    const types: ProjectType[] = [];
    const technologies: Technology[] = [];

    for (const rule of DETECTION_RULES) {
      // Evidence markers are workspace-relative root files; the shared
      // policy must allow them before they are probed.
      if (!this.policy.isAllowed(rule.marker)) {
        continue;
      }
      let exists = false;
      try {
        exists = (await fsPromises.lstat(path.join(root, rule.marker))).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        continue;
      }
      if (rule.type !== undefined) {
        types.push({ name: rule.type.name, confidence: rule.type.confidence, evidence: [rule.marker] });
      }
      if (rule.technology !== undefined) {
        technologies.push({
          name: rule.technology.name,
          category: rule.technology.category,
          confidence: rule.technology.confidence,
          evidence: [rule.marker],
        });
      }
    }

    return {
      inferred: types.length > 0 || technologies.length > 0,
      types,
      technologies,
    };
  }
}
