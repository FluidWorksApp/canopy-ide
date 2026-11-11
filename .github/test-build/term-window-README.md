# canopy-term-window example (PR #797)

`term_window` is the `crates/canopy-term-window` example, built with
`cargo build --release --locked --example term_window` from `feat/term-window`
at commit `@SHA@`. It is an unsigned macOS arm64 binary and a test build only.
The "terminal" is a toy line editor (type `help`). It runs no shell.

```sh
gh run download @RUN_ID@ -R @REPO@ -n @ARTIFACT@
chmod +x term_window; xattr -d com.apple.quarantine term_window; ./term_window
```

The artifact zip drops the exec bit, so `chmod +x` is needed. `xattr` prints
"No such xattr" when nothing is quarantined, which is fine.

## Manual test list (from PR #797)

Run `./term_window` and check each item:

1. **Fonts:** run `wide`. CJK should be double width and aligned, emoji in
   colour at cell height, and combining marks on their base. Box drawing should
   join with no seams. Try it with a CJK font installed and without one (system
   fallback).
2. **HiDPI:** check at 1x, 2x and a fractional scale (1.25 or 1.5 on
   Windows/Linux). The window should open at 100×30 at every scale. Drag it
   between displays with different scales: text should stay the same apparent
   size and sharp. Cells are whole physical pixels, so cols × rows can shift by
   a few. For example, the bundled font is 8 px at 1x but 17 px at 2x. Check
   that the grid changes only in whole cells, the last column or row is never
   clipped, and the program receives the new size.
3. **Resize and zoom:** resize the window. The grid should follow in whole
   cells, with no stretching. Zoom with Cmd/Ctrl+Shift `+`, `-` and `0`: the
   grid recomputes.
4. **IME, Japanese** (macOS Japanese Romaji, Windows Microsoft IME, Linux
   fcitx5/ibus with mozc): type `nihongo`. The underlined preedit should appear
   at the cursor and the candidate window just under it. Space should convert
   and Enter commit. Only the committed text should reach the line (echoed once,
   not twice). Escape should cancel the composition and send nothing.
5. **IME, Chinese** (Pinyin): same as above, choosing a candidate with a number
   key. That number must not be typed into the terminal.
6. **Clipboard:** drag to select (Alt for a block), then Cmd+C or Ctrl+Shift+C.
   Paste somewhere else and paste back with Cmd+V or Ctrl+Shift+V. Multi-line
   paste should arrive as separate lines.
7. **VoiceOver** (macOS, Cmd+F5): VO should land on the terminal. VO+arrows and
   line navigation should read each row. The caret position should be spoken
   after typing. `lines 5` should be announced politely, without the prompt.
   `alt` should announce nothing until `q`. A selection made with the mouse
   should be read as selected text.
8. **NVDA or Narrator** (Windows): the same checks. In NVDA review mode, read
   line by line and character by character, wide CJK characters included.
   `lines 5` should be announced. (Not covered by this macOS binary.)
9. **Orca** (Linux): the same checks. (Not covered by this macOS binary.)
10. **Focus and blink:** the cursor blinks only while focused and is hollow when
    unfocused. Blinking stops after about 10 s idle, and Activity Monitor or
    Task Manager should show no CPU while idle.
