# Warm Browser

Warm Browser is one of the two Agent Browser Modules; Private Delivery is the
other, and both are implemented.

It owns the Command Vocabulary and Result Vocabulary, and each command declares
the options it accepts beside its own name there. The implemented slice is the
`help` meta-surface and the `start`, `status`, `open`, `snapshot`,
`screenshot`, `click`, `fill`, `login`, and `stop` product commands, which is
every command the Command Vocabulary names. Browser Session, Controlled Page,
Snapshot Generation, Snapshot Reference validity, and Screenshot lifecycle
remain internal to this Module.

The production Adapter is fixed: one value, no factory, no injected dependency.
Tests inject the internal Adapter through a private test-only driver, or
substitute the Module's private `host-effects` seam through a test preload; no
environment variable selects a fake in production. The CDP transport is the one
raw effect that is never substituted: the deterministic Controlled Page fixture
is a real local endpoint, so replacing the transport would delete the protocol
conversation under proof and leave an assertion about it in its place.
The lifecycle contract fails closed on unsupported platforms, unsafe profile or
state, ambiguous ownership, occupied or unverifiable ports, process mismatch,
and CDP or Controlled Page identity failure. Ownership requires the whole
observed command line to equal the saved one, so an unrecognised argument is
never signalled or cleaned. One Module file owns each raw host reading and one
owns each interpretation of it: the local process table and the loopback
listener are read without interpretation and observed without reading. Any
unparsed, forged, repeated, or otherwise ambiguous row makes that whole
observation unverifiable instead of proved absence, and no row is ever skipped,
because a skipped row would let a live process read as proved absence.
A launch signals nothing until one fully observed row proves the exact process
it created: the launched identity leading its own process group, running the
installed executable, and carrying the launched argument list byte for byte. A
post-spawn reading that is unverifiable, that never shows the identity within
its bound, or that shows any non-exact one preserves the durable launch marker
and reports unverified cleanup, because a process identity may have been reused
and only the marker-matched path can prove ownership before signalling.
Stopping an owned process group answers only what it observed: a group proved
gone is stopped, a group still present after its bound is escalated once, and a
group whose liveness cannot be observed is never escalated onto and never
reported stopped. A proved stop whose durable cleanup fails reports the stop it
performed and keeps the retained state repairable.

One Controlled Page is operated through Snapshot References and never through a
public selector. A reference names an element ordinal at a Snapshot Generation
and carries that generation in its own text, so a reference issued against an
earlier one resolves against nothing. Every `open`, every fresh `snapshot`, and
every act that moves the page invalidates the generation durably; so does every
command that merely proves the page moved or was replaced, before it returns its
refusal, which is why no register of dead references exists to be consulted
later. Every use re-proves the live page identity as well, so a reference that
outlived the page it described is refused rather than followed. The page is
reached at an address this Module computes, never at the socket the endpoint
advertises, and a target identity it could not address again is not a Controlled
Page at all. A replacement page is refused until one `open` is told to adopt it.
A refusal that found no generation to drop says so instead of reporting a loss
the caller never had.

A navigation is bound to the document it asked for: `open` succeeds only on the
frame and document load the browser said it started, an act proves the identity
once more immediately before dispatching, and a page that moved after the act is
the act working only when the act was a click on something that navigates.
Anything else that moved the page is another document arriving, and success is
never claimed about it.

An act also proves it reaches the element the reference names. A click brings
that element into view, takes a point on its own content quad, and asks the page
what is at that point: the answer must be the element itself or its own content,
so a click is never delivered to something covering it, and a coordinate the two
readings disagree about is refused rather than guessed at. A `fill` asks for
focus and then reads back which node holds it, so a focus handler cannot divert
the value into a field the caller never named, and it types only into an empty
field, because inserted text is appended to whatever is already there. An act
that cannot prove all of this dispatches nothing and says which proof failed, and
it says what the attempt already cost the page: bringing an element into view
scrolls the page and asking for focus moves it, so a refusal that got that far
records `acted` rather than claiming it left the page alone.

`fill` refuses a credential field from the snapshot before saying anything to the
page, and again from the live description and accessible name immediately before
typing. A field is classified from what the page says about it and from the name
a reader would hear, so a field labelled `Username` carrying no attribute saying
so is still caught. The name counts only where a value could be typed, because
a link or a button carries its own visible text as its accessible name and that
text names what the control does rather than what a field holds. A field the
document reading could not describe at all is credential material by default,
and a field inside a shadow root is described rather than missed, because the
document is read through them. The login
identifier is classified with the password, because it is the half of the pair
that names the account; both refusals route to `login`.

`login` acts through the same Snapshot Reference discipline as every other
page command, and it proves everything non-secret before it delegates: the
verified Browser Session, the resolved reference, the live page identity
before and after the reading, that the referenced field sits in the top
document rather than inside a frame, that the page has an exact http or https
origin, that the field is empty, and that it is a credential field of exactly
the requested kind. Only then does it hand the port, the identity basis, the
node, the origin, and the field kind to Private Delivery, which owns the
credential half. No credential value ever crosses back: what returns is one
closed non-secret outcome, and the envelope carries no value, no length, no
item, and no vault detail.

A Screenshot is a private session-owned PNG of the Controlled Page, distinct
from the structured interaction snapshot. The artifact lives inside the
session's own ownership lock, so the lock that proves the session is what proves
the Screenshot belongs to it. Warm Browser returns only its owned path,
dimensions, and SHA-256 metadata, refuses arbitrary output paths, and a capture
clears the one before it and writes the new one, so at most one exists. A
successful capture writes no durable receipt, which is what makes it provable
that it issues no Snapshot Reference and changes no Snapshot Generation. Bytes
that are not one complete PNG are never kept. Owned Screenshots are removed
with session state on stop or bounded stale-session cleanup, and a cleanup that
cannot be completed fails closed with the state left repairable.

Later interface and testing work may cross the Command Vocabulary and Result
Vocabulary only. Any mock remains internal.
