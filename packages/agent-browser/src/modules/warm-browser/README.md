# Warm Browser

Warm Browser is one of exactly two future Agent Browser Modules.

It owns the future Command Vocabulary and Result Vocabulary. Browser Session,
Controlled Page, Snapshot Generation, Snapshot Reference validity, and
Screenshot lifecycle remain internal to this Module.

A Screenshot is a private session-owned PNG of the Controlled Page, distinct
from the structured interaction snapshot. Warm Browser returns only its owned
path, dimensions, and SHA-256 metadata, refuses arbitrary output paths, and
deletes owned Screenshots on stop or bounded stale-session cleanup.

Future interface and testing work may cross the Command Vocabulary and Result
Vocabulary only. The production Adapter is fixed; any mock remains internal.
