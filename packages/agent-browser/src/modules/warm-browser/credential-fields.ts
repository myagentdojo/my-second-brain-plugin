/**
 * The one owner of what counts as a credential field.
 *
 * Warm Browser never types authentication material. The rule therefore lives in
 * exactly one place: `fill` consults it, and a field it names is refused and
 * routed to `login`, which is where Private Delivery will own the value. The
 * rule is deliberately wide. A field wrongly named a credential is refused, and
 * a refusal is recoverable; a credential field wrongly named ordinary would put
 * a secret into an argument list.
 *
 * A login identifier is credential material, not a lesser thing beside the
 * password. It is half of the pair `login` resolves and delivers, it is the half
 * that names the account, and typing it through the public interface would put
 * it in an argument list exactly as a password would. So the username side is
 * classified here on the same footing, and an address that could be the account
 * name is treated as one.
 */

export interface DomNodeDescription {
	readonly nodeName: string
	readonly attributes: Readonly<Record<string, string>>
}

/** Input types that are credential entry by definition. */
const credentialInputTypes = ["password"] as const

/** Autocomplete tokens the platform reserves for authentication material. */
const credentialAutocompleteTokens = [
	"current-password",
	"new-password",
	"one-time-code",
	"username",
] as const

/**
 * Identifier fragments that name authentication material. They are matched
 * against a normalised identifier, so `New Password` and `new_password` are the
 * same fragment.
 */
const credentialIdentifierFragments = [
	"password",
	"passwd",
	"passphrase",
	"passcode",
	"pwd",
	"otp",
	"totp",
	"2fa",
	"mfa",
	"securitycode",
	"verificationcode",
	"username",
	"userid",
	"login",
	"email",
] as const

/**
 * The exports below are how a page's own tokens are read and compared. The
 * question of which fields they are asked about belongs to each classifier:
 * this one is deliberately wide and Private Delivery's `credentialFieldKind`
 * deliberately narrow. The reading is shared so it cannot drift between them.
 */

/** The attributes an identifier fragment is looked for in. */
export const identifierAttributes = [
	"name",
	"id",
	"autocomplete",
	"aria-label",
	"placeholder",
] as const

/** Node names that are a field a value goes into, whatever else the page says. */
const editableNodeNames = ["INPUT", "TEXTAREA", "SELECT"] as const

/** Declared roles that make any node a field a value goes into. */
const editableRoles = ["textbox", "searchbox", "combobox", "spinbutton"] as const

export function normalise(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

/** One attribute read the way the page's own tokens compare: trimmed, lowercased. */
export function attributeToken(description: DomNodeDescription, name: string): string {
	return (description.attributes[name] ?? "").trim().toLowerCase()
}

/**
 * Whether this node is a surface a value could be typed into at all.
 *
 * It decides one thing only: whether the name a reader would hear is part of
 * this node's identity as a field. A link and a button carry their own visible
 * text as their accessible name, and text like `Log in` or `Email us` names what
 * the control does rather than what a field holds; reading those as credential
 * material tells a caller the control it must click is one it may not touch.
 *
 * Every attribute rule stays outside this question, because an attribute is the
 * page saying what the node is rather than what a reader would call it, and a
 * node with no description at all is refused before this is ever asked.
 */
export function isEditableField(description: DomNodeDescription): boolean {
	if ((editableNodeNames as readonly string[]).includes(description.nodeName.toUpperCase())) {
		return true
	}
	const editable = attributeToken(description, "contenteditable")
	if (editable !== "" && editable !== "false") return true
	return (editableRoles as readonly string[]).includes(attributeToken(description, "role"))
}

/**
 * Classifies one field from what the page says about it and from the name a
 * reader would hear.
 *
 * The accessible name is part of the identity: a field labelled `Username` with
 * no attribute saying so is still the field that names the account. It counts
 * only where a value could be typed, because a link or a button carries its own
 * visible text as that name. A field this Module could not describe at all is
 * treated as credential material, because an undescribed field cannot be ruled
 * out and a refusal is recoverable.
 */
export function isCredentialField(
	description: DomNodeDescription | undefined,
	accessibleName = "",
): boolean {
	if (description === undefined) return true
	const type = attributeToken(description, "type")
	if ((credentialInputTypes as readonly string[]).includes(type)) return true
	const autocomplete = attributeToken(description, "autocomplete").split(/\s+/)
	if (autocomplete.some((token) => (credentialAutocompleteTokens as readonly string[]).includes(token))) {
		return true
	}
	const heard = isEditableField(description) ? normalise(accessibleName) : ""
	const identifier = [
		...identifierAttributes.map((attribute) => normalise(description.attributes[attribute] ?? "")),
		heard,
	].join(" ")
	return credentialIdentifierFragments.some((fragment) => identifier.includes(fragment))
}
