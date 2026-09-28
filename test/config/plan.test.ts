import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, ConfigError } from "../../src/config/load.ts";
import {
  type Command,
  CommandLineError,
  parseCommandLine,
  planCommand,
  type RunPlan,
  resolveCommand,
} from "../../src/config/plan.ts";

const cwd = "/work";

const javaWarsaw = {
  name: "java-warsaw",
  keywords: "Java Backend Developer",
  location: "Warsaw, Poland",
  postedWithin: "7d",
  maxOffers: 100,
  profile: "Java development",
};

const tsRemote = {
  name: "ts-remote",
  keywords: "TypeScript Developer",
  location: "European Union",
  postedWithin: "24h",
  maxOffers: 30,
  profile: "TypeScript development",
};

const config: Config = {
  model: "gpt-6-luna",
  outputDir: "/configs/reports",
  seenStore: "/configs/seen.json",
  searches: [javaWarsaw, tsRemote],
};

function plan(argv: string[], loaded: Config | "no-config" = config): RunPlan {
  const command = planCommand(argv, loaded, cwd);
  if (command.kind !== "run")
    throw new Error(`expected run, got ${command.kind}`);
  return command.plan;
}

function planError(
  argv: string[],
  loaded: Config | "no-config" = config,
): CommandLineError {
  let error: unknown;
  try {
    planCommand(argv, loaded, cwd);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CommandLineError);
  return error as CommandLineError;
}

const adHocFlags = [
  "--keywords",
  "Rust Developer",
  "--location",
  "Berlin",
  "--profile",
  "Rust development",
];

describe("planCommand: commands", () => {
  it("detects --help and -h", () => {
    expect(planCommand(["--help"], "no-config", cwd)).toEqual({ kind: "help" });
    expect(planCommand(["-h"], "no-config", cwd)).toEqual({ kind: "help" });
  });

  it("reports help even when other flags are invalid in combination", () => {
    expect(
      planCommand(["--help", "--keywords", "x"], "no-config", cwd),
    ).toEqual({ kind: "help" });
  });

  it("detects init as the first positional", () => {
    expect(planCommand(["init"], "no-config", cwd)).toEqual({ kind: "init" });
  });

  it("reports help for init --help", () => {
    expect(planCommand(["init", "--help"], "no-config", cwd)).toEqual({
      kind: "help",
    });
  });

  it("rejects options on init", () => {
    expect(planError(["init", "--verbose"]).message).toMatch(/init/);
  });

  it("rejects extra positionals", () => {
    expect(planError(["init", "extra"]).message).toMatch(/"extra"/);
    expect(planError(["run"]).message).toMatch(/"run"/);
  });

  it.each([
    ["an unknown flag", "--nope"],
    ["a string flag without a value", "--keywords"],
  ])("rejects %s", (_case, flag) => {
    expect(planError([flag]).message).toContain(flag);
  });
});

describe("planCommand: saved searches", () => {
  it("runs every saved search with the config's options by default", () => {
    expect(plan([])).toEqual({
      searches: [
        { label: "java-warsaw", ...withoutName(javaWarsaw) },
        { label: "ts-remote", ...withoutName(tsRemote) },
      ],
      options: {
        model: "gpt-6-luna",
        outputDir: "/configs/reports",
        seenStore: "/configs/seen.json",
        all: false,
        rejudge: false,
        dryRun: false,
        verbose: false,
      },
      configFile: "/work/fetch-job-offers.config.json",
    });
  });

  it("selects saved searches with --search, in config order", () => {
    const { searches } = plan([
      "--search",
      "ts-remote",
      "--search",
      "java-warsaw",
    ]);
    expect(searches.map((s) => s.label)).toEqual(["java-warsaw", "ts-remote"]);
  });

  it("runs a search named twice only once", () => {
    const { searches } = plan([
      "--search",
      "ts-remote",
      "--search",
      "ts-remote",
    ]);
    expect(searches.map((s) => s.label)).toEqual(["ts-remote"]);
  });

  it("rejects an unknown --search name, listing the known ones", () => {
    const { message } = planError(["--search", "nope"]);
    expect(message).toMatch(/"nope"/);
    expect(message).toMatch(/java-warsaw, ts-remote/);
  });

  it("lets criteria flags override the selected searches", () => {
    const { searches } = plan([
      "--search",
      "java-warsaw",
      "--search",
      "ts-remote",
      "--location",
      "Berlin",
      "--posted-within",
      "3d",
      "--max-offers",
      "5",
    ]);
    expect(searches).toEqual([
      {
        ...withoutName(javaWarsaw),
        label: "java-warsaw",
        location: "Berlin",
        postedWithin: "3d",
        maxOffers: 5,
      },
      {
        ...withoutName(tsRemote),
        label: "ts-remote",
        location: "Berlin",
        postedWithin: "3d",
        maxOffers: 5,
      },
    ]);
  });

  it("overrides keywords and profile too", () => {
    const [search] = plan([
      "--search",
      "java-warsaw",
      "--keywords",
      "Kotlin",
      "--profile",
      "Kotlin development",
    ]).searches;
    expect(search).toMatchObject({
      keywords: "Kotlin",
      profile: "Kotlin development",
    });
  });

  it("fails when the config has no saved searches and no ad-hoc search is given", () => {
    const { message } = planError([], { ...config, searches: [] });
    expect(message).toMatch(/no saved searches/);
    expect(message).toMatch(/--keywords, --location and --profile/);
  });
});

