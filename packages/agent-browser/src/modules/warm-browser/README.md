# Warm Browser

Warm Browser is one of the two Agent Browser Modules, and the implemented one.

It owns the Command Vocabulary and Result Vocabulary. The first vertical slice
implements the `help` meta-surface and the `start`, `status`, and `stop` product
commands. The remaining accepted product commands are not callable yet.
Browser Session, Controlled Page, Snapshot Generation, Snapshot Reference
validity, and Screenshot lifecycle remain internal to this Module.

The production Adapter is fixed: one value, no factory, no injected dependency.
Tests inject the internal Adapter through a private test-only driver, or
substitute the Module's private `host-effects` seam through a test preload; no
environment variable selects a fake in production.
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

A Screenshot is a private session-owned PNG of the Controlled Page, distinct
from the structured interaction snapshot. Warm Browser returns only its owned
path, dimensions, and SHA-256 metadata, refuses arbitrary output paths, and
deletes owned Screenshots on stop or bounded stale-session cleanup.

Later interface and testing work may cross the Command Vocabulary and Result
Vocabulary only. Any mock remains internal.
