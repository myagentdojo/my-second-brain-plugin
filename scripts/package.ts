import { basename, resolve } from "node:path"

import { readCommittedKitPin, runPackageCommand } from "./package-adapter"

const root = resolve(import.meta.dir, "..")

// Bundle admission, source observation, and preparation refuse before any Kit process runs.
const outcome = runPackageCommand(root, process.env)

if (outcome.kind === "packaged") {
	const pin = readCommittedKitPin(root, process.env)
	console.log(
		JSON.stringify({
			archive: outcome.artifacts.archive.path,
			checksums: outcome.artifacts.checksums.path,
			archiveBytes: outcome.artifacts.archive.bytes,
			archiveDigest: outcome.artifacts.archive.sha256,
			checksumsSha256: outcome.artifacts.checksums.sha256,
			sourceCommit: outcome.sourceIdentity.commit,
			bindingSha256: outcome.bindingSha256,
			kit: pin,
		}),
	)
} else if (outcome.kind === "process-guard") {
	console.error(
		JSON.stringify({
			packaging: outcome.kind,
			exitCode: outcome.exitCode,
			signal: outcome.signal,
			repair: "The Kit package process exceeded the consumer guard; inspect the host compressor and rerun.",
		}),
	)
	process.exit(1)
} else {
	const archive = outcome.artifacts.archive?.path
	const repair =
		outcome.kind === "not-admitted"
			? "Commit the agent-plugin-kit pin in package.json and link a clean physical Kit checkout at that commit."
			: outcome.kind === "refused"
				? `Inspect dist/ for a stale same-name candidate (${archive ? basename(archive) : "archive and checksums"}); remove a stale local candidate before packaging again.`
				: outcome.kind === "partial"
					? "The archive was published without checksums; inspect dist/ and complete or remove the candidate."
					: outcome.kind === "retry"
						? "A transient pre-publication failure occurred; rerun packaging."
						: "Inspect dist/ and the Kit diagnostics before packaging again."
	console.error(
		JSON.stringify({
			packaging: outcome.kind,
			exitCode: outcome.exitCode,
			resultCode: outcome.resultCode,
			stationId: outcome.stationId,
			transactionState: outcome.transactionState,
			message: outcome.message,
			nextAction: outcome.nextAction,
			artifacts: outcome.artifacts,
			repair,
		}),
	)
	process.exit(outcome.exitCode === 0 ? 1 : outcome.exitCode)
}
