---
name: notebooklm
description: "NotebookLM requests through MC Porter: readiness, notebook content, or explicitly approved operations."
---

# NotebookLM

Use the `notebooklm-mcp` server through `mcporter`.

Never run a content-bearing MCP call unless the same command projects an
allowlisted result. Stop when a safe projection cannot be defined.

## Dependency

`mcporter` and its configured `notebooklm-mcp` alias are hard dependencies.
Read [Failure](references/operations.md#failure) when either is unavailable or
invalid.

## Route

- No target or readiness request: read
  [Readiness](references/operations.md#readiness). Never list notebooks.
- Read or query request: read
  [Read Or Query](references/operations.md#read-or-query). Call only the tool
  required by the request.
- Authentication request or failure: read
  [Authentication](references/operations.md#authentication). Use `nlm login`
  only after approval; never call `save_auth_tokens` or accept pasted cookies.
- Approved side effect: read
  [Approved Side Effects](references/operations.md#approved-side-effects).
  After an ambiguous dispatch, report `unknown` and never retry until stable-ID
  destination inspection resolves the first outcome.
- Runtime, alias, schema, timeout, or empty-result failure: read
  [Failure](references/operations.md#failure).
