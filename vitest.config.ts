import { defineConfig } from "vitest/config";

// Only the repo's own test tree. Agent worktrees under .claude/worktrees/
// hold full copies of the repo, and Vitest would otherwise run their tests too.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
