#!/usr/bin/env node
import OpenAI from "openai";
import { abortOnInterrupt } from "./interrupt.ts";
import { main } from "./main.ts";

// The real process wired into `main`; everything else lives there.

// A reader that goes away early (`fjo | head`) closes the pipe. Stop writing
// to that stream instead of crashing on EPIPE; the run itself carries on, so
// the store and the reports are still written and the exit code is kept.
const closed = new Set<NodeJS.WriteStream>();
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    closed.add(stream);
  });
}
const writer = (stream: NodeJS.WriteStream) => (text: string) => {
  if (!closed.has(stream)) stream.write(text);
};
const stdout = writer(process.stdout);
const stderr = writer(process.stderr);

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout,
  stderr,
  vars: process.env,
  loadEnvFile: (path) => process.loadEnvFile(path),
  fetch: globalThis.fetch,
  createJudgeClient: (apiKey) => new OpenAI({ apiKey }),
  now: () => new Date(),
  signal: abortOnInterrupt({ process, exit: (n) => process.exit(n), stderr }),
});

// Exit once stdout and stderr have flushed, so a piped summary isn't cut off.
const flushed = (stream: NodeJS.WriteStream) =>
  closed.has(stream)
    ? Promise.resolve()
    : new Promise<void>((resolve) => stream.write("", () => resolve()));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
