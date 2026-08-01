#!/usr/bin/env python3
"""Draw the app icon: a page with a dive arrow. Pure stdlib, writes a PNG.

Shapes are rendered from signed distance fields so the edges are antialiased
without needing a supersampled buffer.
"""

from __future__ import annotations

import struct
import sys
import zlib
from math import hypot

SIZE = 1024

BACKDROP = (0x23, 0x20, 0x1C)
PAPER = (0xF4, 0xF1, 0xEA)
RULE = (0xBC, 0xB6, 0xA9)
ACCENT = (0xC8, 0x56, 0x2A)


def round_rect(px, py, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hw, hh = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx, dy = abs(px - cx) - hw, abs(py - cy) - hh
    return hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - r


def segment(px, py, ax, ay, bx, by, thickness):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = (wx * vx + wy * vy) / (vx * vx + vy * vy)
    t = min(1.0, max(0.0, t))
    return hypot(wx - t * vx, wy - t * vy) - thickness / 2


def main(path: str) -> None:
    # Page occupies the middle; the arrow sits in its lower half.
    page = (300, 168, 724, 812)
    rules = [(356, 268, 668, 300), (356, 344, 668, 376), (356, 420, 592, 452)]
    apex = (512, 716)
    arms = [(388, 588), (636, 588)]

    rows = []
    for y in range(SIZE):
        py = y + 0.5
        row = bytearray()
        for x in range(SIZE):
            px = x + 0.5

            r, g, b = BACKDROP
            a = min(1.0, max(0.0, 0.5 - round_rect(px, py, 8, 8, SIZE - 8, SIZE - 8, 228)))

            layers = [
                (round_rect(px, py, *page, 30), PAPER),
                *[(round_rect(px, py, *rule, 16), RULE) for rule in rules],
                *[(segment(px, py, *arm, *apex, 62), ACCENT) for arm in arms],
            ]
            for dist, colour in layers:
                cov = min(1.0, max(0.0, 0.5 - dist))
                if cov <= 0.0:
                    continue
                r = round(r + (colour[0] - r) * cov)
                g = round(g + (colour[1] - g) * cov)
                b = round(b + (colour[2] - b) * cov)

            row += bytes((r, g, b, round(a * 255)))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icon.png")