describe("planCommand: ad-hoc search", () => {
  it("replaces the saved searches, with schema defaults", () => {
    const result = plan(adHocFlags);
    expect(result.searches).toEqual([
      {
        label: "ad-hoc",
        keywords: "Rust Developer",
        location: "Berlin",
        postedWithin: "7d",
        maxOffers: 100,
        profile: "Rust development",
      },
    ]);
    expect(result.options.outputDir).toBe("/configs/reports");
  });

  it("takes --posted-within and --max-offers", () => {
    const [search] = plan([
      ...adHocFlags,
      "--posted-within",
      "1h",
      "--max-offers",
      "10",
    ]).searches;
    expect(search).toMatchObject({ postedWithin: "1h", maxOffers: 10 });
  });

  it("works with no config file, using defaults relative to the current directory", () => {
    expect(plan(adHocFlags, "no-config")).toEqual({
      searches: [
        {
          label: "ad-hoc",
          keywords: "Rust Developer",
          location: "Berlin",
          postedWithin: "7d",
          maxOffers: 100,
          profile: "Rust development",
        },
      ],
      options: {
        model: "gpt-6-luna",
        outputDir: "/work/reports",
        seenStore: "/work/seen.json",
        all: false,
        rejudge: false,
        dryRun: false,
        verbose: false,
      },
      configFile: null,
    });
  });

  it("requires --keywords, --location and --profile", () => {
    const { message } = planError(["--keywords", "Rust"]);
    expect(message).toMatch(/ad-hoc search/);
    expect(message).toMatch(/--location/);
    expect(message).toMatch(/--profile/);
    expect(message).not.toMatch(/--keywords:/);
  });

  it("is triggered by --max-offers or --posted-within alone", () => {
    expect(planError(["--max-offers", "5"]).message).toMatch(/ad-hoc search/);
    expect(planError(["--posted-within", "1d"]).message).toMatch(
      /ad-hoc search/,
    );
  });
});

describe("planCommand: flag validation", () => {
  it.each([
    ["--posted-within", "7", /--posted-within.*duration/],
    ["--posted-within", "0d", /--posted-within.*duration/],
    ["--posted-within", "2w", /--posted-within.*duration/],
    ["--max-offers", "0", /--max-offers.*positive integer/],
    ["--max-offers", "-3", /--max-offers.*positive integer/],
    ["--max-offers", "1.5", /--max-offers.*positive integer/],
    ["--max-offers", "ten", /--max-offers.*positive integer/],
    ["--keywords", "", /--keywords.*empty/],
    ["--location", "", /--location.*empty/],
    ["--profile", "", /--profile.*empty/],
    ["--model", "", /--model.*empty/],
    ["--out", "", /--out.*empty/],
    ["--search", "", /--search.*empty/],
  ])("rejects %s %j", (flag, value, pattern) => {
    // `=` keeps values like "-3" and "" attached; the flag comes last so it wins.
    expect(planError([...adHocFlags, `${flag}=${value}`]).message).toMatch(
      pattern,
    );
  });

  it("reports every invalid flag at once", () => {
    const { message } = planError([
      ...adHocFlags,
      "--posted-within",
      "x",
      "--max-offers",
      "0",
    ]);
    expect(message).toMatch(/--posted-within/);
    expect(message).toMatch(/--max-offers/);
  });
});

