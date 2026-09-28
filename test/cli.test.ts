import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve("src/cli.ts");

// The real entry point, spawned. Only paths that end before any network
// request are exercised here; the run itself is covered through `main`.
function runCli(args: string[], cwd = process.cwd()) {
  // Never let a real key from the developer's shell reach the child.
  const { OPENAI_API_KEY: _ignored, ...env } = process.env;
  const result = spawnSync("node", [CLI, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fjo-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

  it("fails with the init hint when run with no config", () => {
    const { stdout, stderr, status } = runCli([], dir);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("fetch-job-offers init");
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it("writes the starter files with init", () => {
    const { stdout, status } = runCli(["init"], dir);
    expect(status).toBe(0);
    expect(stdout).toContain("created  fetch-job-offers.config.json");
  });

  it("loads .env with process.loadEnvFile and fails without a key", async () => {
    runCli(["init"], dir);
    await writeFile(join(dir, ".env"), "SOMETHING_ELSE=1\n");
    const { stderr, status } = runCli([], dir);
    expect(status).toBe(1);
    expect(stderr).toContain("OPENAI_API_KEY is not set");
  });
});
