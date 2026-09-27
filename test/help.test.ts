import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../src/help.ts";

describe("HELP_TEXT", () => {
  it("names the command and shows usage", () => {
    expect(HELP_TEXT).toContain("fetch-job-offers");
    expect(HELP_TEXT).toContain("Usage");
  });

  it("documents the init subcommand and the global flags", () => {
    expect(HELP_TEXT).toContain("init");
    expect(HELP_TEXT).toContain("--search");
    expect(HELP_TEXT).toContain("--dry-run");
    expect(HELP_TEXT).toContain("--all");
    expect(HELP_TEXT).toContain("--rejudge");
  });
});
