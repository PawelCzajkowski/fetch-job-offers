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
  --dry-run               Judge and report, but don't touch the seen store
  --verbose               Log every LinkedIn request
  --help, -h              Show this help text
`;
