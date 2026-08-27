# Agent Browser Context

This context names the clean-sheet browser capability, its single-page working
identity, and its confidential login boundary.

## Language

**Agent Browser**:
The skill-level capability that reasons about and coordinates browser work.
_Avoid_: Warm Browser, the third-party `agent-browser` executable

**Warm Browser**:
The deterministic browser operator used by Agent Browser and the sole lifecycle
owner of the Agent Chrome Profile after Profile Cutover.
_Avoid_: Agent Browser, Browser Use, Browser Connect, Warm Chrome

**Agent Chrome Profile**:
The existing persistent Chrome profile whose browser-local continuity is
reserved exclusively for Warm Browser after Profile Cutover.
_Avoid_: Agent Chrome product, default profile, new automation profile

**Browser Session**:
An internal Warm Browser relationship between one exact browser process, the
Agent Chrome Profile, one verified CDP endpoint, and one Controlled Page.
_Avoid_: browser instance, named session, adapter session

**Controlled Page**:
The sole page within a Browser Session on which Agent Browser may act.
_Avoid_: active tab, current tab, target

**Snapshot Generation**:
One internal Warm Browser snapshot basis for a Controlled Page. It changes when
the identity basis changes and invalidates earlier Snapshot References.
_Avoid_: page state, snapshot version, stable generation

**Snapshot Reference**:
A short-lived element identity whose validity is internal to Warm Browser and
bound to one Controlled Page and one Snapshot Generation.
_Avoid_: selector, stable ref, element id

**Credential Vault**:
The one configured 1Password vault eligible for private exact-origin login
matching. Other accounts and vaults remain outside Agent Browser discovery.
_Avoid_: 1Password account, credential store, vault inventory

**Credential Match**:
Exactly one Login item in the Credential Vault whose declared website origin
equals the current page origin.
_Avoid_: Login Binding, credential search, best match

**Private Delivery**:
One bounded confidential action in which a disposable child receives one
Credential Match field, revalidates the exact origin, fills one selected field,
reports non-secret shape, and exits.
_Avoid_: credential bridge, secret fetch, background helper

**Profile Cutover**:
The separately approved transition that reserves the Agent Chrome Profile for
Warm Browser and retires every earlier product from that profile.
_Avoid_: migration, cleanup, implementation deletion
