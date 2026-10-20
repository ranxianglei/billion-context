"""Generate BiliTray icons (PNG/ICO/ICNS) without external dependencies.

Pure stdlib: draws a 1024px master (blue rounded square, three white context
bars shrinking into a download arrow), bilinearly downscales, and emits PNGs
plus ICO/ICNS containers. Run from repo root: python3 tray/tools/gen_icons.py
"""

import os
import struct
import sys
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "icons")

BG = (31, 110, 235)      # #1f6feb
FG = (255, 255, 255)


def _inside_rounded_square(x, y, lo, hi, r):
    cx = min(max(x, lo + r), hi - r)
    cy = min(max(y, lo + r), hi - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def _in_bar(x, y, x0, x1, y0, y1):
    return x0 <= x <= x1 and y0 <= y <= y1


def _in_arrow(x, y):
    if 472 <= x <= 552 and 716 <= y <= 828:
        return True
    if 828 < y <= 924:
        hw = 152.0 * (924 - y) / 96.0
        return abs(x - 512) <= hw
    return False


def draw_master(size=1024):
    px = bytearray()
    for row in range(size):
        y = row + 0.5
        for col in range(size):
            x = col + 0.5
            if not _inside_rounded_square(x, y, 88, 936, 224):
                px += b"\x00\x00\x00\x00"
                continue
            if (_in_bar(x, y, 212, 812, 280, 364)
                    or _in_bar(x, y, 300, 724, 444, 528)
                    or _in_bar(x, y, 388, 636, 608, 692)
                    or _in_arrow(x, y)):
                px += b"\xff\xff\xff\xff"
            else:
                px += bytes(BG) + b"\xff"
    return bytes(px)


def resize_bilinear(src, src_size, dst_size):
    out = bytearray()
    scale = src_size / dst_size
    for row in range(dst_size):
        sy = min((row + 0.5) * scale - 0.5, src_size - 1.001)
        y0, fy = int(sy), sy - int(sy)
        y1 = min(y0 + 1, src_size - 1)
        for col in range(dst_size):
            sx = min((col + 0.5) * scale - 0.5, src_size - 1.001)
            x0, fx = int(sx), sx - int(sx)
            x1 = min(x0 + 1, src_size - 1)
            vals = []
            for ch in range(4):
                p00 = src[(y0 * src_size + x0) * 4 + ch]
                p01 = src[(y0 * src_size + x1) * 4 + ch]
                p10 = src[(y1 * src_size + x0) * 4 + ch]
                p11 = src[(y1 * src_size + x1) * 4 + ch]
                top = p00 + (p01 - p00) * fx
                bot = p10 + (p11 - p10) * fx
                vals.append(round(top + (bot - top) * fy))
            out += bytes(vals)
    return bytes(out)


def _png_chunk(tag, data):
    block = tag + data
    return struct.pack(">I", len(data)) + block + struct.pack(">I", zlib.crc32(block) & 0xFFFFFFFF)


def encode_png(width, height, rgba):
    raw = b"".join(b"\x00" + rgba[row * width * 4:(row + 1) * width * 4] for row in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(raw, 9))
            + _png_chunk(b"IEND", b""))


def encode_icos(images):
    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    payloads = b""
    offset = 6 + 16 * count
    for w, png in images:
        byte_w = 0 if w >= 256 else w
        entries += struct.pack("<BBBBHHII", byte_w, byte_w, 0, 0, 1, 32, len(png), offset)
        payloads += png
        offset += len(png)
    return header + entries + payloads


def encode_icns(chunks):
    body = b"".join(struct.pack(">4sI", t, len(d) + 8) + d for t, d in chunks)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    master = draw_master(1024)
    sizes_png = [16, 32, 64, 128, 256, 512, 1024]
    pngs = {}
    for s in sizes_png:
        img = master if s == 1024 else resize_bilinear(master, 1024, s)
        pngs[s] = encode_png(s, s, img)

    os.makedirs(OUT_DIR, exist_ok=True)
    for s in [16, 32, 64, 128, 256, 512]:
        path = os.path.join(OUT_DIR, "%dx%d.png" % (s, s))
        with open(path, "wb") as f:
            f.write(pngs[s])
        print("wrote", os.path.normpath(path), len(pngs[s]), "bytes")

    ico = encode_icos([(16, pngs[16]), (32, pngs[32]), (48, pngs[64]), (256, pngs[256])])
    with open(os.path.join(OUT_DIR, "icon.ico"), "wb") as f:
        f.write(ico)
    print("wrote icon.ico", len(ico), "bytes")

    icns = encode_icns([
        (b"ic07", pngs[128]),
        (b"ic08", pngs[256]),
        (b"ic09", pngs[512]),
        (b"ic10", pngs[1024]),
    ])
    with open(os.path.join(OUT_DIR, "icon.icns"), "wb") as f:
        f.write(icns)
    print("wrote icon.icns", len(icns), "bytes")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("gen_icons failed:", exc, file=sys.stderr)
        raise
