# Changes from upstream agent-desktop

Upstream: https://github.com/vercel-labs/agent-desktop at
`9eb9b296192fcb70bda25e918cd6dd66abfa3d0d` (UPSTREAM.lock). Herald OS carries the Linux parts only
and builds them with `cargo build --release --frozen --offline` against `vendor/`.
`scripts/sync-agent-desktop.sh <sha>` redoes everything below for another revision.

## Files changed from upstream

Each has a diff against the pinned revision in `patches/`.

| File | Patch | Why |
| --- | --- | --- |
| `Cargo.toml` | `patches/0001-workspace-linux-members.patch` | The workspace lists `crates/core`, `crates/linux` and `src` only: the macOS, Windows and FFI crates are not carried. Their `[profile.release.package.agent-desktop-macos]` override goes with them. |
| `src/Cargo.toml` | `patches/0002-cli-linux-dependencies.patch` | The command-line crate keeps its Linux dependency only: the macOS and Windows target dependencies, the Windows dev-dependency and the two Windows-only test targets point at files that are not carried. |
| `Cargo.lock` | `patches/0003-lock-without-other-platforms.patch` | Regenerated for the trimmed workspace. It is what Cargo writes when the two manifests above meet upstream's lock: the crates only the dropped members used are removed and every other version stays as upstream pinned it. sha256 `da80a051f33db5dd38c19f924cef4a75c3bd340186f29678bc426b32b2d974f4`. |

No source file (`.rs`), skill or fixture is changed.

## Carried unchanged

- `crates/core`, `crates/linux`, `src`: the library, the Linux adapter and the command-line
  binary. The build makes `agent-desktop` and `agent-desktop-linux-clipboard-owner`; the second must
  sit in the same folder as the first.
- `skills/agent-desktop`, `skills/agent-desktop-linux`: the command guide and the Linux notes.
- `skills/agent-desktop-macos`, `skills/agent-desktop-windows`, `skills/agent-desktop-ffi`,
  `skills/jev-desktop`: Markdown only. `crates/core/src/commands/skills.rs` embeds every skill with
  `include_str!` on every platform, so the core crate does not compile without them.
- `tests/fixtures`: the golden trees and trace that the core crate's unit tests read.
- `rust-toolchain.toml`: upstream's pin (Rust 1.89.0). rustup honours it; the image build uses
  Fedora's packaged Rust, which is newer and builds the same lock.
- `LICENSE`: upstream's Apache License 2.0.

## Not carried

`crates/macos`, `crates/windows`, `crates/ffi`, `npm`, `apps`, `probes`, `benchmarks`, `docs`, the
other `tests` folders, upstream's CI and repository files. The command-line crate's integration
tests (`src/tests`) and its documentation drift tests read some of those files, so Herald OS runs
`cargo test` for `agent-desktop-core` and `agent-desktop-linux` only.

## Added by Herald OS

- `NOTICE`: credit, the pinned revision and that the code is modified.
- `UPSTREAM.lock`: the repository and revision.
- `PATCHES.md` (this file) and `patches/`.
- `.cargo/config.toml`: replaces crates.io with `vendor/`, so no build reaches the network.
- `vendor/`: `cargo vendor --locked vendor` (Cargo 1.89.0) from `Cargo.lock`, unedited, 132 crates.
  It includes crates for targets Herald OS never builds (`windows-sys` and the like), because Cargo
  vendors every platform's dependencies that the lock names.
