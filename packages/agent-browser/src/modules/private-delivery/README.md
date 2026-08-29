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
different repairs. The one Login listing carries each candidate's id, vault,
and declared websites when the Login has a website. The installed op CLI omits
the `urls` key for a Login with no website; that omission declares no origin,
while a present `urls` value must still be a bounded array of interpretable
addresses. Private Delivery reads this as one complete non-secret metadata
answer, proves the configured vault and the unique exact-origin Credential
Match, then names only that matched item id in one bounded detail read. This
keeps the wrapper and op conversation constant however many Login items the
vault holds, and no unmatched item's field values ever enter this process. An
item outside the configured vault refuses the whole delivery, and the
Credential Match must be exactly one Login item whose
declared website origin equals the current exact origin as one string, so
scheme, host, and port must all agree and a parent domain, a sub-domain, a
different scheme, and a different port are all refusals. Two matches are never
reduced to one: the Module does not pick a winner. The matched item must carry
exactly one field of the requested kind, and the delivery names that field as
`op://<vault id>/<item id>/<field id>`: three ids, never a vault name and never
a field label. Naming the field by id closes the duplicate-label hazard the op
CLI has, because two fields may share a label and a label may carry reference
syntax.

The listing decided the match, and the detail reply is asked to agree with it
before anything is named: it must be the same item id, it must sit in the
configured vault, and it must still declare the exact origin. A reply that
disagrees is refused rather than reconciled, because the two readings are two
moments and the second one is the one that names the field. The vault id used
in the reference comes from that re-proved detail reply, so the delivery is
pinned to the exact vault it named rather than to a name two vaults could
share.

A secret reference carries no escape syntax, so nothing in it is escaped: the
installed op CLI reads a per-cent sign as an invalid reference rather than as
an encoding, a `/` adds a segment it reads as a section, and a `?` adds the
attribute selector. Each of the three segments must therefore match
`[A-Za-z0-9_.-]{1,128}`, which every id op itself issues does. An id outside
that set is refused as an unverified vault reading rather than escaped into a
reference this Module cannot vouch for.

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
Vault readings run through its `op` command and write nothing to it; the
delivery runs through its `inject-stdin` command, which resolves the one
reference itself, hands the secret to the child on its standard input, and
scrubs the child environment down to HOME, PATH, LANG, LC_ALL, and TMPDIR. No
secret is ever an argument, an environment value, or a variable in this Module.

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

The child takes the accessible name and focus from Accessibility, but it does
not read the value there. A partial accessibility tree describes the control
rather than the property the fill wrote, so a Login control that does not
publish its value there would read as an unfilled field; whether any given
control does that is not proved here. For both the empty precondition and the
post-insert proof the child resolves the exact backend node and asks the page
for one boolean only, bound to the property `insertText` mutated. The
post-insert proof accepts no credential text from CDP.

Redaction is total. The result a caller sees is one closed outcome mapped into
the Warm Browser Result Vocabulary; the child's streams are parsed into that
outcome and dropped, and neither they nor any item title, item id, vault name,
username, or field value ever enters an envelope.

The seam a test may substitute is `credential-effects.ts` alone: raw wrapper
invocations with no policy, so the one listing and one uniquely selected detail
read can be proved from the outside without a 1Password account. Everything
else stays real, and the production entry takes no injected dependency.
