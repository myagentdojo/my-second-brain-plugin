# Agent Browser package

This private workspace package owns the Warm Browser lifecycle operator and the
bounded Playwright and installed-Chrome compatibility proof. The generated
plugin launcher is `plugin/bin/warm-browser`; the package entry is `src/main.ts`.

## Warm Browser lifecycle

The callable issue-38 slice is `help`, `start`, `status`, and `stop`. `help` is a
CLI meta-surface, not one of the nine accepted product commands. Every command
accepts `--run-id <ID>`; `start` alone accepts one `--port <1024..65535>`
override and otherwise uses loopback port `9242`.

On macOS, production fixes the existing profile path to
`$HOME/.agent-warm-profile`, with inner profile `Default`. It does not honor the
predecessor's `WARM_CHROME_PROFILE_DIR` override. It starts installed Google
Chrome as one detached
leader process group and records the leader PID, process-group ID, start token,
executable, command line, verified loopback CDP endpoint, and sole Controlled
Page. This is the implementation contract only: Profile Cutover has not
happened, so this ticket does not claim exclusive profile ownership or prove a
real-profile launch.

Private one-owner state lives at
`$XDG_STATE_HOME/my-second-brain/warm-browser/` (falling back to
`$HOME/.local/state/my-second-brain/warm-browser/`). Directories and the durable
lock are `0700`; the atomic session document is `0600`. Mismatched live process
identity or unverified CDP identity is preserved for inspection and never
signalled. Proved dead state and an expired exact owned starting process are
cleaned with a typed recovery result. A lock with no process receipt is never
auto-recovered, even after expiry, because it may represent the crash window
after spawn; it remains intact for inspection.

Results are one schema-versioned JSON envelope. Success writes one stdout line
and no stderr; refusal or failure writes no stdout and one redacted stderr line.
Every envelope includes `resultCode`, `transactionState`, Boolean `retrySafe`,
non-empty `nextAction`, and `runId`. Exit classes are `0` success, `2` usage,
`20` inspect/repair, `21` refusal, `22` transient, and `1` unexpected.

The closed transaction vocabulary is `unchanged`, `started`, `stopped`,
`recovered`, and `rolled_back`. The closed lifecycle Result Vocabulary is
`HELP`, `SESSION_STARTED`, `SESSION_RUNNING`, `SESSION_ABSENT`,
`SESSION_STOPPED`, `STALE_SESSION_RECOVERED`, `USAGE_ERROR`,
`PLATFORM_UNSUPPORTED`, `STATE_UNSAFE`, `CHROME_UNAVAILABLE`,
`PROFILE_UNSAFE`, `PROFILE_PROCESS_AMBIGUOUS`, `PROFILE_IN_USE`,
`PROCESS_IDENTITY_UNVERIFIED`, `CDP_IDENTITY_UNVERIFIED`,
`CONTROLLED_PAGE_UNAVAILABLE`, `CONTROLLED_PAGE_AMBIGUOUS`,
`SESSION_ALREADY_RUNNING`, `PORT_OCCUPIED`, `PORT_UNVERIFIABLE`,
`START_IN_PROGRESS`, and `UNEXPECTED_FAILURE`.

## Real Chrome compatibility proof

Ordinary `bun test` and an unacknowledged proof command must not launch Chrome.
After reviewing the fixture boundary, run one compatibility proof with the
repository-pinned Bun 1.4.0:

```sh
AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED=1 bun run prove:agent-browser-cdp -- --run-id <ID>
```

The acknowledgment applies only to that process. The package script does not
set it. The proof launches installed stable Google Chrome with a disposable
profile, an explicit loopback CDP endpoint, basic password storage, and Chrome's
mock keychain. It does not use the Agent Chrome Profile or download a browser.

The failure and cleanup fixture is separately selected through Bun's test
filter and requires the same environment acknowledgment:

```sh
AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED=1 bun test packages/agent-browser/scripts/prove-cdp-compatibility.test.ts --test-name-pattern close-before-connect
```

Lifecycle contract tests use the private fake driver under `tests/fixtures`.
The fixture environment is not read by the production entry or exported as a
public adapter.
