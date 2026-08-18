# Copyright and provenance

This file is the public record of where Knotline came from, what it contains, and which rights apply. It is factual project documentation, not a transfer of copyright or legal advice.

## Public statement

Knotline is an independent open-source derivative and extensive rewrite developed in the public Git history of [Dashi Taskboard](https://github.com/chuspeeism/dashi-taskboard). Dashi Taskboard is licensed under Apache License 2.0. That license permits use, modification, and redistribution subject to its conditions.

The Knotline-specific original contributions and modifications made by Thomas Deng in 2026 are released under the same Apache License 2.0. Earlier Dashi Taskboard contributions remain copyrighted by their respective contributors. The Knotline maintainer does not claim exclusive ownership of the complete repository and has received no copyright assignment from upstream contributors.

Knotline interoperates with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through its documented package and service interfaces. DeepSeek Harness and its npm packages are MIT-licensed. Compatibility does not make Knotline an official DeepSeek product and does not transfer any DeepSeek trademark or copyright.

## Recorded source baseline

The Knotline rewrite was prepared in a Dashi Taskboard checkout whose last committed state before the rewrite was:

- local commit: `525ef56872f5dff4ed8e570f35291c71351ca2a0`;
- common Dashi baseline with `origin/main`: `8613a9c78828b322e4df0fc3a8855ed53d7f4dbc`;
- upstream: `https://github.com/chuspeeism/dashi-taskboard`;
- license: Apache-2.0.

The repository history is the authoritative attribution record: paths carried forward from Dashi Taskboard retain their upstream commit history, and this document plus the Git log serve as the prominent notice, required by Apache-2.0 §4(b), that those files were changed. Generated manifests and JSON files cannot contain comments; this document records their replacement or modification.

## Code composition

| Layer | Location | Source and role | Distribution status |
| --- | --- | --- | --- |
| Knotline Host | `src/host/` | Knotline code. Reads official DSH Session, Agent, Loader, and query services; serves the Map API and SSE. | Apache-2.0 |
| Shared contracts | `src/contracts.ts` | Knotline wire types shared by Host and Map plugin. | Apache-2.0 |
| DSH Web plugin | `src/client/` | Knotline sidebar entry and plugin layer loaded by the official DSH Web module system. | Apache-2.0; DSH peer packages remain MIT |
| Project Map | `web/src/` | React Map mounted directly by the DSH Web plugin. Some tracked paths descend from Dashi files; Git history preserves that fact. | Apache-2.0 plus bundled dependencies below |
| Map backend | `server/`, `shared/` | Descends from the Dashi Taskboard backend, extensively modified; bundled into the Host output at build time. | Apache-2.0 |
| Build and verification | `scripts/`, `test/`, `tsdown.config.ts` | Knotline build and verification code. | Apache-2.0 |
| Generated output | `lib/` (untracked build output), `package-lock.json` | Produced from source or package resolution. Do not edit as authorship records. | Inherits applicable source and dependency licenses |

The browser Map plugin bundles XYFlow, Phosphor Icons, Zustand, and transitive D3/classcat packages and uses React supplied by DeepSeek Harness. Their exact versions, copyright notices, and license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

DeepSeek Harness runtime packages declared as `peerDependencies` are resolved by the host installation and are not copied into Knotline's Host or launcher bundles. Their MIT terms continue to apply independently.

## Authorship and contribution policy

- Git author and commit history identifies individual contributions; the package `author` field identifies the current package maintainer, not the sole owner of every line.
- Contributions are accepted under Apache-2.0 and must carry a Developer Certificate of Origin 1.1 sign-off. See [CONTRIBUTING.md](CONTRIBUTING.md) and [DCO.txt](DCO.txt).
- Reused code, generated assets, and adapted material must identify their source and license in the pull request and, when distributed, in this file or `THIRD_PARTY_NOTICES.md`.
- AI-assisted work is allowed only when the contributor has the right to submit it, reviews it, and can certify the DCO. The project does not claim that every line was written without tools; tool use does not erase upstream rights or the contributor's responsibility.
- No contribution agreement assigns a contributor's copyright to the maintainer. Contributors retain copyright and license their contribution under Apache-2.0.

## Trademarks and screenshots

Names and marks are used only to identify origin, dependencies, or compatibility. Knotline is not affiliated with or endorsed by Dashi Taskboard maintainers or DeepSeek. Documentation screenshots may show the compatible DeepSeek Harness interface; they do not imply sponsorship. Do not reuse third-party logos as Knotline branding.

## Redistribution duties

Anyone redistributing source or binaries should:

1. include `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`;
2. retain existing copyright, patent, trademark, attribution, and modification notices;
3. keep prominent notices on files modified from Dashi Taskboard;
4. identify any newly introduced third-party code or assets and include their required terms;
5. avoid statements implying upstream endorsement;
6. provide source changes when a newly introduced license requires it.

See [RELEASING.md](RELEASING.md) for the maintainer's publication gate.
