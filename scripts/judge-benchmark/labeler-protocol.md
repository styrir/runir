# Supersession pair labeling protocol (`supersession_label_v2.1`, three-way)

> v2.1 (2026-09-24): added rule 5 (provenance blocks). v2 was used for `supersession-fresh-v1`; there rule 5
> was applied during reconciliation.

You are one of two INDEPENDENT labelers. Judge each pair only from the two texts in front of you.
Do not use tools, files, or the web.

Each pair has **OLD**, an earlier stored memory, and **NEW**, a later memory, with their creation
times. Assign exactly one label per pair.

## Labels

- **`supersede`**: NEW makes OLD stale. Both are about the SAME subject and the SAME attribute or slot,
  which can hold only one value at a time, and NEW gives a different, current value. Retiring OLD loses
  nothing that is still true. Typical shapes:
  - status slot succession: the same task, review or workstream moves to a new state
  - stale → refreshed: the same subject with a newer value
  - an explicit replacement: "switched from X to Y", "no longer X", "X was wrong; it is Y"
  - the same tracker, file:line or id carrying the SAME fact with an updated value
- **`duplicate`**: NEW restates the SAME claim as OLD, with no new information and the same value. A
  paraphrase of the same claim is a duplicate even if the wording differs a lot.
- **`independent`**: both can stay. Use this for any of:
  - different facts, even with the same project, session, file, tool or topic
  - NEW adds detail to OLD
  - a non-exclusive attribute (several things can be true at once)
  - a **continuation**: NEW is the fix, result, next step, follow-up, review verdict or refinement of
    what OLD records. OLD remains valid history (the why, the diagnosis, the plan) unless NEW itself
    restates all of it.
  - partial overlap where retiring OLD would lose a still-valid detail

## Rules

1. **Doubt → `independent`.** Retiring a memory destroys it. Only choose `supersede` or `duplicate`
   when the same-subject/same-slot identity is clear from the text.
2. Shared tokens are not identity. Sharing a project name, bead or issue prefix, tool name, model name,
   or file path does not make two statements the same fact. Two different bugs in the same file are
   `independent`.
3. Direction matters. NEW is later. `supersede` means NEW replaces OLD.
4. Judge the text, not how similar the wording looks.
5. Ignore provenance blocks. A memory may end with a `Source:` or `Exact source list:` block copied from the
   conversation turn it came from. Two facts extracted from the same turn share that block verbatim.
   Judge identity on the fact statement ABOVE the block; a shared block does not make two facts the same.

## Output

Return ONLY JSON Lines, one object per pair, in any order, covering every pair in the batch exactly once:

```
{"pairId":"<id>","label":"supersede|duplicate|independent","reason":"<≤ 25 words: the identity basis or its absence; never copy secrets or long verbatim text>"}
```
