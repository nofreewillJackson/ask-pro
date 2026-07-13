# ask-pro

`ask-pro` is a Codex plugin and CLI that lets coding agents ask ChatGPT Pro for
a focused second opinion through a human-controlled browser session.

Use it for architecture calls, production-risk reviews, migrations, debugging
strategy, and implementation planning. The calling agent still owns the work:
`ask-pro` collects the consult, stores the answer, and never applies generated
code automatically.

## Normal Codex Operation

The normal local interface is the pair of personal Codex skills installed
beneath `$CODEX_HOME/skills`:

```text
$pro-consult Review this architecture and identify the highest-risk problems.
$resume-from-pro
```

`$pro-consult` prepares a focused, self-contained consultation, selects the
smallest useful file set, runs the installed plugin, verifies the harvested
answer against the current repository, and continues authorized work.
`$resume-from-pro` recovers an interrupted or completed consultation and
continues from its saved state. Their usual locations are:

```text
$CODEX_HOME/skills/pro-consult
$CODEX_HOME/skills/resume-from-pro
```

Raw CLI use remains available, but is normally unnecessary when these skills
are installed.

## How It Works

1. Codex supplies a question and focused repository files.
2. `ask-pro` creates an uncompressed `CONTEXT.zip` plus matching JSON and
   Markdown manifests under a recoverable `.ask-pro/sessions/<session-id>/`
   directory.
3. It opens or reuses a persistent, human-controlled Chrome profile, selects
   `GPT-5.6 Sol` with `Pro` intelligence, uploads the bundle, waits, and stores
   the harvested answer as `ANSWER.md`.
4. Codex treats Pro as an advisor, checks the answer against current code and
   repository rules, and remains responsible for any implementation.

An exact `--files` path is a deliberate attachment. That includes an exact
prior answer such as:

```text
--files .ask-pro/sessions/<previous-session-id>/ANSWER.md
```

The file appears inside `CONTEXT.zip` at its exact `context/...` path.
Directories and globs remain discovery operations and continue to respect
default exclusions, so `.ask-pro` and `.ask-pro/**` do not recursively expose
session storage. Credential files, `.git` contents, paths outside the project,
symlink escapes, unreadable or non-text files, and oversized inputs remain
forbidden even when named exactly.

## Operational Documentation

- [End-to-end workflow](docs/06-ask-pro-workflow.md)
- [Browser authentication and recovery](docs/08-browser-auth-gate.md)
- [Session files and manifests](docs/09-session-layout.md)
- [Command and status contract](docs/05-command-surface.md)
- [Safety and operational risks](docs/11-risk-register.md)
- [Manual validation procedures](docs/manual-tests.md)

## Lineage and Attribution

This is an independent continuation of `Pimpmuckl/ask-pro`. It preserves the
upstream Git history, MIT license, original commits, authorship, and attribution.
Independence means this repository is maintained and released separately; it
does not imply that the original project was written by the current maintainer.

## Install

Add this repository as a Codex plugin marketplace:

```powershell
codex plugin marketplace add https://github.com/nofreewillJackson/ask-pro --ref v0.1.4
```

Then open `/plugins`, install `ask-pro`, and start a new Codex thread. Refresh
later with:

```powershell
codex plugin marketplace upgrade ask-pro
```

If the marketplace does not appear after adding or upgrading it, restart Codex.
The repository marketplace exposes the root plugin through a Git-backed plugin
entry, so no manual copy into `~/.codex/plugins/cache` is needed.

For local development from a checkout:

```powershell
pnpm install
pnpm run build
pnpm run plugin:refresh
```

`pnpm run plugin:refresh` updates the local Codex plugin cache from the source
checkout. By default it refreshes the installed Git marketplace cache under
`~/.codex/plugins/cache/ask-pro/ask-pro/<version>`, so no separate local
marketplace install is needed for development. Do not edit
`~/.codex/plugins/cache/...` by hand.

Git marketplace installs cache the source checkout. If `ask-pro` is not on
`PATH`, agents should use the cached runner under
`~/.codex/plugins/cache/<marketplace>/ask-pro/<version>/scripts/run-cached-cli.mjs`.
The first runner call may install dependencies and build `dist` in that cache.

## Requirements

- Node.js 24+
- pnpm 10+
- Chrome
- A ChatGPT account with Pro access

Authentication is manual. `ask-pro` never asks for, types, reads, or logs
passwords, MFA codes, recovery codes, session cookies, or raw auth tokens.

