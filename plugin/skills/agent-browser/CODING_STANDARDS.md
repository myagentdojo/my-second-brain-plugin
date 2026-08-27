# Agent Browser Coding Standards

Repository-wide [`CODING_STANDARDS.md`](../../../CODING_STANDARDS.md) governs
first. These skill-local standards preserve only the accepted Agent Browser
idioms witnessed in the Agent Plugin Kit maintenance command contract.

## One vocabulary owner

- Warm Browser owns one closed Command Vocabulary and one closed Result
  Vocabulary. Do not duplicate command routing, result meaning, exit meaning,
  retry safety, transaction state, or next-action meaning elsewhere.
- Keep Browser Session, Controlled Page, Snapshot Generation, Snapshot
  Reference, and Screenshot ownership internal to Warm Browser.
- Keep Private Delivery as the separate owner of confidential exact-origin
  matching, origin revalidation, and one selected-field fill.

## Prove the public process

- Accept CLI behaviour through the public-process seam: argv, stdout, stderr,
  exit code, filesystem state, browser state, and process state.
- Keep literal expected command and result data independent of production
  vocabulary generation. A production table must not calculate its own oracle.
- Emit machine JSON by default. A success emits exactly one versioned result
  envelope on stdout and no stderr. A refusal or failure emits no stdout and
  exactly one redacted error envelope on stderr.
- Accept `--run-id <ID>` on every command. Result envelopes name a Result Code,
  transaction state, retry safety, and next action.
- Preserve the accepted exit classes: `0` success, `2` usage, `20` inspect or
  repair state, `21` refusal or approval required, `22` transient retry, and
  `1` unexpected failure.

## Keep test seams private

- Keep the production Adapter fixed. Test doubles may replace browser,
  credential-wrapper, clock, process, or filesystem effects only inside tests.
- Do not publish a general adapter or dependency-injection surface merely to
  make tests convenient.
- Use real installed Chrome over an explicit CDP endpoint for bounded browser
  compatibility proof. Use local fixtures for deterministic interaction and
  Screenshot proof.

## Protect confidential and visual state

- Never place credential values in argv, environment variables, public
  streams, durable state, diagnostics, or Screenshot metadata.
- A Screenshot is a private, session-owned PNG of the Controlled Page. Return
  only its owned path, dimensions, and SHA-256 metadata; do not accept an
  arbitrary output path.
- Delete owned Screenshots on `stop` and bounded stale-session cleanup. Do not
  turn Screenshots into permanent diagnostics, an archive, or telemetry.

## YAGNI exclusions

Do not add the Agent Plugin Kit facade, Branch Stations, Station Map, LogTape,
events, telemetry, audit machinery, or copied repository-global rules. Add a
skill-local rule only after the owning proof demonstrates a repeated need.
