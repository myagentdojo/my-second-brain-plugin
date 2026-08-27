/**
 * The one owner of what counts as a credential field.
 *
 * Warm Browser never types authentication material. The rule therefore lives in
 * exactly one place: `fill` consults it, and a field it names is refused and
 * routed to `login`, which is where Private Delivery will own the value. The
 * rule is deliberately wide. A field wrongly named a credential is refused, and
 * a refusal is recoverable; a credential field wrongly named ordinary would put
 * a secret into an argument list.
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
] as const

/** The attributes an identifier fragment is looked for in. */
const identifierAttributes = ["name", "id", "autocomplete", "aria-label", "placeholder"] as const

function normalise(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

export function isCredentialField(description: DomNodeDescription): boolean {
	const attributes = description.attributes
	const type = (attributes.type ?? "").trim().toLowerCase()
	if ((credentialInputTypes as readonly string[]).includes(type)) return true
	const autocomplete = (attributes.autocomplete ?? "").trim().toLowerCase().split(/\s+/)
	if (autocomplete.some((token) => (credentialAutocompleteTokens as readonly string[]).includes(token))) {
		return true
	}
	const identifier = identifierAttributes
		.map((attribute) => normalise(attributes[attribute] ?? ""))
		.join(" ")
	return credentialIdentifierFragments.some((fragment) => identifier.includes(fragment))
}
