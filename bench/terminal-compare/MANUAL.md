# Terminal comparison, manual part (about 20 minutes)

CI (`.github/workflows/terminal-compare.yml`) measures parse and buffer throughput and memory. It has no GPU and no display, so it cannot measure what you feel. This file covers those: input-to-screen latency, real GPU frame pacing, scrolling smoothness, idle CPU. Run it on a Mac with a real display, on AC power, with other apps closed.

Compare two things: **App** (the Canopy app's terminal: xterm.js in the webview) and **Native** (`canopy-term-app`, winit + wgpu).

## 0. Set up (5 min)

1. **Native binary.** Take the artifact from the CI run of PR #800 (`feat/term-app`; the PR body names a run and the artifact names; runs expire after 7 days, so use the latest run if that one is gone):
   ```
   gh pr checks 800 -R FluidWorksApp/canopy-ide        # find the run id of "canopy-term-app binary"
   gh run download <run-id> -R FluidWorksApp/canopy-ide -n canopy-term-app-macos-15 -D term-app
   cd term-app && chmod +x canopy-term-app canopy-pty-host && xattr -dr com.apple.quarantine .
   ```
   Release build, so it is a fair comparison. Start it with `./canopy-term-app`.
2. **App.** Use a build of the same branch's app (a build you ran from the PR's test build, or `npm run tauri build`). A dev build (`npm run tauri:dev`) is slower than release: do not compare Native against it. Open one terminal tab.
3. Make both terminals the same size (80x24 is easiest: resize until `stty size` prints `24 80`), same font size, same shell. Put them side by side.
4. `brew install cliclick` (latency step 3 only). Record the machine, macOS version, display refresh rate, and both build versions in the table below.

## 1. Throughput and smoothness (5 min)

Run each command in **App**, then in **Native**. Time with `time` and watch the window.

| # | command | what to look at |
| --- | --- | --- |
| 1 | `cat /usr/share/dict/words /usr/share/dict/words /usr/share/dict/words` (a large `cat`) | wall time from `time`; window keeps repainting vs freezes then jumps |
| 2 | `yes \| head -n 2000000` | wall time; can you still resize or switch tabs while it runs |
| 3 | `for i in $(seq 1 200000); do echo "$(date +%T) INFO request $i ok status=200"; done` (fast log stream) | smooth scroll vs stutter; time to the last line |
| 4 | `vim /usr/share/dict/words`, then hold `Ctrl-F` for 5 s, then hold `j` | tearing, skipped screens, lag after releasing the key (a queue draining) |
| 5 | `htop` for 20 s | steady redraw, no flicker, no stale cells |

Score smoothness 1-5 (5 = smooth, no visible stutter) and write the wall time. For a number instead of an impression, use step 3 below on a screen recording of command 3.

## 2. Idle CPU and memory (3 min)

1. In each terminal run `clear`, wait 30 s untouched (window visible, focused).
2. Read CPU and memory with `ps`; for **App** find the app's main process and its WebView helpers, for **Native** the app and `canopy-pty-host`:
   ```
   ps -axo pid,pcpu,rss,comm | grep -E 'canopy|Canopy|WebKit' | grep -v grep
   ```
   Run it three times, 10 s apart, and write the lowest `%CPU`. RSS is in KiB. Add up the app's own process and its WebKit helper processes for **App**; Activity Monitor (CPU tab, then Memory tab, search "canopy") shows the same.
3. Then fill scrollback: `seq 1 100000 | sed 's/$/ lorem ipsum dolor sit amet consectetur adipiscing elit/'`, wait for it to finish, and read RSS again as above.
4. Repeat step 1 with the window hidden or minimised (it should fall to about 0).

## 3. Input-to-screen latency (7 min)

Two parts. Part A is a number for the input path only. Part B counts frames for the full path to the screen.

**Part A: key to program (no hardware).** The helper `bench/terminal-compare/scripts/keylat.py` timestamps when the program inside the terminal reads a key. A second window sends keys through the OS with `cliclick`, timestamping before each send.

1. In the terminal under test: `python3 /path/to/bench/terminal-compare/scripts/keylat.py listen`.
2. In a separate Terminal.app window: `python3 .../keylat.py send 50 120`, then within 3 s click the terminal under test so it has focus. Wait until 50 sent.
3. In the terminal under test press `q`, then `python3 .../keylat.py report`. Write the median and p95.
4. Repeat for the other terminal.

The number includes `cliclick` start-up (a constant 10-30 ms). Only the difference between App and Native means anything.

**Part B: key or click to pixels (screen recording, 60 fps fallback).** No camera, but a recording at 60 fps resolves 16.7 ms, so you are counting frames, not milliseconds, and a result of +-1 frame is noise.

1. Press `Cmd+Shift+5`, choose Options, tick **Show Mouse Clicks**, and record the whole screen with the two terminals side by side. (QuickTime's recorder is fine too.)
2. In each terminal run `python3 .../keylat.py listen --flash`. A mouse press (or any key) makes the whole terminal flash.
3. Click inside the App terminal once a second for 10 clicks, then the same in Native. Stop the recording.
4. Open the recording in QuickTime and step with the arrow keys (one frame per press). For each click, count frames from the one where the click ring first appears to the one where the flash first appears. Take the median of 10 per terminal.

If the recording shows 30 fps, set the display refresh to 60 Hz and redo it; 30 fps cannot separate these two.

## 4. Results (fill in)

Machine / macOS / display Hz: ______  App version: ______  Native build (run id): ______

| measure | App (xterm.js) | Native | notes |
| --- | --- | --- | --- |
| 1 large `cat`, wall time (s) | | | |
| 2 `yes \| head -n 2000000`, wall time (s) | | | |
| 3 fast log stream, wall time (s) | | | |
| 3 fast log stream, smoothness 1-5 | | | |
| 4 `vim` scroll, smoothness 1-5 | | | |
| 5 `htop`, smoothness 1-5 | | | |
| idle CPU, visible (%) | | | |
| idle CPU, hidden (%) | | | |
| idle RSS, summed over processes (MiB) | | | |
| RSS after 100k lines (MiB) | | | |
| key to program, median / p95 (ms) | | | includes cliclick start-up |
| click to flash, median frames at 60 fps | | | +-1 frame is noise |

Compare with the CI numbers in the workflow's job summary (parse and memory) and note where they disagree: CI measures the parser without a GPU, you are measuring the whole pipeline.
