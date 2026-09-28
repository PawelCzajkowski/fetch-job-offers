#!/usr/bin/env node
import OpenAI from "openai";
import { abortOnInterrupt } from "./interrupt.ts";
import { main } from "./main.ts";

// The real process wired into `main`; everything else lives there.
const stdout = (text: string) => void process.stdout.write(text);
const stderr = (text: string) => void process.stderr.write(text);

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
  new Promise<void>((resolve) => stream.write("", () => resolve()));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
