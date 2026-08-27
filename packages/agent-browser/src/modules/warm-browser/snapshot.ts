import { snapshotReferenceTimeoutMs } from "./bounds"
import type { ControlledPageBasis, ControlledPageElement } from "./contract"

/**
 * The Snapshot Generation and the Snapshot References issued against it.
 *
 * A reference names one element of one generation of one Controlled Page, and
 * it carries the generation in its own text. That is what makes it short-lived
 * without a registry of dead references: a reference from an earlier generation
 * names a generation nothing holds any more, so it cannot resolve, and the next
 * snapshot invalidates every earlier reference by existing.
 */

export interface SnapshotGeneration {
	readonly generationId: string
	readonly takenAtEpochMs: number
	readonly basis: ControlledPageBasis
	readonly truncated: boolean
	readonly elements: readonly ControlledPageElement[]
}

/**
 * One reference is an element ordinal at a generation. The ordinal is bounded
 * so a reference can never be longer than the identifier it names.
 */
const referencePattern = /^e([1-9][0-9]{0,3})@([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/

function snapshotReference(generationId: string, ordinal: number): string {
	return `e${ordinal}@${generationId}`
}

/** The elements one snapshot publishes: names and references, never selectors. */
export function publishedElements(
	generation: SnapshotGeneration,
): readonly Record<string, unknown>[] {
	return generation.elements.map((element, index) => ({
		ref: snapshotReference(generation.generationId, index + 1),
		role: element.role,
		name: element.name,
		credentialField: element.credentialField,
	}))
}

export type ReferenceResolution =
	| { readonly kind: "resolved"; readonly ordinal: number; readonly element: ControlledPageElement }
	/** Not a Snapshot Reference at all, which is what a public selector is. */
	| { readonly kind: "malformed" }
	/** Well formed, but this session holds no Snapshot Generation. */
	| { readonly kind: "absent" }
	/** Well formed and current, but this generation has no such element. */
	| { readonly kind: "unknown" }
	/** Issued against another generation, another page, or too long ago. */
	| { readonly kind: "stale" }

export function resolveSnapshotReference(input: {
	readonly reference: string
	readonly generation: SnapshotGeneration | undefined
	readonly controlledPageTargetId: string
	readonly nowEpochMs: number
}): ReferenceResolution {
	const match = referencePattern.exec(input.reference)
	if (match === null) return { kind: "malformed" }
	const generation = input.generation
	if (generation === undefined) return { kind: "absent" }
	if (match[2] !== generation.generationId) return { kind: "stale" }
	// A reading before the generation was taken cannot age it, so it is never
	// treated as fresh: an unusable clock leaves the reference unusable too.
	const age = input.nowEpochMs - generation.takenAtEpochMs
	if (age < 0 || age > snapshotReferenceTimeoutMs) return { kind: "stale" }
	if (generation.basis.targetId !== input.controlledPageTargetId) return { kind: "stale" }
	const ordinal = Number(match[1])
	const element = generation.elements[ordinal - 1]
	return element === undefined ? { kind: "unknown" } : { kind: "resolved", ordinal, element }
}
