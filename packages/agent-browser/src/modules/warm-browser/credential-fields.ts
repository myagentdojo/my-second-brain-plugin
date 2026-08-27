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

/** The attributes an identifier fragment is looked for in. */
const identifierAttributes = ["name", "id", "autocomplete", "aria-label", "placeholder"] as const

function normalise(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

/**
 * Classifies one field from what the page says about it and from the name a
 * reader would hear.
 *
 * The accessible name is part of the identity: a field labelled `Username` with
 * no attribute saying so is still the field that names the account. A field this
 * Module could not describe at all is also treated as credential material,
 * because an undescribed field cannot be ruled out and a refusal is recoverable.
 */
export function isCredentialField(
	description: DomNodeDescription | undefined,
	accessibleName = "",
): boolean {
	if (description === undefined) return true
	const attributes = description.attributes
	const type = (attributes.type ?? "").trim().toLowerCase()
	if ((credentialInputTypes as readonly string[]).includes(type)) return true
	const autocomplete = (attributes.autocomplete ?? "").trim().toLowerCase().split(/\s+/)
	if (autocomplete.some((token) => (credentialAutocompleteTokens as readonly string[]).includes(token))) {
		return true
	}
	const identifier = [
		...identifierAttributes.map((attribute) => normalise(attributes[attribute] ?? "")),
		normalise(accessibleName),
	].join(" ")
	return credentialIdentifierFragments.some((fragment) => identifier.includes(fragment))
}
