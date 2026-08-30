import { expect, test } from "bun:test"

import { credentialFieldKind } from "../src/modules/private-delivery/field-kind"
import type { DomNodeDescription } from "../src/modules/warm-browser/credential-fields"

function field(
	attributes: Readonly<Record<string, string>>,
	nodeName = "INPUT",
): DomNodeDescription {
	return { nodeName, attributes }
}

test.each([
	["password type", field({ type: "password" }), "", "password"],
	["current-password autocomplete", field({ autocomplete: "current-password" }), "", "password"],
	["new-password autocomplete", field({ autocomplete: "new-password" }), "", "password"],
	["username autocomplete", field({ autocomplete: "username" }), "", "username"],
	["passwd name", field({ name: "account_passwd" }), "", "password"],
	["pwd id", field({ id: "primary-pwd" }), "", "password"],
	["passcode aria label", field({ "aria-label": "account passcode" }), "", "password"],
	["passphrase placeholder", field({ placeholder: "Enter passphrase" }), "", "password"],
	["userid name", field({ name: "account_userid" }), "", "username"],
	["login id", field({ id: "account-login" }), "", "username"],
	["editable accessible name", field({}), "Email", "username"],
	["password wins precedence", field({ name: "username_password" }), "", "password"],
	["deceptive longer token", field({ name: "passwordHint" }), "", undefined],
	["non-editable accessible name", field({}, "BUTTON"), "Log in", undefined],
] as const)("classifies %s", (_name, description, accessibleName, expected) => {
	// Independent oracle: each expected kind is literal test-owned evidence,
	// never derived from the production token lists.
	expect(credentialFieldKind(description, accessibleName)).toBe(expected)
})
