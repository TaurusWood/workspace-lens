import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../../src/core/errors.js";
import { validateRelativePath } from "../../src/core/path-resolver.js";

/** Path syntax contract (`mcp-tools-spec.md` §3.2). */
describe("validateRelativePath", () => {
  const validCases: Array<[string, string]> = [
    [".", "."],
    ["src", "src"],
    ["src/index.ts", "src/index.ts"],
    ["packages/api/src/server.ts", "packages/api/src/server.ts"],
    ["src/./index.ts", "src/index.ts"],
    ["./src", "src"],
    ["src/", "src"],
    ["src//index.ts", "src/index.ts"],
    ["...", "..."], // '..'-prefixed names are legal filenames
    ["src/..hidden.ts", "src/..hidden.ts"],
  ];

  it.each(validCases)("accepts %j and normalizes to %j", (input, expected) => {
    expect(validateRelativePath(input)).toBe(expected);
  });

  const invalidCases: Array<[string, string]> = [
    ["", "empty"],
    ["/Users/me/project/src/index.ts", "absolute Unix path"],
    ["/", "absolute root"],
    ["//server/share", "UNC-style double slash"],
    ["../secret", "parent traversal"],
    ["src/../../secret", "embedded traversal"],
    ["src/../..", "double traversal"],
    ["a\0b", "NUL character"],
    ["src\\index.ts", "backslash separator"],
    ["\\server\\share\\file", "UNC path"],
    ["C:\\Users\\me\\secret", "Windows drive path"],
    ["C:/Users/me/secret", "Windows drive path with slashes"],
    ["c:/x", "lowercase drive path"],
    ["x".repeat(4097), "overlong path"],
  ];

  it.each(invalidCases)("rejects %j (%s)", (input) => {
    try {
      validateRelativePath(input);
      expect.unreachable(`expected rejection: ${JSON.stringify(input.slice(0, 40))}`);
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe("PATH_INVALID");
    }
  });
});
