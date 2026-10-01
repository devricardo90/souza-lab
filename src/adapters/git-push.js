import { git, GitError } from "./git-workspace.js";

/**
 * Exact-HEAD push with remote reconciliation. A successful `git push` is NOT confirmation: the remote branch head is
 * read back from the remote system and must equal the expected SHA before the Loop advances.
 *
 *   verify local facts (HEAD == expected, expected branch, clean tree)
 *   -> read the remote head
 *        == expected                      already pushed (idempotent, also the post-crash path): no push at all
 *        absent                           push
 *        fast-forwardable to expected     normal (non-force) push, e.g. a correction commit on the same branch
 *        anything else (diverged)         refuse: never force, never overwrite remote work
 *   -> push the exact branch -> read the remote head again -> must equal expected
 *
 * `readRemoteHead(branch)` returns the remote head SHA or null; it is supplied by the SCM boundary (GitHub API) so the
 * confirmation comes from the remote system, not from the push command's own exit status.
 */

export class PushError extends Error {
  constructor(message, code = "PUSH_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "PushError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export async function pushExactHead({ workspacePath, branch, expectedHead, readRemoteHead, remote = "origin", assertLeaseCurrent = null }) {
  if (!FULL_SHA.test(expectedHead ?? "")) throw new PushError("expectedHead must be a full commit SHA", "PUSH_INVALID_INPUT", "INVARIANT_VIOLATION");
  const localHead = git(workspacePath, ["rev-parse", "HEAD"]).trim();
  const localBranch = git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const dirty = git(workspacePath, ["status", "--porcelain=v1", "-uall"]).trim() !== "";
  if (localHead !== expectedHead) throw new PushError(`local HEAD ${localHead} is not the expected ${expectedHead}`, "PUSH_LOCAL_HEAD_MISMATCH", "INVARIANT_VIOLATION");
  if (localBranch !== branch) throw new PushError(`local branch ${localBranch} is not the expected ${branch}`, "PUSH_LOCAL_BRANCH_MISMATCH", "INVARIANT_VIOLATION");
  if (dirty) throw new PushError("the workspace has uncommitted changes; the exact HEAD is not the whole implementation", "PUSH_DIRTY_WORKSPACE", "INVARIANT_VIOLATION");

  const before = await readRemoteHead(branch);
  if (before === expectedHead) return Object.freeze({ pushed: false, confirmed: true, remoteHead: before, reason: "ALREADY_AT_EXPECTED_HEAD" });
  if (before !== null) {
    const known = git(workspacePath, ["cat-file", "-e", `${before}^{commit}`], { allowFailure: true }) !== null;
    const fastForward = known && git(workspacePath, ["merge-base", "--is-ancestor", before, expectedHead], { allowFailure: true }) !== null;
    if (!fastForward) throw new PushError(`remote branch ${branch} is at ${before}, which is not an ancestor of ${expectedHead}; refusing to overwrite`, "PUSH_REMOTE_DIVERGED", "OWNER_REQUIRED");
  }
  if (assertLeaseCurrent) await assertLeaseCurrent();
  try { git(workspacePath, ["push", remote, `${expectedHead}:refs/heads/${branch}`]); } // explicit refspec, never --force
  catch (error) {
    if (!(error instanceof GitError)) throw error;
    // The command failed or timed out: its outcome is UNKNOWN until the remote is read back (it may have landed).
    const after = await readRemoteHead(branch).catch(() => null);
    if (after === expectedHead) return Object.freeze({ pushed: true, confirmed: true, remoteHead: after, reason: "CONFIRMED_AFTER_COMMAND_ERROR" });
    throw new PushError(`git push failed: ${error.message}`, "PUSH_FAILED", "TRANSIENT");
  }
  const after = await readRemoteHead(branch);
  if (after !== expectedHead) throw new PushError(`remote branch head is ${after ?? "absent"} after the push, expected ${expectedHead}`, "PUSH_UNCONFIRMED", "TRANSIENT");
  return Object.freeze({ pushed: true, confirmed: true, remoteHead: after, reason: "PUSHED_AND_CONFIRMED" });
}
