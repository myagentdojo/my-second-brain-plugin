/**
 * Private Delivery's own closed vocabulary and its own bounds.
 *
 * These names are the whole surface the login handler sees, and every one is
 * non-secret by construction: an outcome names what happened to a delivery,
 * never what was delivered, so nothing in this vocabulary can carry a
 * credential out of the Module that owns it.
 */

/** The longest reply the disposable Private Delivery child may print. */
export const privateDeliveryChildReplyLimit = 4_096

/** The longest credential wrapper output one reading may take in. */
export const credentialWrapperOutputLimit = 1_048_576

/**
 * What one private delivery came to.
 *
 * Everything decided before the wrapper was invoked names the gate that
 * refused it, so a caller can repair approval, configuration, the wrapper, or
 * the vault without guessing which one stopped the delivery. Everything the
 * disposable child decided names what the live page did. Only `unverified`
 * carries whether the page may have been touched, because it is the one
 * outcome that cannot say what already happened: a child that got as far as
 * running may already have asked the page for focus, and an answer that did
 * not come back is never proof that it did not.
 */
export type PrivateDeliveryOutcome =
	| { readonly kind: "delivered" }
	| { readonly kind: "approval_required" }
	| { readonly kind: "vault_unconfigured" }
	| { readonly kind: "vault_unsafe" }
	| { readonly kind: "vault_unverified" }
	| { readonly kind: "vault_mismatch" }
	| { readonly kind: "match_absent" }
	| { readonly kind: "match_ambiguous" }
	| { readonly kind: "field_ambiguous" }
	| { readonly kind: "wrapper_unavailable" }
	| { readonly kind: "origin_changed" }
	| { readonly kind: "identity_changed" }
	| { readonly kind: "field_mismatch" }
	| { readonly kind: "field_not_empty" }
	| { readonly kind: "element_absent" }
	| { readonly kind: "unverified"; readonly touchedPage: boolean }

/**
 * The closed set of reply names the disposable child may print. The child
 * prints exactly one JSON line whose `outcome` is one of these, and its parent
 * interprets against the same list, so a reply neither of them owns reads as
 * no proof rather than as a new meaning.
 */
export const privateDeliveryChildOutcomes = [
	"delivered",
	"superseded",
	"identity_changed",
	"origin_changed",
	"field_mismatch",
	"field_not_empty",
	"element_absent",
	"unverified",
	"usage",
] as const

export type PrivateDeliveryChildOutcome = (typeof privateDeliveryChildOutcomes)[number]
