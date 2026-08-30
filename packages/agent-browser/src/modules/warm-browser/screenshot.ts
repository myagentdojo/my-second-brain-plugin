import { createHash } from "node:crypto"

import { screenshotByteLimit, screenshotPixelLimit } from "./bounds"

/**
 * The Screenshot a Browser Session owns, and what a capture must prove before
 * it becomes one.
 *
 * A capture is only a Screenshot once its bytes have been proved to be one
 * complete PNG image whose dimensions this file itself states. The page is the
 * one that produced the bytes, and a page's answer is never trusted to be what
 * it claims: bytes kept without this proof would be published under a name and
 * a size nothing verified, and a caller reading them would be reading whatever
 * the page chose to say.
 */

/** What one proved Screenshot of the Controlled Page turned out to be. */
export interface OwnedScreenshotImage {
	readonly width: number
	readonly height: number
	readonly sha256: string
}

/**
 * The names an owned Screenshot file may have. The name becomes a path segment,
 * so anything that could steer that path elsewhere is not a name this Module
 * will write: no separator, no dot, no relative segment.
 */
const ownedScreenshotName = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isOwnedScreenshotName(value: unknown): value is string {
	return typeof value === "string" && ownedScreenshotName.test(value)
}

/** The file one owned Screenshot name has inside the session's own directory. */
export function ownedScreenshotFile(name: string): string {
	return `${name}.png`
}

/** The eight bytes every PNG stream begins with. */
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const

/** The twelve bytes of the IEND chunk, which only a complete stream ends with. */
const pngTrailer = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130] as const

/** The bit depths and colour types PNG's own header may declare. */
const pngBitDepths = [1, 2, 4, 8, 16] as const
const pngColourTypes = [0, 2, 3, 4, 6] as const

/** The fewest bytes a PNG can be: signature, IHDR chunk, and IEND chunk. */
const pngLengthFloor = 8 + 25 + 12

/**
 * One big-endian unsigned 32-bit value, read with explicit arithmetic on the
 * bytes themselves, so a view whose buffer begins elsewhere cannot shift what
 * is read.
 */
function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset]! * 0x1000000 +
		bytes[offset + 1]! * 0x10000 +
		bytes[offset + 2]! * 0x100 +
		bytes[offset + 3]!
	)
}

/**
 * Reads one complete PNG image, or answers that these bytes are not one.
 * Undefined is the only answer for bytes that cannot be proved: a signature
 * that is not PNG's, a header that is not IHDR, a dimension outside the bound,
 * and a stream that does not end in IEND are all the same to the caller, which
 * is that nothing here may be kept as a Screenshot.
 */
export function readPortableNetworkGraphic(bytes: Uint8Array): OwnedScreenshotImage | undefined {
	if (bytes.length < pngLengthFloor || bytes.length > screenshotByteLimit) return undefined
	if (!pngSignature.every((expected, index) => bytes[index] === expected)) return undefined
	// The first chunk must be the header itself: thirteen bytes long and named
	// IHDR, which is where the image states its own dimensions.
	if (readUint32(bytes, 8) !== 13) return undefined
	if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
		return undefined
	}
	const width = readUint32(bytes, 16)
	const height = readUint32(bytes, 20)
	if (width < 1 || width > screenshotPixelLimit) return undefined
	if (height < 1 || height > screenshotPixelLimit) return undefined
	if (!(pngBitDepths as readonly number[]).includes(bytes[24]!)) return undefined
	if (!(pngColourTypes as readonly number[]).includes(bytes[25]!)) return undefined
	// A stream that does not end in IEND was cut off somewhere, and a truncated
	// image is not the page: it is however much of the page happened to arrive.
	const trailerAt = bytes.length - pngTrailer.length
	if (!pngTrailer.every((expected, index) => bytes[trailerAt + index] === expected)) {
		return undefined
	}
	return { width, height, sha256: createHash("sha256").update(bytes).digest("hex") }
}
