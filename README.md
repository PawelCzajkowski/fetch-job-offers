# fetch-job-offers

A personal command-line tool that fetches job offers from LinkedIn, has an OpenAI model judge each one against the kind of work you're looking for, and writes a Markdown and an HTML report of the offers it hasn't shown you before.

It uses LinkedIn's public guest pages, so no LinkedIn account is needed. It remembers what it has shown you, so each run reports only new offers.

## Requirements

- Node.js 24 or later (`.nvmrc` pins 24)
- pnpm
- An OpenAI API key. A run of 50 offers costs a few cents with the default model, `gpt-6-luna`.

## Install

```sh
git clone https://github.com/PawelCzajkowski/fetch-job-offers.git
cd fetch-job-offers
pnpm install
```

Node runs the TypeScript sources directly, so there's no build step. Run the tool with:

```sh
node src/cli.ts --help
```

To get `fetch-job-offers` and its short alias `fjo` as global commands, run `pnpm link --global` once. It needs pnpm's global bin directory on your `PATH`; `pnpm setup` configures that. The examples below use `fjo`.

## Set up

Pick a directory to run the tool from; the reports and the list of seen offers are written there. Then:

```sh
fjo init
```

This writes four files and never overwrites one that already exists:

- `fetch-job-offers.config.json`: your saved searches, starting with one example
- `config.schema.json`: gives your editor autocomplete and validation for the config
- `.env.example`: a template for your API key
- `.gitignore` entries for `.env`, `reports/` and `seen.json`

Add your key:

```sh
cp .env.example .env
# edit .env: OPENAI_API_KEY=sk-...
```

The key is read from `.env` next to the config file, or from your environment, which wins. It's never read from the config.

## Configure your searches

Edit `fetch-job-offers.config.json`:

```json
{
  "$schema": "./config.schema.json",
  "model": "gpt-6-luna",
  "outputDir": "reports",
  "seenStore": "seen.json",
  "searches": [
    {
      "name": "java-warsaw",
      "keywords": "Java Backend Developer",
      "location": "Warsaw, Poland",
      "postedWithin": "7d",
      "maxOffers": 100,
      "profile": "Java development"
    }
  ]
}
```

Each saved search has:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | A unique slug, e.g. `java-warsaw`. Used with `--search` and shown in the reports. |
| `keywords` | yes | What LinkedIn searches for, as you'd type it on the site. |
| `location` | yes | Free-text location, e.g. `Warsaw, Poland`. Without one, LinkedIn returns mostly US offers. |
| `profile` | yes | A short statement of the work you want, e.g. `Java development`. The model accepts an offer only when its main day-to-day work matches. |
| `postedWithin` | no | How far back to look: `<n>h` or `<n>d`, e.g. `24h`, `3d`. Default `7d`. |
| `maxOffers` | no | The most new offers to judge per run. Default `100`. |

`outputDir` and `seenStore` are relative to the config file. Unknown or misspelled keys are an error, reported with their path (e.g. `searches[0].postedWithn`).

LinkedIn's guest search can only filter by keywords, location and posting date. Work mode (remote, hybrid, on-site), seniority and tech stack are read from each offer by the model and shown in the reports, where you can filter on them.

## Run it

```sh
fjo                                   # run every saved search
fjo --search java-warsaw              # run one saved search (repeatable)
fjo --search java-warsaw --location Berlin   # tweak a saved search for this run
fjo --keywords "TypeScript" --location "Poland" --profile "TypeScript development"
                                      # an ad-hoc search; works without a config
fjo --max-offers 5                    # a small first run
```

While it runs, progress goes to stderr: one line per search, per results page and per judged offer, e.g. `✓ accepted  Senior Java Dev @ Acme`. At the end, a summary goes to stdout with the counts per search, the tokens used, the estimated cost and the report paths.

A run is polite to LinkedIn: one request at a time, a second apart, with retries on errors. Press Ctrl-C once to stop cleanly. The offers handled so far are saved and reported. Press it again to quit at once.

## The reports

Each run that finds new offers writes two files into `reports/`:

- `YYYY-MM-DD_HHmm.html`: open it in a browser. It's a table of every offer from the run, filterable by verdict (Accepted by default), search, work mode and text, and sortable by column. Click a row for the reason, details, description, an **Open on LinkedIn** link and a **Copy description** button. It works offline.
- `YYYY-MM-DD_HHmm.md`: the same offers as a Markdown table plus a details section.

`reports/latest.html` and `reports/latest.md` always hold the most recent run, so there's one file to bookmark. When a run finds nothing new, no report is written and the summary says so.

## Seen offers and re-runs

`seen.json` remembers every offer shown to you, per profile. A later run skips those offers, so it costs nothing to re-run often. An offer counts as seen only under the profile it was judged against, so changing a search's profile wording judges its offers again from scratch.

| Flag | Effect |
|---|---|
| `--all` | Also show offers seen before, with their stored verdicts (not judged again). |
| `--rejudge` | Judge again the offers that couldn't be judged last time (for example after an OpenAI error). |
| `--dry-run` | Judge and write the timestamped reports, but don't update `seen.json` or `latest.*`. |
| `--verbose` | Log every LinkedIn request. |
| `--model <name>`, `--out <dir>`, `--config <path>` | Override the model, the report directory or the config file for this run. |

To judge everything again after changing the model or the prompt, delete `seen.json`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every search completed. |
| 1 | A fatal error before any work (bad flags or config, missing key, corrupt `seen.json`, unwritable output), or the report couldn't be written. |
| 2 | A search stopped partway (LinkedIn kept failing), or LinkedIn kept rate-limiting and the run stopped. What was handled is saved and reported; run again later. |
| 130 | Stopped with Ctrl-C. What was handled is saved and reported. |

## Development

```sh
pnpm verify    # typecheck, lint and format check, and tests; CI runs the same
pnpm test      # tests only (Vitest)
pnpm schema    # regenerate config.schema.json after changing the config schema
```

Tests never touch the network: they use saved LinkedIn pages in `test/fixtures/` and a fake OpenAI client. The domain vocabulary is in [`CONTEXT.md`](CONTEXT.md), and the design decisions are in [`docs/adr/`](docs/adr/).
