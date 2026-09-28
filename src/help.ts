export const HELP_TEXT = `fetch-job-offers - fetch LinkedIn job offers, judge them, and report the new ones

Usage:
  fetch-job-offers [options]
  fetch-job-offers init
  fjo [options]

Commands:
  init                    Write a starter config, schema, .env.example and .gitignore entries

Selecting searches:
  --search <name>         Run only this saved search (repeatable)

Criteria flags (override the selected searches, or define an ad-hoc search
without --search; an ad-hoc search needs --keywords, --location and --profile):
  --keywords <text>       Job title / keywords
  --location <text>       Location
  --posted-within <dur>   How far back to search, e.g. 1h, 24h, 3d, 7d
  --profile <text>        The kind of work offers are judged against
  --max-offers <n>        Stop after this many new offers

Global flags:
  --model <name>          OpenAI model to judge with
  --out <dir>             Report output directory
  --config <path>         Path to the config file
  --all                   Include offers already seen, with their stored verdict
  --rejudge               Retry unjudged offers from this run's results
  --dry-run               Judge and write timestamped reports, but don't touch
                          the seen store or latest.*
  --verbose               Log every LinkedIn request
  --help, -h              Show this help text

Environment:
  OPENAI_API_KEY          Required for a run. Read from the environment, or from
                          a .env file next to the config (or in the current
                          directory without one); the environment wins.

Exit codes:
  0    Every search completed
  1    Fatal error before any work (bad flags or config, no key, corrupt store,
       unwritable output), or the report couldn't be written
  2    A search was partial, or LinkedIn kept rate-limiting and the run stopped
  130  Stopped by Ctrl-C (the store and report are still written; press it
       again to quit at once)
`;
