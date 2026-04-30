# Agent Workflow

> TODO: more placeholder than exact, express some intent on process but not directives yet
>
> TODO: **Use /work to capture multi-session/agent work when iterating _towards_ /doc/specs/*.md **or** more complex validating-approaches/testing-data-collection/troubleshooting-interop-issue/collecting-test-data/etc _after_ spec has been implemented**
>
> TODO: see .claude/rules/**, AGENTS.md,**/AGENTS.md, docs/WORKFLOW.md,
>
> BUT mainly focus on work/20260430A-initial-design/GOAL.md which has the current content for this
>
> Consider any other **/*.md as potential services, since some .claude/rules and/or AGENT.md may belong here instead.  Or vise verse some information to could be here might be better in a .claude/rules and/or AGENT.md <== balancing is going to be on-going work

## Using /work directory

1. Create /work/_name_
2. Write GOAL.md + PLAN.md
3. Implement, research/"explore", or compose specs or doc per PLAN.md based on GOAL.md
4. Update STATUS.md
5. If stable → create or update spec
6. Extract insights to /doc/ARCHITECTURE.md
7. Consider if instructions were wrong or lacking in session work, and flag in /work/_name_/STATUS.md

## /work <-> /doc/specs/S###-spec-name.md <-> src/**+ test/**

/work/_name_ provides grounding to a spec, and should be linked.  src/** <-> doc/spec

## GitHub Issues and PRs and "Bugs"

For smaller issues, either problem is code or spec.  If spec is clear, and code is wrong => fix.  If request goes against existing spec, and code is right => determine if bug in spec => and fix spec and code **if** within general scope of spec.  Otherwise, consider new /work to evaluate request and create PLAN.md which may result in new spec or update existing spec based on STATUS.md after work.  Also same /work<->/doc/specs workflow for "substantive" changes to codebases.  

If work related to a GitHub "thing" like PR, Issue, CodeQL, etc.=> always update any the related GitHub PR, Issue **in addition** to our docs
