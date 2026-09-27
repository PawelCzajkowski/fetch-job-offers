import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["src/cli.ts", ...args], {
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { stdout: string; status: number };
    return { stdout: e.stdout, status: e.status };
  }
}

describe("cli", () => {
  it("prints help text and exits 0 for --help", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("fetch-job-offers");
    expect(stdout).toContain("Usage");
  });

  it("prints the same help text for -h", () => {
    const { stdout, status } = runCli(["-h"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage");
  });
});
