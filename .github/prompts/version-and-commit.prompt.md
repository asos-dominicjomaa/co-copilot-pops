---
agent: 'agent'
description: Analyze local changes, bump version (patch/minor), update changelog, and commit (no push)
---

Run a full **version-and-commit** flow for this repository.

## Rules

1. **Never push**. Commit only.
2. **Never bump major** unless the user explicitly says `major`.
3. If there are no local changes, stop and report that nothing needs versioning.
4. Use the version in `package.json` as the source of truth.
5. Update/create `changelog.md` with concise entries (**max 2-3 bullets per version entry**).
6. **Never include any co-author trailers** in commit messages.

## Bump decision policy

- Choose **minor** when changes include new user-facing capability or feature surface (for example: new commands, new workflows, new UI capabilities, new import/export behavior).
- Choose **patch** for fixes, refactors, docs-only changes, styling tweaks, tests, chores, and maintenance.
- If unsure between patch/minor, choose **patch**.

## Steps

1. Inspect local git changes and summarize impacted files.
2. Decide bump type (`patch` or `minor`) using the policy above.
3. Bump `package.json` version accordingly.
4. Update `changelog.md`:
   - Add a new top entry for the new version and current date.
   - Include 2-3 concise bullets summarizing the actual change set.
5. Commit all relevant modified files with a concise message like:
   - `chore(release): vX.Y.Z`
6. In your response, include:
   - Chosen bump type and why
   - New version
   - Commit SHA
   - The exact changelog entry text
   - A clear note that nothing was pushed
