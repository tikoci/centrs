---
applyTo: "cspell.json,GLOSSARY.txt"
---

# CSpell glossary files

`GLOSSARY.txt` is the canonical place for shared project vocabulary and short term definitions used by prompts, docs, and cspell.

- Use cspell dictionary syntax (`~`, `+`, `-`, `!`) when it reduces duplication or clarifies how a token should be matched.
- It is okay to add a correctly spelled word when the glossary comment is the repo's canonical definition or reference for that term.
- If a misspelling only appears because the Markdown is malformed, fix the Markdown first instead of teaching cspell the broken token.
- `%term` in prompts or notes is a lightweight pointer to the matching glossary entry.
