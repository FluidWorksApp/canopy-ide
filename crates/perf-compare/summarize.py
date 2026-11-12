#!/usr/bin/env python3
"""Reads RESULT lines from logs of the two benches, prints a markdown table
(median, min, max over the repeats, and the ratio ours/theirs)."""
import re, statistics, sys, os

theirs_log, ours_log, label = sys.argv[1], sys.argv[2], sys.argv[3]
pat = re.compile(r"RESULT (\w+) throughput 80x24 (\d+) KiB reads: ([\d.]+) MiB/s")

def load(path):
    out = {}
    for line in open(path):
        m = pat.search(line)
        if m:
            out.setdefault(int(m.group(2)), []).append(float(m.group(3)))
    return out

t, o = load(theirs_log), load(ours_log)
lines = [f"### perf-compare {label}", "",
         "| reads | libghostty-vt vt_write median (min..max) | ours Screen::advance median (min..max) | ratio ours/theirs (median) | runs |",
         "| --- | --- | --- | --- | --- |"]
for k in sorted(t):
    tv, ov = t[k], o.get(k, [])
    if not ov:
        continue
    tm, om = statistics.median(tv), statistics.median(ov)
    lines.append(
        f"| {k} KiB | {tm:.1f} ({min(tv):.1f}..{max(tv):.1f}) MiB/s | "
        f"{om:.1f} ({min(ov):.1f}..{max(ov):.1f}) MiB/s | {om/tm:.2f} | {len(tv)}/{len(ov)} |")
lines += ["", "raw theirs: " + str(t), "raw ours: " + str(o)]
text = "\n".join(lines)
print(text)
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as f:
        f.write(text + "\n")