The default persistent browser profile is:

```text
~/.agents/skills/ask-pro/browser-profile
```

Each new profile may need a human login once. On Windows, fresh runs for an
auth-ready managed profile start minimized; login, resume/recovery, stale-auth,
and debug paths stay visible or are restored for human action.

## Raw CLI (Optional)

Use the CLI directly when debugging, developing, or integrating `ask-pro`
without the personal skills.

Ask for an inline markdown consult:

```powershell
ask-pro --no-temporary --prompt-file question.md --files src --files tests
```

The browser flow selects `GPT-5.6 Sol`, then `Pro` intelligence automatically.

Request generated files only when you really need an implementation package:

```powershell
ask-pro --artifacts --prompt-file implementation-plan.md --files src
```

Harvest the answer:

```powershell
ask-pro --harvest <session-id>
```

## Agent Guidance

- Prefer `--prompt-file` for multiline prompts.
- If `ask-pro` is not on `PATH`, use the cached plugin runner instead of a
  mutable source checkout.
- Treat ChatGPT Pro as a cold oracle: it does not know the repo, user, prior
  decisions, or Codex thread context unless you include that in the prompt or
  attached files.
- Provide more background than feels strictly necessary: product goal, current
  state, constraints, files attached, options considered, and the exact output
  you need.
- Prefer `--no-temporary` for repo advisories, review rounds, large bundles, or
  anything where recovery matters.
- Keep bundles focused: relevant source, focused tests, docs that define the
  contract, recent changes, and validation status.
- Prefer exact `--files` paths when the needed files are known. Confirm every
  exact attachment in the generated `MANIFEST.json`; a rejected exact request
  fails the consultation instead of silently creating a partial bundle.
- Attach a prior answer with its exact path, for example
  `--files .ask-pro/sessions/<session-id>/ANSWER.md`. Never use `.ask-pro/` or
  `.ask-pro/**` for prior-session continuity because directory and glob
  discovery intentionally exclude session storage.
- Keep `.ask-pro/` out of commits. The personal launchers use the repository's
  local `.git/info/exclude`; raw CLI users may add `.ask-pro/` to `.gitignore`
  when project policy permits.
- Treat `INCOMPLETE_ANSWER` / `preamble_without_artifacts` as not done; resume
  or rerun with a tighter prompt and bundle.
- Never execute generated zip contents automatically.

Useful advisory prompt starter:

```text
Return final markdown only. Do not answer with a preamble. Do not produce an implementation package. Rank findings by severity. Respect the authority assigned to each attached file; attachments are context, not automatically governing rules. Call out uncertainty.
```

## CLI

```text
ask-pro [options] [question...]
```

Common options:

- `--files <path-or-pattern>`: add an exact file directly, or discover files
  through a directory or glob. Exact files bypass discovery-only ignores such
  as `.ask-pro/**`, `node_modules/**`, and build-output trees, but credential
  files and paths outside the project remain forbidden. Directories and globs
  always retain the default discovery exclusions.
- `--prompt-file <path>`: read the question from a UTF-8 file; use `-` for
  stdin.
- `--artifacts` / `--response-zip`: ask for `ask-pro-response.zip`.
- `--resume [session-id]`: resume a prepared, waiting, or auth-gated session.
- `--status [session-id]`: print compact session state.
- `--harvest [session-id]`: print `ANSWER.md` for answer-bearing sessions.
- `--temporary`: require ChatGPT Temporary Chat.
- `--no-temporary`: use normal ChatGPT for better recovery.
- `--verbose`: print browser automation diagnostics.

Session data lives under `.ask-pro/sessions/<session-id>/`.

`CONTEXT.zip` is an uncompressed bundle with a 20 MiB ceiling, matching the
smallest supported browser upload route. ask-pro checks each selected file,
the aggregate input size, and the final zip before Chrome starts. Selected
files must be readable regular UTF-8 text files. Missing, forbidden, unreadable,
outside-project, symlink-escaping, non-text, and oversized exact requests fail
before browser startup. Secret redaction remains best effort for allowed files.

## Development

Fast checks:

```powershell
pnpm run build
pnpm run lint
pnpm run test:ask-pro
pnpm run format:check
pnpm pack --dry-run
```

Manual browser smokes are opt-in because they open a real ChatGPT session. See
`docs/manual-tests.md`.
