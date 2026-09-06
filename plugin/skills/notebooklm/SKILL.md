---
name: notebooklm
description: "NotebookLM requests through MC Porter: readiness, notebook content, or explicitly approved operations."
---

# NotebookLM

Use the `notebooklm-mcp` server through `mcporter` when client authentication
is ready. Use the installed `$browser-use` entry skill for the qualified
browser-upload fallback.

Never run a content-bearing MCP call unless the same command projects an
allowlisted result. Stop when a safe projection cannot be defined.

## Preflight

Before any authentication window or browser route, read [Authentication Preflight](references/operations.md#authentication-preflight).
Complete its safe projection and report the route before opening a browser.
Client readiness and an existing NotebookLM application session are separate
states.

## Route

- No target or readiness request: run
  [Authentication Preflight](references/operations.md#authentication-preflight).
  Never list notebooks.
- Read or query request: read
  [Read Or Query](references/operations.md#read-or-query). Run preflight first,
  then call only the tool required by the request.
- Authentication request or failure: read
  [Authentication Choice](references/operations.md#authentication-choice).
  Treat cancellation as a terminal result for the current task.
- Source upload with client authentication unavailable: read
  [Browser Upload Fallback](references/operations.md#browser-upload-fallback).
- Approved side effect: read
  [Approved Side Effects](references/operations.md#approved-side-effects).
  After an ambiguous dispatch, report `unknown` and never retry until stable-ID
  destination inspection resolves the first outcome.
- Runtime, alias, schema, timeout, or empty-result failure: read
  [Failure](references/operations.md#failure).
