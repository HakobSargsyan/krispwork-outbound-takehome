# Prompt Log

Running log of prompts/questions asked during this take-home — gist only, not
full context. This is the direct answer to "we expect you to use Claude while
working on it, so please show us how you used it": every feature, every
config decision, and every debugging session below went through Claude
(Claude Code), including the dead ends and the things that got tried and
reverted.

- 2026-10-18 11:01: Set up this folder and a prompt-log file to track the gist of each question/prompt going forward (not full conversation history).
- 2026-10-18 11:24: Build a small MCP server with `find_leads` (ICP filter) and `draft_email` (draft-only, no sending) tools on top of the provided leads.csv, with the data loading and ICP filter tolerant of its blank and malformed fields from the start (several rows are missing title/name/headcount).
- 2026-10-18 11:34: Asked to go over the ICP filter and data preprocessing (`src/outbound/leads.ts`) and find gaps, checked against the actual `leads.csv` rather than just the code in isolation. Found: the `industries` filter is case-sensitive while `seniorityKeywords`/`countryContains` both lowercase (`industries: ["software"]` silently matches nothing against the real `"Software"` value); no email validation anywhere, so `L048`'s malformed address (`grace.taylor@orbitfintech`, missing TLD) and `L049`'s all-caps one both pass through untouched; a blank `title` (`L011`) silently drops an otherwise in-range lead with no record of why, which is notable because a same-company, same-headcount lead (`L030`) has the title "Head of IT" -- a plausible sign L011's title was simply lost in the messy data rather than genuinely absent. Also found several latent-but-not-currently-triggered gaps (lenient `parseInt` on headcount, no cross-row headcount backfill, a first/last-name collapse edge case in email greetings) that the current 50-row CSV happens not to exercise.
