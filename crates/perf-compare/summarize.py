#!/usr/bin/env python3
"""Reads RESULT lines from the logs of the three benches and prints a markdown
table: bare vt_write, GhosttyScreen (three ways of forcing the frame), old
Screen; median (min..max) over the repeats and ratios to bare vt_write."""
import re, statistics, sys, os

theirs_log, gs_log, ours_log, label = sys.argv[1:5]
pat = re.compile(r"RESULT (\w+) throughput 80x24 (\d+) KiB reads: ([\d.]+) MiB/s")

def load(path):
    out = {}
    for line in open(path):
        m = pat.search(line)
        if m:
            out.setdefault((m.group(1), int(m.group(2))), []).append(float(m.group(3)))
    return out

t, g, o = load(theirs_log), load(gs_log), load(ours_log)
bare = {k[1]: v for k, v in t.items()}
old = {k[1]: v for k, v in o.items()}
gs = {n: {k[1]: v for k, v in g.items() if k[0] == n} for n in ("gs_end", "gs_read_seq", "gs_read_frame")}

def cell(v):
    return f"{statistics.median(v):.1f} ({min(v):.1f}..{max(v):.1f})"

lines = [f"### perf-compare {label}", "",
         "MiB/s, median (min..max) of N interleaved runs; ratio = median / bare vt_write median.", "",
         "| reads | bare vt_write | GhosttyScreen end-barrier | GhosttyScreen seq() per read | GhosttyScreen frame() per read | old Screen | runs |",
         "| --- | --- | --- | --- | --- | --- | --- |"]
for k in sorted(bare):
    b = statistics.median(bare[k])
    row = [f"{k} KiB", cell(bare[k]) + " (1.00)"]
    for n in ("gs_end", "gs_read_seq", "gs_read_frame"):
        v = gs[n].get(k)
        row.append(f"{cell(v)} ({statistics.median(v)/b:.2f})" if v else "n/a")
    v = old.get(k)
    row.append(f"{cell(v)} ({statistics.median(v)/b:.2f})" if v else "n/a")
    row.append(f"{len(bare[k])}/{len(gs['gs_end'].get(k, []))}/{len(old.get(k, []))}")
    lines.append("| " + " | ".join(row) + " |")
lines += ["", "raw bare: " + str(t), "raw gs: " + str(g), "raw old: " + str(o)]
text = "\n".join(lines)
print(text)
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as f:
        f.write(text + "\n")
