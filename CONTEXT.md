# Fetch Job Offers

A personal tool that pulls job offers from LinkedIn, has an LLM judge each one against the user's profile, and reports only the offers it has not shown before.

## Language

### Searching

**Offer**:
A single job posting on LinkedIn, identified by its LinkedIn job ID.
_Avoid_: Job, posting, listing, ad

**Search criteria**:
The set of filters sent to LinkedIn: title, location, date posted and work mode.
_Avoid_: Query, filters, params

**Saved search**:
A named search kept in the user's config: its search criteria plus the profile its offers are judged against, so a run can repeat it without retyping.
_Avoid_: Preset, search profile

**Ad-hoc search**:
A one-off search defined entirely on the command line for a single run, replacing the saved searches for that run.
_Avoid_: Temporary search, quick search

**Work mode**:
Where the work happens: remote, hybrid or on-site.
_Avoid_: Workplace type, location type

### Judging

**Profile**:
A short statement of the kind of work a saved search is looking for (for example "Java development"), which that search's offers are judged against. Each saved search has its own profile, and it says nothing about the user themselves.
_Avoid_: Preferences, user context, CV, about me

**Verdict**:
The LLM's decision on one offer: accepted or rejected, with a one-line reason.
_Avoid_: Score, rating, fit

**Accepted offer**:
An offer whose verdict says it matches the profile.
_Avoid_: Match, passed offer

**Rejected offer**:
An offer whose verdict says it does not match the profile. Rejection comes only from the verdict, never from the search criteria.
_Avoid_: Filtered offer, discarded offer

**Unjudged offer**:
An offer the LLM failed to give a verdict on. It still appears in the report, in its own section, and becomes seen.
_Avoid_: Failed offer, errored offer

**Parsed field**:
A structured fact read directly off LinkedIn's detail page, with no LLM involved: salary, employment type, job function and industries. Left blank when LinkedIn doesn't supply it; never guessed from free text.
_Avoid_: Extracted field, metadata

**Judged field**:
A structured fact the LLM reads out of an offer's title and description, because LinkedIn exposes it nowhere reliably: work mode, seniority and tech stack. Produced in the same call as the verdict.
_Avoid_: Extracted field, metadata, enrichment

### Reporting

**Run**:
One invocation of the tool, covering one or more saved searches, that produces one report.
_Avoid_: Job, execution, fetch

**Report**:
The output of a run, written as both Markdown and HTML: one table of every offer the run handled (accepted, rejected and unjudged) with its verdict, followed by each offer's details.
_Avoid_: Digest, export, results file

**Seen offer**:
An offer that has already appeared in a report, whether accepted, rejected or unjudged, and so is left out of later reports.
_Avoid_: Known offer, processed offer, history

**Dry run**:
A run that produces a report without marking any offer as seen.
_Avoid_: Preview, test run
