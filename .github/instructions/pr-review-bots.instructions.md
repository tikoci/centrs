---
applyTo: "src/**,scripts/**,test/**,commands/**,docs/**,.github/**,*.md"
---

# PR review bots (Copilot + CodeRabbit + Codex)

How automated reviews manifest on a centrs PR, why each looks different from a
`gh` point of view, and what "wrapping a PR" actually requires before `main`
will merge it.

When a centrs PR is opened, up to **three** automated reviewers weigh in:
`copilot-pull-request-reviewer`, `coderabbitai`, and **Codex**. They surface
findings through *different* GitHub mechanisms, so an agent that checks only one
signal will misread the state of the PR.

- **Copilot is a requested reviewer.** Its review lands as state `COMMENTED`,
  never `CHANGES_REQUESTED`, so `gh pr view N --json reviewDecision` will **not**
  show it as blocking — the findings are real but invisible to a decision-status
  check.
- **CodeRabbit is a required status check** (`CodeRabbit` in branch protection).
  Its check turns green when its review **run finishes** — green means
  "CodeRabbit is done looking," **not** "your findings are addressed." It
  re-reviews on demand via an `@coderabbitai review` PR comment.
- **Codex posts under the `mobileskyfi` account**, not a distinct bot login. So a
  `mobileskyfi`-authored review thread on a centrs PR is a **bot** thread (Codex),
  not a human reviewer — treat it as yours to resolve once the finding is handled.

## What actually blocks the merge

`main` is branch-protected with **required status checks** (`Repo checks`,
`Unit tests & coverage`, `Build`, `CHR smoke (stable)`, `CodeRabbit`) **plus
required conversation resolution**, `enforce_admins: false` (an admin can still
override the button or merge via `gh`).

Because all three reviewers submit `COMMENTED` (never `CHANGES_REQUESTED`),
`gh pr view N --json reviewDecision` stays **empty** — it is *not* the signal to
watch. The block surfaces as `mergeStateStatus: BLOCKED`, driven by the
**unresolved review threads**. Resolving every thread is what clears the gate.

```sh
gh pr view N --json mergeable,mergeStateStatus,reviewDecision \
  --jq '{mergeable,mergeStateStatus,reviewDecision}'
```

## Wrapping a PR

Findings live in **inline review comments**, which `gh pr view` does not show.
Read them explicitly:

```sh
# All inline review comments (Copilot + CodeRabbit + Codex), path:line + body.
# --paginate: the endpoint is paged. .line // .original_line: outdated comments
# carry line:null, so fall back to print the location.
gh api --paginate repos/tikoci/centrs/pulls/N/comments \
  --jq '.[] | "\(.user.login) \(.path):\(.line // .original_line)\n\(.body)\n"'
```

For each finding: fix it, or dismiss it with a grounded reason. **Replying to a
thread does not resolve it** — resolution is a separate, explicit action, and
this is the step that keeps biting. Reply with the fixing commit SHA for the
audit trail, then resolve. You own the bot threads (Copilot / CodeRabbit /
Codex-as-`mobileskyfi`); do not resolve a genuine human reviewer's thread on
their behalf.

```sh
# Still-unresolved threads (author lives on the comment, not the thread):
gh api graphql -f query='query{repository(owner:"tikoci",name:"centrs"){pullRequest(number:N){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:1){nodes{author{login}}}}}}}' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)|"\(.id)\t\(.comments.nodes[0].author.login)\t\(.path):\(.line)"'
# Resolve one (repeat per id):
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=THREAD_ID
```

### After you push a fix (the part that keeps biting)

Resolution is the **last** step before merge, run against the *live* thread list:

- **A fix push does not resolve threads for you.** When your commit changes the
  commented line, GitHub marks that thread **outdated** (`isOutdated: true`) —
  which looks handled in the web UI but is **not** `isResolved`;
  `mergeStateStatus` stays `BLOCKED` until you resolve it explicitly. Reconcile
  against the GraphQL `isResolved==false` list, never against the comment count
  (GitHub auto-drops a subset when anchored lines move, so the unresolved count
  is often smaller than the comment count).
- **Your fix push triggers a fresh bot pass that can open *new* threads.**
  CodeRabbit re-reviews on push; re-run the unresolved-threads query **after** the
  re-review settles, not the moment you push. Only when that list is empty *and*
  the required checks are green is the conversation gate clear.
