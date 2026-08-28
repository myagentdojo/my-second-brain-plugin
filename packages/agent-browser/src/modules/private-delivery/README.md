# Private Delivery

Private Delivery is the second Agent Browser Module, and it is implemented. It
owns everything credential-shaped about `login`: the human-approval gate, the
configured Credential Vault, the exact-origin unique Credential Match, the one
wrapper invocation, the disposable child that revalidates and fills, and the
redacted non-secret outcome. Warm Browser proves everything non-secret first
and then calls one Module entry, `deliverPrivately`, with only non-secret
inputs; no credential value ever crosses back across that call.

The ordering is fixed, and each step fails closed before the next. Approval is
proved first, before anything is read and before any process exists, so a
credential access without a human approval never begins. The configured
Credential Vault is resolved second and the wrapper proved third, so the vault
is never spoken to on an unconfigured or unsafe footing. A wrapper that is
unavailable is its own answer, distinct from a vault that could not be read,
because restoring the wrapper and inspecting the configured vault are
different repairs. Candidates are then
listed and read one at a time; an item outside the configured vault refuses the
whole delivery; and the Credential Match must be exactly one Login item whose
declared website origin equals the current exact origin as one string, so
scheme, host, and port must all agree and a parent domain, a sub-domain, a
different scheme, and a different port are all refusals. Two matches are never
reduced to one: the Module does not pick a winner. The matched item must carry
exactly one field of the requested kind, and that field is named by
`op://<vault>/<item id>/<field id>` with every segment URL-path-encoded, which
is what closes the duplicate-label hazard the op CLI has.

The configured Credential Vault is one private file this Module only reads:
`$XDG_STATE_HOME/my-second-brain/private-delivery/credential-vault.json`,
falling back to `$HOME/.local/state/`, content
`{"schemaVersion":1,"vault":"<name or id>"}`. The directory must be exactly
`0700` and the file exactly `0600`, both owned by the current user and neither
a symlink. An absent file is unconfigured; a present file failing any check is
unsafe, and unsafe is refused rather than repaired, because a Module that could
write its own credential policy could be steered into configuring itself.

The one credential wrapper this Module invokes is
`$HOME/code/dotfiles/bin/with-one-password-token`, proved to be a regular,
non-symlink, executable file owned by the current user before any invocation.
Vault readings run through its `op` command; the delivery runs through its
`inject-stdin` command, which resolves the one reference itself, hands the
secret to the child on its standard input, and scrubs the child environment
down to HOME, PATH, LANG, LC_ALL, and TMPDIR. No secret is ever an argument,
an environment value, or a variable in this Module.

The disposable child is one private re-entry of the shipped entry, selected by
an argument the public parser never sees, so one bundle still ships and `help`
never names it. It reads the value once from its standard input, revalidates
the frame, the document load, the url, and the exact origin immediately before
the fill, re-derives the field kind from the live page, proves the field empty
and then focused, inserts the value, and reports one closed JSON outcome line
carrying no value, no length, and no page text beyond the outcome. It writes
no file, opens no other socket, and creates no other process. Its confinement
is a boundary against accident, not an authorisation: a local caller who can
run the executable can already reach the CDP port.

Redaction is total. The result a caller sees is one closed outcome mapped into
the Warm Browser Result Vocabulary; the child's streams are parsed into that
outcome and dropped, and neither they nor any item title, item id, vault name,
username, or field value ever enters an envelope.

The seam a test may substitute is `credential-effects.ts` alone: raw wrapper
invocations with no policy, so the wrapper contract can be proved from the
outside without a 1Password account. Everything else stays real, and the
production entry takes no injected dependency.
