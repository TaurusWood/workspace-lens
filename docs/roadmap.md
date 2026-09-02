# WorkspaceLens Roadmap

## Phase 0 - Concept Validation

Goal:

Verify the complete path from AI assistant to local workspace.

Tasks:

- Implement minimal MCP server
- Expose one read operation
- Validate local connection workflow
- Confirm security boundaries

## Phase 1 - MVP

Goal:

Provide a reliable read-only workspace reviewer capability.

Features:

### Workspace Management

- Register local workspace roots
- List available workspaces
- Provide project metadata

### File Access

- Directory browsing
- File reading
- Workspace search

### Git Awareness

- Current branch
- Working tree status
- Local diff inspection

### Security

- Workspace whitelist
- Sensitive file deny list
- File size limits
- Path traversal protection

## Phase 2 - Developer Experience

Possible improvements:

- Automatic project type detection
- Better workspace summaries
- Improved search performance
- Configuration file support
- Packaging and installation workflow

## Phase 3 - Advanced Context

Potential future exploration:

- Dependency graph analysis
- Symbol-aware navigation
- Architecture summaries
- Framework-specific understanding

These features should only be added when they provide clear value without compromising simplicity.

## Current Priority

The immediate objective is not feature expansion.

The priority is:

1. Secure access
2. Stable MCP integration
3. Accurate workspace understanding
4. Excellent review workflow
