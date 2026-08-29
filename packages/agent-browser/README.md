# Agent Browser package

This private workspace package owns the Warm Browser lifecycle operator and the
bounded Playwright and installed-Chrome compatibility proof. The generated
plugin launcher is `plugin/bin/warm-browser`; the package entry is `src/main.ts`.

## Warm Browser lifecycle

The callable slice is `help`, `start`, `status`, `open`, `snapshot`,
`screenshot`, `click`, `fill`, `login`, and `stop`. `help` is a CLI
meta-surface, not one of the nine accepted product commands, and the other nine
are the whole Command Vocabulary. Every command accepts `--run-id <ID>`, and
each command declares the options it accepts beside its own name in the Command
Vocabulary: `start` accepts one
`--port <1024..65535>` override and otherwise uses loopback port `9242`, `open`
accepts `--url URL` and `--adopt-page`, `screenshot` accepts none, `click`
accepts `--ref REFERENCE`, `fill` accepts `--ref REFERENCE` and
`--value TEXT`, and `login` accepts `--ref REFERENCE`, `--field KIND`, and
`--human-approved`. The `--human-approved` switch asserts that a human approved
this exact credential access immediately before it; the assertion is the
human's to make and never an agent's own decision.

On macOS, production fixes the existing Agent Chrome Profile path to
`$HOME/Library/Application Support/Agent Chrome/Chrome User Data`, with inner
profile `Default` and explicit loopback port `9242`. That path is the whole
configuration: it is named once, in the production Adapter, and rolling Profile
Cutover back is that one value. Nothing here reads profile entries, copies,
moves, repairs, or removes profile data in either direction. Production does not
honor the predecessor's `WARM_CHROME_PROFILE_DIR` override, and it no longer
names the retired predecessor root anywhere. It starts installed Google Chrome
as one detached
leader process group and records the leader PID, process-group ID, start token,
executable, command line, verified loopback CDP endpoint, and sole Controlled
Page. Profile Cutover has happened in source: this package reserves that profile
and the predecessor routes owned by this cutover refuse it. Retiring the
installed Agent Chrome launcher app and starting Warm Browser on the real
profile are separate live operations, and this package does not claim them.

The Agent Chrome Profile path contains spaces, so a process-table row cannot be
split back into arguments. A row claims the profile when it carries
`--user-data-dir` with that path attached or separated, quoted or bare. That
reading is inclusive at its one remaining ambiguity: a longer path whose leading
tokens are exactly this profile root reads as a claim. A claim only ever refuses
a start or preserves a receipt, so reading one process too many costs a refusal,
while reading one too few would let a live browser holding the profile read as
proved absence.

Before spawn, Warm Browser durably records a unique launch marker and passes it
as `--agent-browser-launch-marker=...`. Recovery requires an exact marker,
profile, port, executable, leader PID, process-group, and whole command-line
match against the saved receipt, then repeats the
marker query immediately before signalling. A live process whose command line
gained, lost, or changed one argument is never judged owned, so it is never
signalled and its state is never cleaned. Fake-process crash proofs cover
that ownership algorithm. Whether installed Google Chrome retains this unknown
marker flag in its process-table command line still requires the separately
acknowledged real-Chrome qualification; this ticket does not claim that proof.

Every process decision reads one local process table through a single reader,
`src/modules/warm-browser/host-effects.ts`, and interprets it through a single
owner, `src/modules/warm-browser/process-table.ts`. A row's executable is
classified only at a whole-token boundary, so a neighbouring path that merely
begins with the installed Chrome path never classifies as installed Chrome.
That observation is all or nothing.
A failed or signalled read, empty or truncated output, any nonempty row that does
not parse, any row carrying a control character, any process identity outside the
canonical safe-integer range, and any repeated process identity make the whole
observation unverifiable. No row is skipped, because a skipped row would let a
live process read as proved absence. An unverifiable observation returns
`PROCESS_INSPECTION_UNVERIFIED` and performs no cleanup, no signal, and no
launch.

A launched process group that Warm Browser cannot prove it stopped is never
reported as a rollback. That failure keeps the durable intent, keeps the live
process, and returns the unverified-cleanup result so recovery can inspect the
exact marker.

A proved stop whose durable cleanup then fails is never reported as unchanged.
The result records `stopped`, names the retained repairable state, and asks for
its repair; the retained receipt fails the next run closed with `STATE_UNSAFE`
and no further signal.

