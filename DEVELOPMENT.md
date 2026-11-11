# Development notes (internal)

Not for customers, the README is the customer-facing page.

```bash
pnpm install
pnpm dev          # esbuild watch -> main.js
pnpm build        # typecheck + production bundle
pnpm test         # tests of the shared crypto/protocol code
```

Copy `manifest.json`, `main.js` and `styles.css` to `<vault>/.obsidian/plugins/syncstone/` to try it.

## `shared/`

`shared/` is the crypto and wire-protocol code that the plugin and the Syncstone server must agree on byte for byte.
It is **copied** from the server repository, never edited here:

```bash
pnpm sync-shared ../syncstone
```

## Releasing

Obsidian's plugin directory reads `manifest.json` on `main` and installs the GitHub release whose tag is exactly that
version. GitHub's "Latest" label plays no part in it.

**Beta (testers, via BRAT)**, from `DEV`, which also runs on the dev server:

1. Tag the commit on `DEV`: `git tag 0.3.0-beta.1 && git push origin 0.3.0-beta.1`. Leave `manifest.json` alone.
2. The `release` workflow publishes a **pre-release** whose `manifest.json` carries `0.3.0-beta.1`; the one in the
   repository keeps the last stable version, so the directory never offers a beta.
3. Testers add `syncst-one/syncstone-plugin` in BRAT ("latest version", pre-releases included) and point the plugin at
   the dev server (Settings, Advanced, self-hosting). Next round: `-beta.2`, ...
4. Write in the release notes what changed and what to try.

**Stable**, for everybody:

1. Merge `DEV` into `main`.
2. Deploy the production server first (it must stay compatible with the plugins already out there).
3. Bump `version` in `manifest.json` and `package.json`; add it to `versions.json` only when `minAppVersion` changes.
4. Tag that commit with exactly the version (`git tag 0.3.0 && git push origin 0.3.0`, no leading `v`).
5. The workflow publishes the release with `release-notes/<version>.md` as its text (written for users; without that
   file GitHub's list of commits is used). The release notes are the changelog: what users notice, including server-side
   improvements since the last release (a server-only change gets no plugin release of its own).

A tester on `0.3.0-beta.N` is not offered `0.3.0` by the directory (it compares versions its own way); BRAT updates them.

## Plugin and server compatibility

`PROTOCOL_VERSION` (shared/src/constants.ts) is a protocol level, not the release version. Bump it only for a change that
an older counterpart cannot cope with; additions old clients ignore (new message types, new optional fields) do not
count. The server reports on `/health` its level, `minClientProtocolVersion` and the newest released plugin version
(read from `manifest.json` on `main`). The plugin compares that at start and every 30 minutes:

- plugin too old: yellow update icon, sync paused (local changes are kept and sent after the update);
- server too old (self-hosted): yellow icon with "please update the server";
- newer plugin released: a notice at start and a box at the top of the settings.

Keep the level identical in the hosted repository, the self-host repository and `shared/` here.

The plugin `id` (`syncstone`) is the address of the plugin in the Obsidian directory and must never change again once users have installed it. Until 0.2.17 it was `websync`.
