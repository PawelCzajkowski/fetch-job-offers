#!/usr/bin/env node
import { HELP_TEXT } from "./help.ts";

function main(argv: string[]): void {
  // Placeholder CLI: only --help is wired up so far. Later tickets add the
  // `init` subcommand, flag parsing and the run itself (see the spec).
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  console.error(HELP_TEXT);
  process.exit(1);
}

main(process.argv.slice(2));
