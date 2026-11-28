# sendit: notes for Claude

An orbital mission planner played in the browser, with a server-side leaderboard. README.md is the
reference for physics, the editor, CI, hosting and the deploy pipeline; this file holds the working rules.

## Changing code

- **Physics must stay bit-identical.** Replays are checked against golden digests and must match across
  engines (Chromium, WebKit, Firefox) and the server. Don't reorder floating-point operations or introduce
  fused multiply-add or fast-math anywhere in `src/physics/` or the mission replay. A deliberate physics or
  mission-version change is a release (README, "Release: …").
- **The UI must work on phones.** Layouts from about 360 px wide, pointer events (no mouse-only or
  hover-only interactions), tap targets around 44 px, no keyboard-only actions. Check UI changes at a phone
  viewport as well as desktop.
- **Rust core (`core/`).** A port of the physics to Rust, built to WASM for the browser and natively for
  the leaderboard Lambda, is in progress. Gameplay physics stays in the browser; the cloud is only for
  leaderboard validation. Avoid restructuring the TypeScript physics while the port is underway.

## Running things locally

- Dev server: `pnpm dev`. Checks: `pnpm typecheck`, `pnpm test`.
- **Wrap heavy commands in `scripts/when-idle.sh`** (Playwright suites, full unit runs, builds, cargo
  builds and benchmarks). It waits until the machine's load allows it, so parallel agents don't swamp the
  computer.
- Run only the browser specs you touched locally; the full browser suite runs in GitHub CI.

## Git, PRs and deploys

- **Always commit changes.** Commit finished work to a branch, push it and open a PR; don't leave edits
  uncommitted in the working tree.
- `main` is protected: no direct pushes. Every change goes through a PR.
- The one required check is **"CI passed"** (the `gate` job in `.github/workflows/ci.yml`), which
  succeeds only when every CI job did. Don't merge on a red or unfinished run.
- **Merge with a merge commit, never squash or rebase.** Queue PRs with `gh pr merge <n> --merge --auto`;
  they merge once CI passes.
- **Deploys are automatic.** A green CI run on `main` runs `.github/workflows/deploy.yml` (while the
  repository variable `DEPLOY_ENABLED` is `true`). A red `main` deploys nothing, so later merges wait
  behind it. Manual redeploys and rollbacks: Actions → Deploy → Run workflow (README, "Deploy pipeline").

## Keeping this file current

When work on the repo turns up something a future session should know (a rule, a gotcha, a workflow),
suggest adding it here.
