import {
	attributeToken,
	type DomNodeDescription,
	identifierAttributes,
	isEditableField,
} from "../warm-browser/credential-fields"

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
 * The reading mechanics are imported from `credential-fields.ts`, because how
 * a page's own tokens are read and compared is one rule however the answer is
 * used. Only the token and fragment lists below are this file's own: they are
 * where the wide and the narrow question genuinely differ, so neither list can
 * be widened or narrowed by an edit meant for the other.
 */

export type CredentialFieldKind = "username" | "password"

/** Autocomplete tokens the platform reserves for the password half. */
const passwordAutocompleteTokens = ["current-password", "new-password"] as const

/** Whole identifier tokens that name the password half. */
const passwordIdentifierTokens = [
	"password",
	"passwd",
	"passphrase",
	"passcode",
	"pwd",
] as const

/** The autocomplete token the platform reserves for the account-name half. */
const usernameAutocompleteTokens = ["username"] as const

/** Whole identifier tokens that name the account-name half. */
const usernameIdentifierTokens = ["username", "userid", "login", "email"] as const

/**
 * Reads page-provided identifier words without inventing camel-case
 * boundaries. `password-field` carries the whole token `password`, while
 * `passwordHint` and `notpassword` do not: those longer names are not a
 * definitive statement that the field itself receives a password.
 */
function identifierTokens(value: string): string[] {
	return value
		.trim()
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token !== "")
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
	const heard = isEditableField(description) ? identifierTokens(accessibleName) : []
	const identifiers = [
		...identifierAttributes.flatMap((attribute) =>
			identifierTokens(description.attributes[attribute] ?? "")
		),
		...heard,
	]
	if (
		autocomplete.some((token) =>
			(passwordAutocompleteTokens as readonly string[]).includes(token)
		) ||
		identifiers.some((token) =>
			(passwordIdentifierTokens as readonly string[]).includes(token)
		)
	) {
		return "password"
	}
	if (
		autocomplete.some((token) =>
			(usernameAutocompleteTokens as readonly string[]).includes(token)
		) ||
		identifiers.some((token) =>
			(usernameIdentifierTokens as readonly string[]).includes(token)
		)
	) {
		return "username"
	}
	return undefined
}
