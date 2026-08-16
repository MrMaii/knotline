# Release compliance checklist

Do not publish a Git tag, GitHub release, or npm package until every required item below is complete.

## Repository identity

- [ ] Create or verify the public repository named in `package.json`: `https://github.com/MrMaii/knotline`.
- [ ] Point the checkout's public release remote at the Knotline repository. Keep the upstream URL in `PROVENANCE.md` for attribution.
- [ ] Preserve the inherited Git history or otherwise preserve equivalent author and source attribution.
- [ ] Confirm the release commit author and committer identity.
- [ ] Confirm the worktree contains no unrelated, private, generated, or secret files.

## Rights and notices

- [ ] Review every changed or newly added file and confirm the contributor has the right to publish it under Apache-2.0.
- [ ] Keep `LICENSE`, `NOTICE`, `PROVENANCE.md`, and `THIRD_PARTY_NOTICES.md` current.
- [ ] Rebuild the third-party inventory whenever `package-lock.json` or browser imports change.
- [ ] Record the source and license of every copied snippet, image, font, icon, or generated asset.
- [ ] Confirm `PROVENANCE.md` and the Git history still identify which files derive from upstream (this is the prominent modification notice).
- [ ] Confirm the README independence and trademark disclaimer remains visible.
- [ ] Require `Signed-off-by:` on every contribution according to `DCO.txt`.

## Technical release gate

```sh
npm ci
npm run check
npm run pack:check
```

- [ ] Inspect the dry-run file list. It must include `LICENSE`, `NOTICE`, `PROVENANCE.md`, `THIRD_PARTY_NOTICES.md`, `DCO.txt`, and `README.zh-CN.md`.
- [ ] Confirm no `.map`, fixture, test, secret, local database, or private environment file is packaged.
- [ ] Install the generated tarball in an isolated compatible DeepSeek Harness profile and exercise the documented sidebar Map path.
- [ ] Create a signed or otherwise verifiable release tag from the reviewed commit.
- [ ] Publish from CI with npm provenance when available; do not publish from an unreviewed dirty worktree.

## Public release statement

Use this wording without deleting the linked qualifications:

> Knotline is an independent open-source derivative and extensive rewrite of the Apache-2.0-licensed upstream project documented in `PROVENANCE.md`. It interoperates with MIT-licensed DeepSeek Harness through official package and service interfaces. Upstream and third-party copyrights remain with their respective holders. Knotline is not affiliated with or endorsed by either upstream project. Full provenance and notices are provided in `PROVENANCE.md` and `THIRD_PARTY_NOTICES.md`.
