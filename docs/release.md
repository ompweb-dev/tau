# Release Checklist

Each release publishes two artifacts:

- npm package: `@ompweb-dev/tau`
- GitHub Release: [ompweb-dev/tau](https://github.com/ompweb-dev/tau), with the
  five single-file binaries (`tau-<os>-<arch>.tar.gz`, `.zip` for Windows)

Neither ships pi. The binaries and the npm package run the `pi` on `PATH`
(`@earendil-works/pi-coding-agent`, or `TAU_PI_BIN`). CI tests against the pi
version pinned as `PI_VERSION` in `.github/workflows/verify-pr.yml`,
`publish.yml` and `prerelease.yml` (currently 1.5.2); change all three together,
and the release notes name it.

Publishing is performed by GitHub Actions with npm trusted publishing. No npm
access token is stored in this repository or in GitHub secrets.

## Bootstrap the first release

`@ompweb-dev/tau` is not registered on npm yet. npm exposes trusted-publisher
settings only for an existing package, so the first version must be published
once from a reviewed local checkout using an npm account authorized for the
`@ompweb-dev` scope:

```bash
npm ci
npm install --global "@earendil-works/pi-coding-agent@1.5.2"
npm test
npm run build
npm pack --dry-run
npm publish --access public
```

Do not create a tag or GitHub Release for this bootstrap version: npm will
reject a duplicate version. After this succeeds, configure trusted publishing
before publishing any later version.

## One-time trusted-publisher setup

1. In npm, open the `@ompweb-dev/tau` package settings and add a **GitHub
   Actions** trusted publisher with:
   - Owner: `ompweb-dev`
   - Repository: `tau`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
2. In GitHub, create the `npm` environment for this repository. Add required
   reviewers if releases need approval.
3. Confirm Actions are enabled for the repository.

The workflow at `.github/workflows/publish.yml` requests `contents: write` to
create the GitHub Release and `id-token: write` for trusted publishing. It
installs npm 11.5.1 or newer, as required for trusted publishing. The OIDC
permission lets npm verify the GitHub Actions identity and generate provenance
for the published package.

## Release later versions

Run these from a clean `main` checkout after the release changes are merged.
`npm run release:check` runs typecheck, lint, tests, the build and the smoke
test locally (it needs pi on `PATH`).

```bash
npm ci
npm run release:check
npm version <major|minor|patch>
git push origin main --follow-tags
```

`npm version` updates `package.json` and `package-lock.json`, creates a commit,
and creates a `v<version>` tag. Review the generated commit before pushing.

Pushing the tag starts the `Publish npm package` workflow. It checks out that
immutable tag, verifies the tag matches `package.json`, installs from the
lockfile, installs the pinned pi, runs the tests and the production build, builds
the five release binaries (`scripts/build-release-binaries.sh`, which also checks
every archive against the host updater's limits with
`scripts/check-host-release-archive.ts`), and runs the smoke test against the
built server and the Linux x64 binary. It then creates a draft GitHub Release
with generated notes (`bin/generate-release-notes.js`), attaches the archives,
publishes the release, and publishes the npm package through the trusted
publisher. A rerun can safely finish a release if npm has already accepted its
version. A final job posts the release notes to Discord
(`DISCORD_RELEASES_WEBHOOK`).

## Prereleases

Every push to `main` that passes `Verify PR` triggers `Binary prerelease`
(`.github/workflows/prerelease.yml`): it builds the five binaries, smoke-tests
the Linux x64 one, and publishes them as a GitHub prerelease titled with its
build time (tag `<YYYYMMDDTHHMMSSZ>-<short sha>`). Prereleases have no npm
package and are never "latest", so they trigger no in-app update notice.

### Build identity in the UI

Click or tap the tau logo to reveal the package version. If the build's Git
`HEAD` has no tag, the reveal also shows the full commit hash and the committer
date in `YYYY-MM-DD` format. Any tag pointing exactly at `HEAD` keeps the
version-only display; a tag on an ancestor does not.

Both the production build and development server resolve this metadata from
the source checkout, ignoring inherited repository-location overrides. Explicit
`safe.directory` trust from Git's configured files or `GIT_CONFIG_COUNT` is preserved.
The metadata is bundled into the client, including in npm packages and binary
releases; no Git command runs when a user clicks the logo.
Source archives without Git metadata keep the version-only display.

The development bootstrap initializes missing browser constants once. Empty
commit fields are valid, and later hot reloads keep the existing listener.

## Verify

```bash
gh run list --repo ompweb-dev/tau --workflow publish.yml --limit 1
npm view @ompweb-dev/tau@<version> version --registry https://registry.npmjs.org/
npm view @ompweb-dev/tau@<version> --json --registry https://registry.npmjs.org/
```

Confirm the workflow succeeded, the exact package version resolves, the release
has all five archives, and npm shows the expected provenance link.
