#!/usr/bin/env python3
"""Input latency helper for MANUAL.md. Standard library only; run it by hand.

  keylat.py listen [--flash]   in the terminal under test: raw mode, mouse reporting on.
                               Each key press or mouse press is timestamped when the
                               program READS it. With --flash the whole screen then
                               flashes (so a screen recording shows the echo).
                               Press q to stop. Writes ~/keylat-read.txt (epoch ns).
  keylat.py send N [GAP_MS]    from another window: focus the terminal under test, then
                               send N key presses with `cliclick` (brew install cliclick),
                               timestamping each just before the call. Writes ~/keylat-sent.txt.
  keylat.py report             pairs the two files and prints median / p95 / max in ms.

The send-side timestamp is taken before `cliclick` starts, so a constant 10-30 ms of
tool start-up is included in every number. Compare the two terminals with the same
tool; do not read the absolute value as the terminal's own latency.
"""
import os, subprocess, sys, time, statistics

HOME = os.path.expanduser("~")
READ, SENT = os.path.join(HOME, "keylat-read.txt"), os.path.join(HOME, "keylat-sent.txt")


def listen(flash):
    import termios, tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    out = sys.stdout
    stamps = []
    try:
        tty.setraw(fd)
        out.write("\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[Hkeylat: press keys or click; q quits\r\n")
        out.flush()
        while True:
            data = os.read(fd, 64)
            t = time.time_ns()
            if data in (b"q", b"Q"):
                break
            if data.startswith(b"\x1b[<") and data.endswith(b"m"):
                continue  # mouse release
            stamps.append(t)
            if flash:
                rows, cols = os.get_terminal_size()
                out.write("\x1b[H\x1b[7m" + (" " * cols + "\r\n") * (rows - 1) + "\x1b[0m")
                out.flush()
                time.sleep(0.15)
                out.write("\x1b[2J\x1b[H" + f"keylat: {len(stamps)} events\r\n")
            else:
                out.write(f"\r\n{len(stamps)}")
            out.flush()
    finally:
        out.write("\x1b[?1006l\x1b[?1000l")
        out.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    with open(READ, "w") as f:
        f.write("\n".join(map(str, stamps)) + "\n")
    print(f"{len(stamps)} events -> {READ}")


def send(n, gap_ms):
    time.sleep(3)  # time to focus the terminal under test
    stamps = []
    for _ in range(n):
        stamps.append(time.time_ns())
        subprocess.run(["cliclick", "kp:space"], check=True)
        time.sleep(gap_ms / 1000)
    with open(SENT, "w") as f:
        f.write("\n".join(map(str, stamps)) + "\n")
    print(f"{n} sent -> {SENT}")


def report():
    rd = [int(x) for x in open(READ).read().split()]
    sd = [int(x) for x in open(SENT).read().split()]
    d = sorted((r - s) / 1e6 for r, s in zip(rd, sd))
    if not d:
        sys.exit("no pairs")
    p95 = d[min(len(d) - 1, int(len(d) * 0.95))]
    print(f"n={len(d)} median={statistics.median(d):.1f} ms p95={p95:.1f} ms max={d[-1]:.1f} ms (sent->read, includes tool start-up)")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["listen"]:
        listen("--flash" in a)
    elif a[:1] == ["send"]:
        send(int(a[1]), int(a[2]) if len(a) > 2 else 120)
    elif a[:1] == ["report"]:
        report()
    else:
        sys.exit(__doc__)
