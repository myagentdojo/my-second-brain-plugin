import type { DomNodeDescription } from "../warm-browser/credential-fields"

/**
 * Which half of a credential pair one field is.
 *
 * This is related to Warm Browser's `isCredentialField`, and deliberately not
 * built from it, because the questions differ. That classifier decides whether
 * a field may be typed into publicly at all, and it is deliberately wide: its
 * mistake costs a recoverable refusal. This one decides which credential a
 * field would receive, and it is deliberately narrow: its mistake delivers the
 * wrong secret into a live page. A one-time-code, two-factor, or
 * verification-code field is credential material with no kind at all, because
 * nothing in a Credential Vault Login item is the right value for it, so it
 * has no side of the pair to be and is refused rather than guessed at.
 *
 * The attribute reads and the normalisation are restated to match
 * `credential-fields.ts` exactly rather than imported, so neither question can
 * be widened or narrowed by an edit meant for the other.
 */

export type CredentialFieldKind = "username" | "password"

/** Autocomplete tokens the platform reserves for the password half. */
const passwordAutocompleteTokens = ["current-password", "new-password"] as const

/** Identifier fragments that name the password half. */
const passwordIdentifierFragments = [
	"password",
	"passwd",
	"passphrase",
	"passcode",
	"pwd",
] as const

/** The autocomplete token the platform reserves for the account-name half. */
const usernameAutocompleteTokens = ["username"] as const

/** Identifier fragments that name the account-name half. */
const usernameIdentifierFragments = ["username", "userid", "login", "email"] as const

/** The attributes an identifier fragment is looked for in, as the public classifier reads them. */
const identifierAttributes = ["name", "id", "autocomplete", "aria-label", "placeholder"] as const

/** Node names that are a field a value goes into, whatever else the page says. */
const editableNodeNames = ["INPUT", "TEXTAREA", "SELECT"] as const

/** Declared roles that make any node a field a value goes into. */
const editableRoles = ["textbox", "searchbox", "combobox", "spinbutton"] as const

function normalise(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

/** One attribute read the way the page's own tokens compare: trimmed, lowercased. */
function attributeToken(description: DomNodeDescription, name: string): string {
	return (description.attributes[name] ?? "").trim().toLowerCase()
}

/**
 * Whether the accessible name is part of this node's identity as a field. The
 * rule is the public classifier's for the same reason it holds there: a link
 * or a button carries its own visible text as that name, and `Log in` names
 * what the control does rather than which credential a field would hold.
 */
function isEditableField(description: DomNodeDescription): boolean {
	if ((editableNodeNames as readonly string[]).includes(description.nodeName.toUpperCase())) {
		return true
	}
	const editable = attributeToken(description, "contenteditable")
	if (editable !== "" && editable !== "false") return true
	return (editableRoles as readonly string[]).includes(attributeToken(description, "role"))
}

/**
 * Classifies one field as one half of the credential pair, or as neither.
 *
 * Password wins when both halves would match, because a field the page calls a
 * password is a password: an identifier like `username_password` names what
 * the field holds, not what the account is called.
 */
export function credentialFieldKind(
	description: DomNodeDescription,
	accessibleName = "",
): CredentialFieldKind | undefined {
	if (attributeToken(description, "type") === "password") return "password"
	const autocomplete = attributeToken(description, "autocomplete").split(/\s+/)
	const heard = isEditableField(description) ? normalise(accessibleName) : ""
	const identifier = [
		...identifierAttributes.map((attribute) => normalise(description.attributes[attribute] ?? "")),
		heard,
	].join(" ")
	if (
		autocomplete.some((token) =>
			(passwordAutocompleteTokens as readonly string[]).includes(token)
		) ||
		passwordIdentifierFragments.some((fragment) => identifier.includes(fragment))
	) {
		return "password"
	}
	if (
		autocomplete.some((token) =>
			(usernameAutocompleteTokens as readonly string[]).includes(token)
		) ||
		usernameIdentifierFragments.some((fragment) => identifier.includes(fragment))
	) {
		return "username"
	}
	return undefined
}
