# Warm Browser

Warm Browser is one of exactly two Agent Browser Modules.

It owns the Command Vocabulary and Result Vocabulary. The first vertical slice
implements the `help` meta-surface and the `start`, `status`, and `stop` product
commands. The remaining accepted product commands are not callable yet.
Browser Session, Controlled Page, Snapshot Generation, Snapshot Reference
validity, and Screenshot lifecycle remain internal to this Module.

The production Adapter is fixed. Tests inject the internal Adapter through a
private test-only driver; no environment variable selects a fake in production.
The lifecycle contract fails closed on unsupported platforms, unsafe profile or
state, ambiguous ownership, occupied or unverifiable ports, process mismatch,
and CDP or Controlled Page identity failure. One Module file owns the local
process-table observation, and any unparsed, forged, repeated, or otherwise
ambiguous row makes that whole observation unverifiable instead of proved
absence.

A Screenshot is a private session-owned PNG of the Controlled Page, distinct
from the structured interaction snapshot. Warm Browser returns only its owned
path, dimensions, and SHA-256 metadata, refuses arbitrary output paths, and
deletes owned Screenshots on stop or bounded stale-session cleanup.

Later interface and testing work may cross the Command Vocabulary and Result
Vocabulary only. Any mock remains internal.
