#!/usr/bin/env python3
"""Build the glyph fallback fonts the Linux app loads (src/glyphFallback.css).

Canopy's UI draws symbols (arrows, check marks, triangles, key glyphs, emoji)
that no bundled text font contains. macOS and Windows fill them from system
fonts; a Linux machine draws a box for each one it has no font for. This
subsets the Noto symbol, math and (monochrome) emoji fonts down to exactly the
characters the UI source uses, so the app carries them itself.

    python3 -m pip install fonttools brotli
    python3 scripts/glyph-fallback/build.py

Run it after adding a symbol the guard test (src/glyphFallback.test.ts) says
no font covers. It downloads the pinned @fontsource packages with `npm pack`
into a temporary folder, and writes:

    src/assets/fonts/glyph-fallback/*.woff2   one subset per source font
    src/assets/fonts/glyph-fallback/manifest.json   the code points each covers
    src/glyphFallback.css                      the @font-face rules

All sources are SIL Open Font License 1.1 with no Reserved Font Name, so
subsetting needs no rename (see THIRD-PARTY-NOTICES.md).
"""
import glob, json, os, re, subprocess, sys, tempfile, unicodedata

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "src", "assets", "fonts", "glyph-fallback")
CSS = os.path.join(ROOT, "src", "glyphFallback.css")

# In priority order: a character goes to the first source that has it. Emoji
# last, under its own family, so a system colour emoji font listed before it
# in the Linux stack still wins.
SOURCES = [
    ("symbols-2", "@fontsource/noto-sans-symbols-2@5.3.0", "Canopy Symbols"),
    ("math", "@fontsource/noto-sans-math@5.3.0", "Canopy Symbols"),
    ("symbols", "@fontsource/noto-sans-symbols@5.3.0", "Canopy Symbols"),
    ("emoji", "@fontsource/noto-emoji@5.3.2", "Canopy Emoji"),
]


def ranges(css_path):
    out = []
    for m in re.finditer(r"unicode-range:\s*([^;]+);", open(css_path).read()):
        for part in m.group(1).split(","):
            part = part.strip()[2:]
            if "-" in part:
                a, b = part.split("-")
                out.append((int(a, 16), int(b, 16)))
            elif "?" in part:
                out.append((int(part.replace("?", "0"), 16), int(part.replace("?", "F"), 16)))
            else:
                out.append((int(part, 16), int(part, 16)))
    return out


def text_font_ranges():
    """What the bundled text font serves: any normal text font has these."""
    return ranges(os.path.join(ROOT, "node_modules", "@fontsource-variable", "archivo", "wght.css"))


def ui_characters():
    """Every non-ASCII character in the UI source (tests and comments left out).
    Kept in step with collectUiCharacters in src/glyphFallback.test.ts."""
    chars = set()
    for base in ("src", "shared"):
        for root, _, files in os.walk(os.path.join(ROOT, base)):
            for f in files:
                if not re.search(r"\.(tsx|ts|css)$", f) or ".test." in f:
                    continue
                text = open(os.path.join(root, f), encoding="utf-8").read()
                text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
                text = re.sub(r"(?m)(^|[^:\\])//[^\n]*", r"\1", text)
                chars.update(c for c in text if ord(c) > 127 and unicodedata.category(c) not in ("Cf", "Mn", "Me", "Cc"))
    return chars


def main():
    covered = text_font_ranges()
    need = sorted(ord(c) for c in ui_characters() if not any(a <= ord(c) <= b for a, b in covered))
    with tempfile.TemporaryDirectory() as tmp:
        for _, pkg, _ in SOURCES:
            subprocess.run(["npm", "pack", "-q", pkg], cwd=tmp, check=True, stdout=subprocess.DEVNULL)
        for tgz in glob.glob(os.path.join(tmp, "*.tgz")):
            d = tgz[:-4]
            os.makedirs(d)
            subprocess.run(["tar", "xzf", tgz, "-C", d], check=True)
        os.makedirs(OUT, exist_ok=True)
        for old in glob.glob(os.path.join(OUT, "*.woff2")):
            os.remove(old)
        left, faces = set(need), []
        for key, pkg, family in SOURCES:
            name, version = pkg.split("/")[1].split("@")
            pkgdir = os.path.join(tmp, f"fontsource-{name}-{version}", "package")
            files = sorted(glob.glob(os.path.join(pkgdir, "files", "*-400-normal.woff2")))
            for path in files:
                font = TTFont(path)
                cps = sorted(c for c in left if c in font.getBestCmap())
                if not cps:
                    continue
                opts = subset.Options()
                opts.flavor = "woff2"
                opts.layout_features = ["*"]
                opts.name_IDs = ["*"]
                opts.notdef_outline = True
                sub = subset.Subsetter(options=opts)
                sub.populate(unicodes=cps)
                sub.subset(font)
                fname = f"{key}-{len(faces)}.woff2"
                font.flavor = "woff2"
                font.save(os.path.join(OUT, fname))
                faces.append({"file": fname, "family": family, "source": pkg, "unicodes": cps})
                left -= set(cps)
    manifest = {
        "generatedBy": "scripts/glyph-fallback/build.py",
        "faces": faces,
        "uncovered": [f"U+{c:04X}" for c in sorted(left)],
    }
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    rules = []
    for face in faces:
        rng = ",".join(f"U+{c:X}" for c in face["unicodes"])
        rules.append(
            "@font-face {\n"
            f'  font-family: "{face["family"]}";\n'
            "  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n"
            f'  src: url("./assets/fonts/glyph-fallback/{face["file"]}") format("woff2");\n'
            f"  unicode-range: {rng};\n}}\n"
        )
    header = (
        "/* GENERATED by scripts/glyph-fallback/build.py — do not edit by hand.\n"
        "   The symbols the UI draws that no bundled text font has, from the Noto\n"
        "   symbol, math and emoji fonts (OFL-1.1). Loaded on Linux only\n"
        "   (src/glyphFallback.ts); the names are in every font stack through\n"
        "   --glyph-fallback, and match nothing on macOS or Windows. */\n"
    )
    open(CSS, "w").write(header + "\n".join(rules))
    print(f"{len(need)} characters needed, {len(faces)} faces written, uncovered: {manifest['uncovered']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
