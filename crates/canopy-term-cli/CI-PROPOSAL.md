# Proposed CI job (not yet in .github/workflows/ci.yml)

Add next to the `pty-host` job. Same shape; the host binary is built first (a
dependency's binary is not built by cargo) and handed to the tests through
`CANOPY_PTY_HOST_EXE`. Windows only builds the stub and runs the `--version`
test. No `-D warnings` or clippy until the crate has been compiled once.

```yaml
  term-cli:
    name: canopy-term (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-15, windows-2022]
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: |
            ./src-tauri -> target
            ./crates/canopy-term-cli -> target
          key: term-cli-${{ matrix.os }}
      - name: Build the host the tests start
        if: runner.os != 'Windows'
        run: |
          cargo build --locked --manifest-path crates/canopy-pty-host/Cargo.toml --bin canopy-pty-host
          echo "CANOPY_PTY_HOST_EXE=$GITHUB_WORKSPACE/src-tauri/target/debug/canopy-pty-host" >> "$GITHUB_ENV"
      - run: cargo test --locked --manifest-path crates/canopy-term-cli/Cargo.toml
      - run: cargo fmt --manifest-path crates/canopy-term-cli/Cargo.toml --check
```

If the host build step is dropped, the tests build the host themselves into
`crates/canopy-term-cli/target/host-build`.
