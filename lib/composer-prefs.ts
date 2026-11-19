/**
 * Client-side composer preferences (localStorage). These live outside the
 * pi's settings because they are tau UI behaviors.
 */

export type SubmitDuringRunBehavior = "steer" | "queue";

const SUBMIT_DURING_RUN_KEY = "tau:submit-during-run";

/** The default, applied when nothing was ever stored under the key. */
export const DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR: SubmitDuringRunBehavior = "queue";

/**
 * How a composer submit during a run is delivered. Defaults to `queue`:
 * queuing stays resilient while a `!!` shell command owns the session, where a
 * live steer/prompt frame would collide with the running bash command instead
 * of joining the next turn.
 *
 * Only an explicitly stored choice overrides that default — the option was
 * never written unless the user picked one, so an absent key simply yields
 * "queue" and no stored value needs rewriting.
 */
export function getSubmitDuringRunBehavior(): SubmitDuringRunBehavior {
  if (typeof window === "undefined") return DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR;
  try {
    const value = window.localStorage.getItem(SUBMIT_DURING_RUN_KEY);
    if (value === "steer" || value === "queue") return value;
  } catch {
    // storage unavailable — fall through to the default
  }
  return DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR;
}

export function setSubmitDuringRunBehavior(behavior: SubmitDuringRunBehavior): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SUBMIT_DURING_RUN_KEY, behavior);
  } catch {
    // storage unavailable — the preference simply won't persist
  }
}
