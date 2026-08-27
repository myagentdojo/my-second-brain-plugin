/**
 * Every bounded wait one start may legally perform, and the staleness bound
 * derived from them.
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
