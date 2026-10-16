---
applyTo: "src/**,scripts/**,test/**,commands/**,docs/**,.github/**,*.md"
---

# PR review bots (Copilot + CodeRabbit + locally run reviewers)

How automated reviews manifest on a centrs PR, why each looks different from a
`gh` point of view, and what "wrapping a PR" actually requires before `main`
will merge it.

When a centrs PR is opened, `copilot-pull-request-reviewer` and `coderabbitai`
review it automatically. Locally run reviewers (Codex, hermes + muse-spark) may
also post, but only when the maintainer runs one. They surface findings through
*different* GitHub mechanisms, so an agent that checks only one signal will
misread the state of the PR.

- **Copilot is a requested reviewer**, not a required check. Its review lands as
  state `COMMENTED`, never `CHANGES_REQUESTED`, so
  `gh pr view N --json reviewDecision` will **not** show it as blocking — the
  findings are real but invisible to a decision-status check. It reviews **once**:
  the ruleset sets `review_on_push: false`, so a fix push gets no new Copilot
  pass. Re-request one with `gh pr edit N --add-reviewer @copilot`.
- **CodeRabbit is a required status check** (`CodeRabbit` in branch protection)
  and also reviews **once**, when the PR is ready: `.coderabbit.yaml` sets
  `auto_incremental_review: false` to conserve prepaid credits. A fix push gets
  no new pass. Ask for one on the current head with an `@coderabbitai review`
  PR comment. The check is a **liveness** signal, not a coverage one — it is
  green in all of these states:

  | Status text | What it means |
  | --- | --- |
  | `Review completed` | It reviewed some commit range of this PR. |
  | `Review skipped: incremental reviews are disabled` | It did not look at this head. |
  | `Review rate limited` | It did not look at all. |

  Of the last 80 PR heads (2026-10-16), 8 showed `Review completed`; 56 showed
  the incremental skip and 12 the rate limit. Green says nothing about whether
  your fix was reviewed — see *Confirming the head was reviewed* below.
- **Locally run reviewers post under the `mobileskyfi` account**, not a distinct
  bot login: Codex, hermes + muse-spark, and any other harness that drives `gh`
  as the maintainer. Their output lands as inline review threads **or** as PR
  conversation comments. A review-shaped `mobileskyfi` comment may be one of
  these, but the login alone does not prove it — the maintainer posts there too.
  These reviews are maintainer-triggered: do not assume one ran, and do not wait
  for one unless asked.
- **`github-advanced-security` posts code-scanning alerts as inline threads.**
  They follow the alert: when a later analysis closes the alert (code fix or a
  `codeql-config.yml` filter), the thread drops out of the unresolved list. Fix
  the alert, not the thread.

## What actually blocks the merge

`main` is branch-protected with **required status checks** (`Repo checks`,
`Unit tests & coverage`, `Build`, `CHR smoke (stable)`, `CodeRabbit`) **plus
required conversation resolution**, `enforce_admins: false` (an admin can still
override the button or merge via `gh`).

Because every reviewer submits `COMMENTED` (never `CHANGES_REQUESTED`),
`gh pr view N --json reviewDecision` stays **empty** — it is *not* the signal to
watch. The block surfaces as `mergeStateStatus: BLOCKED`, driven by the
**unresolved review threads**. Resolving every thread is what clears the gate.
A clear gate means the threads that exist are resolved; it does not mean the
current head was reviewed.

```sh
gh pr view N --json mergeable,mergeStateStatus,reviewDecision \
  --jq '{mergeable,mergeStateStatus,reviewDecision}'
```

## Wrapping a PR

Findings live in **two places**, and `gh pr view` shows neither in full. Read
both:

```sh
# Inline review comments (Copilot, CodeRabbit, code scanning, local reviewers).
# --paginate: the endpoint is paged. .line // .original_line: outdated comments
# carry line:null, so fall back to print the location.
gh api --paginate repos/tikoci/centrs/pulls/N/comments \
  --jq '.[] | "\(.user.login) \(.path):\(.line // .original_line)\n\(.body)\n"'

# PR conversation comments. A locally run review often lands here as one
# comment with every item in it, and the inline query above never shows it.
gh api --paginate repos/tikoci/centrs/issues/N/comments \
  --jq '.[] | "\(.user.login) \(.created_at)\n\(.body)\n"'
```

For each finding: fix it, or dismiss it with a grounded reason. **Replying to a
thread does not resolve it** — resolution is a separate, explicit action, and
this is the step that keeps biting. Reply with the fixing commit SHA for the
audit trail, then resolve. You own the bot threads (Copilot / CodeRabbit /
a local reviewer as `mobileskyfi`); do not resolve a genuine human reviewer's
thread on their behalf. A finding in a conversation comment has no thread to
resolve: answer it in a reply comment.

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
- **A fix push gets no bot review on its own.** Neither CodeRabbit nor Copilot
  re-reviews on push; the `CodeRabbit` check goes green with
  `Review skipped: incremental reviews are disabled`. Do not wait for a pass
  that is not coming. When the fix needs review, request it
  (`@coderabbitai review` comment, `gh pr edit N --add-reviewer @copilot`),
  wait for that review, then re-run both findings queries and the
  unresolved-threads query. Only when that list is empty *and* the required
  checks are green is the conversation gate clear.

### Confirming the head was reviewed

When a report says a PR "was reviewed", check which commits the review covered:

- **CodeRabbit:** its review body names the range — `Reviewing files that
  changed from the base of the PR and between <base> and <head>`. Coverage
  ends at `<head>`. Compare it with `gh pr view N --json headRefOid`.
- **Copilot:** a Copilot review's `commit_id` is the commit it reviewed.
- **Do not use `commit_id` on an empty-body review.** Replying to a thread
  creates a review with no body whose `commit_id` is the current head. Bot
  replies to your thread replies show up the same way.

```sh
gh api --paginate repos/tikoci/centrs/pulls/N/reviews \
  --jq '.[] | select(.body != "") | "\(.user.login) \(.commit_id[0:7]) \(.submitted_at)"'
```

If the last covered commit is older than the head, say so in the report: the
commits after it were not bot-reviewed.
