# Initial `frizz-server` publication

This procedure publishes the first public `frizz-server` package. It is a manual bootstrap for the stable `frizz` launcher. Do not run it until the exact release commit and tarball have been approved. This document authorizes no publish by itself.

## Preconditions

- The approved commit contains `frizz-server@0.13.0` in `packages/server-release/package.json`.
- The root shell has been packed and verified against the same commit.
- The server tarball has been inspected. It must contain `dist/dev-child.js`, detached daemon siblings, `web-dist/index.html`, and the `runtime/board` plus `runtime/cc-worker` closure.
- The command runs from a clean checkout at the approved commit. Do not publish an artifact built from a later working tree.

## Tarball

Build the staging once, then create the server tarball without a package-directory lifecycle:

```sh
nub scripts/prepare-package.mjs --server
nub scripts/build-package.mjs --server
npm pack --json --ignore-scripts ./packages/server-release
```

Read the JSON result and inspect the named tarball before publishing. The approved first publication command is:

```sh
npm login
npm publish --access public /absolute/path/to/frizz-server-0.13.0.tgz
```

The explicit tarball path prevents a later build or current working directory from changing the published bytes. The command is intentionally manual for this first package. No public publish has occurred yet.

## Trusted publishing

After the manual bootstrap, configure a trusted publisher for `frizz-server` on npm. Use the GitHub Actions values below:

| Field | Value |
| --- | --- |
| Organization or user | `colinhacks` |
| Repository | `frizz` |
| Workflow filename | `release.yml` |
| Environment name | leave blank |
| Allowed actions | allow direct `npm publish` |

The workflow file is `.github/workflows/release.yml` and already grants `id-token: write`. npm requires the filename only, not its path. New trusted-publisher settings allow staged publishing by default, so direct `npm publish` must be enabled for this workflow.

## Automated releases

The server package must exist before `release.yml` can publish a shell version that bootstraps it. After the first package and trusted publisher are configured, move the verified commit to the `release` branch. The workflow publishes `frizz-server` before `frizz` and uses npm registry checks to make retries idempotent.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