Private one-owner state lives at
`$XDG_STATE_HOME/my-second-brain/warm-browser/` (falling back to
`$HOME/.local/state/my-second-brain/warm-browser/`). Directories and the durable
lock are exactly `0700`; the receipt inside that lock is exactly `0600`.
Mismatched live process
identity or unverified CDP identity is preserved for inspection and never
signalled. Proved dead state and an expired exact owned starting process are
cleaned with a typed recovery result. A lock with no durable launch intent is
never auto-recovered, even after expiry; it remains intact for inspection.

Results are one schema-versioned JSON envelope. Success writes one stdout line
and no stderr; refusal or failure writes no stdout and one redacted stderr line.
Every envelope includes `resultCode`, `transactionState`, Boolean `retrySafe`,
non-empty `nextAction`, and `runId`. Exit classes are `0` success, `2` usage,
`20` inspect/repair, `21` refusal, `22` transient, and `1` unexpected.

The closed transaction vocabulary is `unchanged`, `started`, `stopped`,
`recovered`, `rolled_back`, `acted`, and `invalidated`. A page command that
changed the Controlled Page, or that cannot prove it did not, records `acted`,
as does a command that leaves durable session state behind. A `screenshot`
records `acted` because it replaces the private Screenshot the Browser Session
owns, though it never changes the page. That includes an act that dispatched nothing: bringing an element into view
scrolls the page and asking a field for focus moves it, so a refusal that got
that far records `acted`, and only one decided before the page was asked for
anything records `unchanged`. A command that reached nothing but dropped the
Snapshot References it held records `invalidated`, which neither denies that
durable state moved nor claims the page was touched. The closed
Result Vocabulary is `HELP`, `SESSION_STARTED`, `SESSION_RUNNING`,
`SESSION_ABSENT`, `SESSION_STOPPED`, `STALE_SESSION_RECOVERED`, `USAGE_ERROR`,
`PLATFORM_UNSUPPORTED`, `STATE_UNSAFE`, `CHROME_UNAVAILABLE`,
`PROFILE_UNSAFE`, `PROFILE_PROCESS_AMBIGUOUS`, `PROFILE_IN_USE`,
`PROCESS_INSPECTION_UNVERIFIED`, `PROCESS_IDENTITY_UNVERIFIED`,
`LAUNCH_PROCESS_AMBIGUOUS`, `CDP_IDENTITY_UNVERIFIED`,
`CONTROLLED_PAGE_UNAVAILABLE`, `CONTROLLED_PAGE_AMBIGUOUS`,
`CONTROLLED_PAGE_REPLACED`, `SESSION_ALREADY_RUNNING`, `PORT_OCCUPIED`,
`PORT_UNVERIFIABLE`, `START_IN_PROGRESS`, `PAGE_OPENED`, `SNAPSHOT_TAKEN`,
`SCREENSHOT_CAPTURED`, `ELEMENT_CLICKED`, `FIELD_FILLED`, `SNAPSHOT_ABSENT`,
`ELEMENT_NOT_ACTIONABLE`, `SNAPSHOT_REFERENCE_INVALID`,
`SNAPSHOT_REFERENCE_STALE`, `PAGE_IDENTITY_CHANGED`, `SELECTOR_UNSUPPORTED`,
`SCREENSHOT_PATH_UNSUPPORTED`, `CREDENTIAL_FIELD_REFUSED`,
`NAVIGATION_TARGET_REFUSED`, `NAVIGATION_FAILED`, `PAGE_CONTROL_UNVERIFIED`,
`LOGIN_FIELD_DELIVERED`, `APPROVAL_REQUIRED`, `LOGIN_FIELD_MISMATCH`,
`LOGIN_FRAME_UNSUPPORTED`, `ORIGIN_UNSUPPORTED`, `ORIGIN_CHANGED`,
`CREDENTIAL_VAULT_UNCONFIGURED`, `CREDENTIAL_WRAPPER_UNAVAILABLE`,
`CREDENTIAL_VAULT_MISMATCH`, `CREDENTIAL_VAULT_UNVERIFIED`,
`CREDENTIAL_MATCH_ABSENT`,
`CREDENTIAL_MATCH_AMBIGUOUS`, `CREDENTIAL_FIELD_AMBIGUOUS`,
`PRIVATE_DELIVERY_UNVERIFIED`, and `UNEXPECTED_FAILURE`.

## Controlled Page operation

`open`, `snapshot`, `screenshot`, `click`, `fill`, and `login` act on the one
Controlled Page of an already verified Browser Session and on nothing else.
Without one they refuse with `SESSION_ABSENT`.

