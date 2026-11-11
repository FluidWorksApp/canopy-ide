"""Independent oracle for tests/golden.rs scene A: computes the expected image
from the scene description with no knowledge of the renderer's code."""
import os
import struct
import zlib

W, H = 48, 48
CW, CH = 8, 16
img = [[(30, 30, 30)] * W for _ in range(H)]


def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1):
        for x in range(x0, x1):
            img[y][x] = c


# Row 0: three red cells then one blue cell.
rect(0, 0, 24, 16, (200, 30, 30))
rect(24, 0, 32, 16, (30, 30, 200))
# Row 1.
# cell 1: upper half block, green, on the default background.
rect(8, 16, 16, 24, (10, 200, 100))
# cell 2: dark blue background, right half block in yellow.
rect(16, 16, 24, 32, (0, 0, 120))
rect(20, 16, 24, 32, (250, 200, 0))
# cell 4: underline in magenta at row 14 of the cell, 1px thick.
rect(32, 16 + 14, 40, 16 + 15, (255, 0, 255))
# Row 2: full block at cell 0; bar cursor (1px wide) at cell 5.
rect(0, 32, 8, 48, (90, 160, 250))
rect(40, 32, 41, 48, (255, 255, 255))

raw = b''
for row in img:
    raw += b'\x00' + b''.join(bytes((r, g, b, 255)) for r, g, b in row)


def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scene_a.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'wb').write(png)
print('wrote', out, len(png), 'bytes')
