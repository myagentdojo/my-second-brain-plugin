/**
 * Every bound this Module works within: each bounded wait one start may legally
 * perform, the staleness bound derived from them, and the bounds one Controlled
 * Page command works within.
 *
 * A start writes a durable receipt and then works for as long as its own bounded
 * steps allow. Another command reading that receipt decides whether the start is
 * still running or has died, and a start judged dead has its process group
 * stopped and its state removed. That decision is only truthful while the
 * staleness bound dominates everything a live start can legally still be doing:
 * a shorter bound classifies an active transaction as abandoned and terminates
 * it. The bound is therefore derived here from the same numbers the work uses,
 * so the two cannot drift apart.
 */

/** One loopback socket probe, before the port is claimed. */
export const portProbeTimeoutMs = 300

/** Confirming the spawned process appears in the process table. */
export const spawnConfirmationAttempts = 20
export const spawnConfirmationPauseMs = 25

/** Verifying the CDP endpoint belongs to the launched browser. */
export const endpointAttempts = 40
export const endpointPauseMs = 100

/** One bounded loopback JSON read; endpoint verification makes two per attempt. */
export const loopbackReadTimeoutMs = 500
const loopbackReadsPerAttempt = 2

/** Waiting for a signalled process group to be observed absent. */
export const groupAbsenceAttempts = 40
export const groupAbsencePauseMs = 50
export const escalatedAbsenceAttempts = 20

/**
 * The longest a start's own bounded steps can legally take, counting each step
 * at its worst case. Nothing in a start waits without a bound, so this is a
 * real ceiling rather than an estimate.
 */
export const startBudgetMs = portProbeTimeoutMs +
	spawnConfirmationAttempts * spawnConfirmationPauseMs +
	endpointAttempts * (loopbackReadsPerAttempt * loopbackReadTimeoutMs + endpointPauseMs) +
	(groupAbsenceAttempts + escalatedAbsenceAttempts) * groupAbsencePauseMs

/**
 * The age past which a start is treated as abandoned. It dominates the budget
 * with a whole budget of margin, so a start that is merely slow is never
 * mistaken for one that died.
 */
export const startingTimeoutMs = startBudgetMs * 2

/**
 * The Controlled Page bounds. They are deliberately outside the start budget: a
 * page command runs after a start has finished and never extends one, so
 * folding them into the budget would stretch the staleness bound for work no
 * start can be doing.
 */

/** Opening one CDP conversation with the Controlled Page. */
export const pageConnectTimeoutMs = 2_000

/** One CDP request and its reply. */
export const pageCallTimeoutMs = 5_000

/**
 * How long a Snapshot Reference may still be used.
 *
 * A reference names a live element of a page that can change without Warm
 * Browser observing it, so it is trusted only inside one short working window.
 * Every use re-proves the Controlled Page identity as well, so this bound is
 * the outer limit rather than the only guard.
 */
export const snapshotReferenceTimeoutMs = 60_000

/** The most elements one Snapshot Generation may carry. */
export const snapshotElementLimit = 500

/** The longest role or name one snapshot element may carry. */
export const snapshotTextLimit = 256

/** The longest value one fill may type. */
export const fillValueLimit = 4_096

/** The most bytes one Screenshot of the Controlled Page may be. */
export const screenshotByteLimit = 16 * 1024 * 1024

/** The largest pixel dimension one Screenshot may declare. */
export const screenshotPixelLimit = 20_000

/** The same bound expressed in the base64 the page answers with. */
export const screenshotBase64Limit = Math.ceil(screenshotByteLimit / 3) * 4