`snapshot` reads the page's accessibility tree and its document and issues one
Snapshot Generation of short-lived Snapshot References. A reference is
`e<ordinal>@<generation>`, so it carries the generation that issued it and a
reference from an earlier generation resolves against nothing. `click` and
`fill` accept references only: a public selector flag is refused by name with
`SELECTOR_UNSUPPORTED`, and a selector passed as a reference is not a reference.
The published snapshot carries roles, names, and references, never selectors or
node identities.

Every `open` invalidates every earlier reference before it navigates, and a
fresh `snapshot` replaces the generation. Every command that proves the page
moved or was replaced also drops the generation, durably, before it returns its
refusal: a detected page replacement, a page that moved while it was being read,
a page that moved before an act, and a page that moved during one. Invalidation
is total: the generation stops existing, so no dead reference survives anywhere
to be resolved later, and a command that reloads the receipt afterwards finds
nothing to resolve. A reference is also refused once it is older than its bound,
once the live page identity differs from the one it was issued against, and once
it names another Controlled Page.

The Controlled Page is reached at an address Warm Browser computes,
`ws://127.0.0.1:<port>/devtools/page/<target>`, never at the socket the endpoint
advertises. A target identity Warm Browser could not address again is not a
Controlled Page, so such an endpoint exposes one page fewer than it appears to.

A page replacement is never adopted silently. Every command refuses with
`CONTROLLED_PAGE_REPLACED` until one `open --url URL --adopt-page` binds the
replacement, and the refusal itself has already dropped every reference bound to
the page that went.

A navigation succeeds only on the document it asked for. `open` binds success to
the frame and document load `Page.navigate` returned, so a navigation another
document wins in the meantime is reported as `PAGE_IDENTITY_CHANGED` rather than
as the page opening. `click` and `fill` prove the page identity once more
immediately before dispatching, so a navigation that lands during the reads
before it never receives the input. After the act, a page that moved is the act
working only when the act was a click on a link or a submit control; typing
never navigates a page, and no other element does, so any other page that moved
is another document arriving and is never reported as success.

`fill` refuses a credential field twice: once from what the snapshot recorded,
before anything is said to the page, and once from the live description taken
immediately before typing. A login identifier is a credential field on the same
footing as the password beside it: it is the half of the pair that names the
account, and typing it through the public interface would put it in an argument
list exactly as a password would. The standard `autocomplete` tokens and the
usual username, login, and address identifiers are all classified. Those
attribute rules hold for every node, because an attribute is the page saying what
the node is; the name a reader would hear is asked only about a field a value
could go into, because a link or a button carries its own visible text as that
name and `Log in` says what the control does rather than what a field holds. Both
refusals route to
`warm-browser login --ref REFERENCE --field KIND --human-approved --run-id ID`.
Warm Browser never
types authentication material, and `--value` carries non-secret text only.

## Screenshots

A Screenshot is a private session-owned PNG of the Controlled Page, not the
semantic Snapshot. It lives inside the session's own ownership lock at
`session.lock/screenshots/`: the directory is exactly `0700`, and the image is
exactly `0600`. The result names only the owned path, pixel dimensions, and
SHA-256. No command anywhere accepts an output destination; one named by flag
is refused with `SCREENSHOT_PATH_UNSUPPORTED`.

Each capture clears the Screenshot the session owned before writing the new one,
so at most one exists and a failure leaves less rather than more. A successful
capture does not rewrite the durable receipt, which makes it provable that it
issues no Snapshot Reference and does not change the Snapshot Generation. Before
anything is written, the bytes must prove one complete PNG through its
signature, IHDR, bounded dimensions, and IEND trailer, so a truncated or
invented answer is never kept. Every Screenshot goes with the session state on
stop and on bounded stale-session cleanup; a cleanup that cannot be completed
fails closed and leaves the state repairable.

## Responsible login

`login` delivers exactly one field of exactly one Credential Vault Login item
into one referenced credential field of the Controlled Page, without the
credential ever entering the agent process, the argument list, the environment,
the public streams, the diagnostics, or the durable state.

The ordering is fixed and each step fails closed before the next. Warm Browser
proves everything non-secret first: the verified Browser Session, the resolved
Snapshot Reference, the live page identity before and after the field reading,
that the field sits in the top document rather than inside a frame
(`LOGIN_FRAME_UNSUPPORTED`), that the page uses HTTPS or a literal
`127.0.0.1` or `[::1]` HTTP origin (`ORIGIN_UNSUPPORTED`), that the field is
empty, and that the live field is a
credential field of exactly the requested kind (`LOGIN_FIELD_MISMATCH`); a
one-time-code or verification-code field has no kind and is refused. None of
those refusals has spoken to the Credential Vault. Private Delivery then proves
the human approval before anything else, so `--human-approved` provably
precedes credential access, and its absence is `APPROVAL_REQUIRED` before
anything is read, any wrapper is invoked, or any process is created.

