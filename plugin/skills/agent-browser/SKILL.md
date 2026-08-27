---
name: agent-browser
description: "Operate the My Second Brain dedicated browser when an agent needs browser interaction or secret-safe login."
---

# Agent Browser

Read [`CONTEXT.md`](CONTEXT.md) before using this skill.

Use Agent Browser for browser work that needs the dedicated Agent Chrome
Profile, including a login backed by the configured Credential Vault. The skill
coordinates the task. Warm Browser owns the browser process, the verified CDP
endpoint, the Controlled Page, and every deterministic browser operation.

## Accepted outcome

Operate one Controlled Page in one Browser Session through the `warm-browser`
CLI. Preserve browser-local continuity in the Agent Chrome Profile while
keeping credential metadata, usernames, passwords, and authentication material
outside the agent process.

The intended public Command Vocabulary is `start`, `status`, `open`,
`snapshot`, `screenshot`, `click`, `fill`, `login`, and `stop`.

## Workflow contract

1. Start or inspect the Browser Session through
   `<plugin-root>/bin/warm-browser`. Use port `9242` unless the current start
   needs an explicit `--port <number>` override. Supply `--run-id <ID>` for
   correlation.
2. Take a snapshot and act only through its short-lived Snapshot References.
3. Take a Screenshot when visual evidence is needed. Keep the returned private
   session-owned path within the current task and do not treat it as a Snapshot
   Reference source or permanent archive.
4. Treat navigation, page replacement, and a fresh snapshot generation as
   reference-invalidating events. Take another snapshot before continuing.
5. For login, select the intended username or password field from the current
   snapshot. Require human approval immediately before credential access.
6. Let Private Delivery resolve exactly one Login item for the current exact
   origin, revalidate that origin, fill one selected field, report only
   non-secret shape, and exit.
7. Discard earlier references after a private fill. Take a fresh snapshot before
   any final submit, and require human approval for a consequential submission.

## Boundaries

- Browser operation initially supports macOS and installed Google Chrome only.
- Warm Browser is the only supported browser operator. Do not call Playwright
  directly from this skill.
- Use one Browser Session, one Controlled Page, and the existing Agent Chrome
  Profile. Do not create named sessions or manage multiple pages.
- Screenshots are private session-owned PNG artifacts. Warm Browser returns
  path, dimensions, and SHA-256 metadata, refuses arbitrary output paths, and
  removes owned Screenshots on stop or bounded stale-session cleanup.
- Fail closed when the exact process, CDP endpoint, Controlled Page, origin, or
  unique Credential Match cannot be proved.
- Cross-origin login frames, other browser applications, other 1Password
  vaults, credential enrollment, passkey bypass, and CAPTCHA bypass are not
  supported.
- Do not invoke Browser Use, Browser Connect, Warm Chrome, or
  `browser-use-prototyper` as a fallback.

## Current maturity

Maturity: `page-control-slice`. The generated payload activates Warm Browser
`help`, `start`, `status`, `open`, `snapshot`, `click`, `fill`, and `stop`;
`screenshot` and `login` are not callable. `fill` refuses every credential field,
including the login identifier beside the password, and names `login`, so
credential entry has no path in this slice. Profile
Cutover, credential delivery, installation, and release remain separate tickets.
Do not claim profile exclusivity or a real-profile launch until their owning
proofs complete.
