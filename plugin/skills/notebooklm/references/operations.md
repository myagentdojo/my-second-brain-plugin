# NotebookLM Operations

Read only the section selected by `SKILL.md`.

## Authentication Preflight

Inspect dependency presence, config shape, and safe server status only. Keep
the pipeline failure visible and require exactly one projected status object:

```bash
command -v mcporter
command -v jq
set -o pipefail
mcporter config get notebooklm-mcp --json \
  | jq -ce '{name,source,transport,command}'
mcporter call notebooklm-mcp.server_info --args '{}' --timeout 60000 --output json \
  | jq -ce '[.. | objects | select(has("auth_status")) \
    | {version,auth_status,update_available}] \
    | if length == 1 then .[0] else error("expected one auth status") end'
```

Never run `nlm login` during preflight. Never inspect browser state during
preflight. Set `application_session` to `unknown`; the safe server status
determines `client_authentication` only. A signed-in NotebookLM tab does not
make the MCP client ready.

| Observed condition | Outcome | Next route |
| --- | --- | --- |
| `configured` | `ready` | Client route |
| `stale` or `not_configured` | `blocked` | Choice required |
| `unverified` | `degraded` | Repair route |
| Missing dependency, alias, bad schema, or `error` | `unavailable` | Repair route |
| Authentication choice cancelled in this task | `cancelled` | No route |
| Personal or Monash existing-browser client bridge | `unsupported_route` | Browser upload |

Return one outcome, runtime version, `auth_status`, config source, both
readiness states, and one next action. Never call `notebook_list` during
preflight. Stop before client reads unless the outcome is `ready`.

## Read Or Query

Proceed only when preflight reports `ready` with `auth_status: configured`.

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

## Authentication Choice

After `stale` or `not_configured`, explain the routes before any launch:

- Browser upload uses the requested signed-in Chrome profile and does not make
  the MCP client ready. Use it for source uploads.
- Built-in `nlm login` opens a separate client-owned browser profile so the
  client can extract and store authentication cookies. The installed client
  can automatically relaunch that profile after an account mismatch, so this
  route is not qualified by this integration.
- Existing-browser client authentication can attach to an external CDP
  endpoint, but its cookie scope is unqualified for the personal
  (`nathanvale.com`) and `Monash` profiles.

Recommend browser upload for source ingestion. For client-only reads or
queries, report `blocked` until a scoped, single-launch client authentication
route is qualified. Never call `save_auth_tokens`, accept pasted cookies, copy
authentication state between profiles, or introduce a credential broker.

If the user declines or closes an authentication choice, record `cancelled`
for the current task. Do not offer or run `nlm login` again until the user
explicitly selects client authentication in a later message. A repeated
NotebookLM request does not clear cancellation or silently open a browser.

For `error`, use `mcp-doctor` as an optional handoff when it is installed. If it
is unavailable, report `blocked`, name the failing `notebooklm-mcp` alias, and
ask the user to restore the configured MC Porter route. For `unverified`, report
the degraded state and stop; do not infer that login is required.

## Qualified Client Evidence

Evidence refreshed 2026-09-06 against installed `notebooklm-mcp-cli 0.9.13`:

- `nlm login --help` advertises built-in and OpenClaw providers plus an external
  CDP URL.
- The existing-CDP path finds or creates a NotebookLM page, then calls
  `Network.getAllCookies` without a URL or domain parameter and saves the
  returned cookie collection to the client profile.
- A synthetic probe returned both `.google.com` and unrelated `.example.test`
  sentinel cookies from that function. No live cookies or browser profile were
  read.

Credential scope: all cookies visible to the connected CDP target. Filtering
after collection cannot narrow what the client already received. The external
CDP bridge is therefore unqualified for the personal and Monash profiles.

Remaining gaps: the client has no observed domain-scoped extraction option and
no observed switch that prevents its account-mismatch relaunch. The client
owner must provide both controls, then an isolated synthetic probe must prove
that unrelated-domain sentinels never cross the client boundary before this
integration can recommend that route.

## Browser Upload Fallback

For an approved local source upload when client authentication is not `ready`,
invoke the installed `$browser-use` entry skill. Declare the requested
`nathanvale.com` or `Monash` lane, the NotebookLM application URL, the exact
local files, and the explicitly selected destination notebook. Let
`browser-use` own profile identity, visible sign-in, tab admission, browser
custody, and adapter selection.

Supported operations: local-file source upload to one explicitly selected
existing notebook. This route does not support MCP reads, queries, or source
verification calls and does not change `client_authentication`.

Owner: `browser-use` owns the browser journey; this NotebookLM skill owns
source selection, destination selection, mutation authority, and outcome
reporting. Ticket 116 owns the first live integration qualification.

Independent success criteria: the selected Chrome profile remains unchanged;
the exact existing notebook is visible before mutation; each requested file is
uploaded once; the resulting source row exposes a stable source identity; and
the same notebook view independently shows that identity after upload. Until
that live check passes, report the browser-upload route as defined but
unqualified for completed ingestion.

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