The Credential Match is unique and exact. One configured Credential Vault is
named by a private file Private Delivery only reads,
`$XDG_STATE_HOME/my-second-brain/private-delivery/credential-vault.json`, with
its directory exactly `0700` and the file exactly `0600`; an absent file is
`CREDENTIAL_VAULT_UNCONFIGURED`, and a present file failing any check is
refused rather than repaired. A declared website matches only when its whole
parsed origin equals the current exact origin as one string, so scheme, host,
and port must all agree: a parent domain, a sub-domain, a different scheme, an
explicit non-default port, and a path-only difference are all decided by that
one comparison. Zero matches are `CREDENTIAL_MATCH_ABSENT` and two or more are
`CREDENTIAL_MATCH_AMBIGUOUS`; the Module never picks a winner. The matched
item must carry exactly one field of the requested kind or the delivery is
`CREDENTIAL_FIELD_AMBIGUOUS`, and an item outside the configured vault is
`CREDENTIAL_VAULT_MISMATCH`.

The one credential wrapper is
`$HOME/code/dotfiles/bin/with-one-password-token`. A wrapper that is
unavailable is its own refusal, `CREDENTIAL_WRAPPER_UNAVAILABLE`, distinct
from a vault that could not be read, `CREDENTIAL_VAULT_UNVERIFIED`, because
restoring the wrapper and inspecting the configured vault are different
repairs. Before any vault access, the wrapper and the shipped Bun entry must be
current-user-owned regular non-symlinks with no group or world write bits, and
their parent chains must be owned by root or the current user and resist
replacement by another user. The wrapper alone holds the
service-account token, and its `inject-stdin` command resolves the one `op://`
reference itself, hands the secret to a disposable child on standard input,
and scrubs the child environment down to HOME, PATH, LANG, LC_ALL, and TMPDIR.
The disposable child is a private re-entry of the shipped entry that the
public parser never sees: it revalidates the frame, the document load, the
url, and the exact origin immediately before the fill, re-derives the field
kind from the live page, proves the field empty and then focused, inserts the
value, and answers one closed JSON line carrying no value and no length. An
origin that moved is `ORIGIN_CHANGED`, a page that moved is
`PAGE_IDENTITY_CHANGED`, and a child that could not prove what it did is
`PRIVATE_DELIVERY_UNVERIFIED`.

The result is non-secret and the boundaries are closed. Success is
`LOGIN_FIELD_DELIVERED` with the field kind, the reference, the Controlled
Page, and nothing else: no value, no length, no item title, no item id, no
vault name, and no username. Every earlier Snapshot Reference is invalidated
durably on success and on any outcome that reached the page, so nothing acts
on a page that now holds a credential without re-reading it first.

## Deterministic Controlled Page proof

`open`, `snapshot`, `screenshot`, `click`, and `fill` are proved through the
public process against a deterministic local accessibility fixture: one real
loopback endpoint that speaks the CDP subset Warm Browser speaks, over a real
WebSocket. The production entry opens the socket, sends the real requests, and
interprets the real replies. Only the process table, the launch, the loopback listener, and the
port probe stay substituted, because no browser is launched and none is
inspected. An independent CDP target reader that shares no code with the Module
reads the same endpoint and proves the process and Controlled Page Warm Browser
selected.

The fixture also models a navigation that lands part-way through one
conversation, delayed or competing, so the race protection is proved against a
page that moves under the command rather than only before it. An independent
reader links the launched leader, the loopback listener readings, the endpoint's
targets, and the socket that was dialled without reading anything Warm Browser
printed, and it is shown refusing a listener owned by another process and a
Controlled Page the session never bound.

`tests/warm-browser.negative-controls.test.ts` runs those scenarios twice: once
against the Module and once against a copy with exactly one invalidation,
Controlled Page, credential, or navigation-binding guard removed, recording that
the owning proof no longer holds.

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

The production Adapter is one fixed value. It takes no injected dependency and
exports no factory, so no test can replace it. Lifecycle policy tests use the
private fake driver under `tests/fixtures`. Production tests run the real entry
`src/main.ts` and substitute only the Module's private `host-effects` seam
through a test preload, so the production argument list, process-table
observation, private state rules, Agent Chrome Profile check, and result
vocabulary all stay real while nothing is launched, signalled, or dialled. The
fixture environment is not read by the production entry or exported as a public
adapter.
