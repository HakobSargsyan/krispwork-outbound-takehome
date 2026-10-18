# Prompt Log

Running log of prompts/questions asked during this take-home — gist only, not
full context. This is the direct answer to "we expect you to use Claude while
working on it, so please show us how you used it": every feature, every
config decision, and every debugging session below went through Claude
(Claude Code), including the dead ends and the things that got tried and
reverted.

- 2026-10-18 11:01: Set up this folder and a prompt-log file to track the gist of each question/prompt going forward (not full conversation history).
- 2026-10-18 11:24: Build a small MCP server with `find_leads` (ICP filter) and `draft_email` (draft-only, no sending) tools on top of the provided leads.csv, with the data loading and ICP filter tolerant of its blank and malformed fields from the start (several rows are missing title/name/headcount).
