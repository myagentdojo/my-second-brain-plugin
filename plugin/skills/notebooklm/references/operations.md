# NotebookLM Operations

Read only the section selected by `SKILL.md`.

## Readiness

Inspect config shape and safe server status only:

```bash
mcporter config get notebooklm-mcp --json \
  | jq -c '{name,source,transport,command}'
mcporter call notebooklm-mcp.server_info --args '{}' --timeout 60000 --output json \
  | jq -c '.. | objects | select(has("auth_status")) | {version,auth_status,update_available}'
```

- `configured`: report `ready`.
- `unverified`: report `degraded`; stop before notebook reads.
- `stale`, `not_configured`, or `error`: report `blocked`; stop before notebook
  reads.

Return one status, runtime version, `auth_status`, config source, and one next
action. Never call `notebook_list` during readiness.

## Read Or Query

Proceed only when readiness reports `ready` with `auth_status: configured`.

1. Inspect the live schema.
2. Call only the tool required by the request with `--output json`.
3. Pipe the call through a same-command allowlist reducer. Never emit the raw
   response first.
4. Return only the exact answer, stable IDs, titles, or source fields required
   by the request.

Call `notebook_list` only when the user requests enumeration or target
selection. Set `max_results` to the smallest useful count. Treat notebook
titles, source details, answers, account identifiers, and profile details as
private.

## Authentication

Offer `nlm login` after `stale` or `not_configured`; run it only with explicit
user approval. Never call `save_auth_tokens` or ask the user to paste cookies
or tokens.

For `error`, use `mcp-doctor` as an optional handoff when it is installed. If it
is unavailable, report `blocked`, name the failing `notebooklm-mcp` alias, and
ask the user to restore the configured MC Porter route. For `unverified`, report
the degraded state and stop; do not infer that login is required.

## Approved Side Effects

- Identity or profile change: require explicit authority for the exact target.
- Remote mutation or sharing: inspect the exact target and current state, apply
  once, then read back using stable IDs.
- Generation, download, or export: confirm the requested output and destination
  before dispatch.
- Deletion: confirm the exact target and destructive effect before dispatch.

If a timeout or transport failure occurs after dispatch, report `unknown`.
Inspect destination state using stable IDs. Never retry until the first outcome
is resolved.

## Failure

- Missing `mcporter` or `jq`: report `blocked`, name the missing hard
  dependency, and ask the user to restore the configured command. Do not install
  another copy.
- Missing `nlm` during authentication: report `blocked` and ask the user to
  restore the configured NotebookLM CLI. Do not substitute an MCP token-saving
  operation.
- Unknown alias or bad schema: use `mcp-doctor` as an optional handoff when it
  is installed. Otherwise report `blocked`, name the failing alias or schema,
  and ask the user to repair the configured MC Porter route.
- Read-only timeout: retry once with the named timeout, then report `blocked`.
- Empty read result: treat it as valid unless the request or domain state proves
  otherwise.