describe("planCommand: global flags", () => {
  it("overrides model and outputDir; --out resolves against the current directory", () => {
    const { options } = plan(["--model", "gpt-7", "--out", "out/today"]);
    expect(options.model).toBe("gpt-7");
    expect(options.outputDir).toBe("/work/out/today");
    expect(options.seenStore).toBe("/configs/seen.json");
  });

  it("keeps an absolute --out as is", () => {
    expect(plan(["--out", "/tmp/r"]).options.outputDir).toBe("/tmp/r");
  });

  it("carries --all, --rejudge, --dry-run and --verbose", () => {
    expect(
      plan(["--all", "--rejudge", "--dry-run", "--verbose"]).options,
    ).toMatchObject({ all: true, rejudge: true, dryRun: true, verbose: true });
  });

  it("reports the --config path, resolved against the current directory", () => {
    expect(plan(["--config", "cfg/my.json"]).configFile).toBe(
      "/work/cfg/my.json",
    );
  });
});

describe("planCommand: no config file", () => {
  it("fails without an ad-hoc search, pointing to init", () => {
    const { message } = planError([], "no-config");
    expect(message).toMatch(/fetch-job-offers init/);
    expect(message).toMatch(/\/work\/fetch-job-offers\.config\.json/);
  });

  it("names the --config path in the error", () => {
    const { message } = planError(["--config", "x.json"], "no-config");
    expect(message).toMatch(/\/work\/x\.json/);
  });
});

describe("parseCommandLine", () => {
  it("returns the flags of a run without needing the config", () => {
    const parsed = parseCommandLine(["--config", "a.json", "--search", "s"]);
    expect(parsed).toMatchObject({
      kind: "run",
      flags: { config: "a.json", search: ["s"] },
    });
  });
});

describe("resolveCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fjo-plan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the default config file from the current directory", async () => {
    await writeFile(
      join(dir, "fetch-job-offers.config.json"),
      JSON.stringify({ searches: [javaWarsaw] }),
    );
    const command = await resolveCommand([], dir);
    expect(command).toMatchObject({
      kind: "run",
      plan: {
        searches: [{ label: "java-warsaw" }],
        options: { outputDir: join(dir, "reports") },
        configFile: join(dir, "fetch-job-offers.config.json"),
      },
    });
  });

  it("loads --config relative to the current directory", async () => {
    await writeFile(
      join(dir, "other.json"),
      JSON.stringify({ model: "m", searches: [javaWarsaw] }),
    );
    const command = await resolveCommand(["--config", "other.json"], dir);
    expect(command).toMatchObject({
      kind: "run",
      plan: { options: { model: "m" } },
    });
  });

  it("treats a missing default config file as no config", async () => {
    const command = await resolveCommand(adHocFlags, dir);
    expect(command).toMatchObject({
      kind: "run",
      plan: { configFile: null, options: { outputDir: join(dir, "reports") } },
    });
    await expect(resolveCommand([], dir)).rejects.toThrow(/init/);
  });

  it("throws when the --config file is missing", async () => {
    const error = await resolveCommand(
      ["--config", "typo.json", ...adHocFlags],
      dir,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).reason).toBe("not-found");
  });

  it("still throws other config errors", async () => {
    await writeFile(join(dir, "fetch-job-offers.config.json"), "{");
    await expect(resolveCommand(adHocFlags, dir)).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("doesn't load the config for help or init", async () => {
    await writeFile(join(dir, "fetch-job-offers.config.json"), "{");
    const help: Command = await resolveCommand(["--help"], dir);
    expect(help).toEqual({ kind: "help" });
    await expect(resolveCommand(["init"], dir)).resolves.toEqual({
      kind: "init",
    });
  });
});

function withoutName<T extends { name: string }>({ name: _name, ...rest }: T) {
  return rest;
}
