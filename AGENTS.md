# Repository Instructions

## GitHub-First Workflow

- For any coding, shipping, PR, merge, comment-resolution, or deploy-related work in this repo, always use the GitHub workflow first.
- Always use the `gh-address-comments` skill when a PR exists or when work should end in a PR.
- Prefer the `github-default` skill for repo work that should end in a pushed branch, PR, or merge.
- Never leave changes only locally when the user expects them shipped.

## Default Delivery Flow

1. Work on a `codex/*` branch.
2. Commit the changes.
3. Push the branch to GitHub.
4. Open or update a PR.
5. Wait 5 minutes for Gemini or other review suggestions if those review surfaces are available in the current workflow.
6. Review those suggestions with your own judgment and fix valid issues through GitHub.
7. Merge through GitHub when ready.
8. Report the PR URL and merge commit in the final handoff.

## Intent Rules

- If the user asks to `push`, `ship`, `open PR`, `merge`, `fix comments`, `deploy`, or similar, treat that as GitHub workflow work, not local-only git work.
- Do not stop after local edits when the user intent is clearly to ship.
- Do not merge immediately after opening a PR unless the user explicitly says to skip the review wait.
