"""Draws assets/icon.png (256x256): an isometric cube on a warm gradient tile.

Pure Python (zlib only), 4x4 supersampling. Run: python3 tools/make_icon.py
An original mark for this plugin; it does not reuse Rojo's or Roblox's logos.
"""
import math, os, struct, sys, zlib

S = 256
SS = 4
out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icon.png')

def lerp(a, b, t):
    return a + (b - a) * t

C1 = (255, 107, 96)    # coral
C2 = (148, 92, 255)    # violet

def rounded_inside(x, y, r=58, pad=8):
    lo, hi = pad, S - pad
    cx = min(max(x, lo + r), hi - r)
    cy = min(max(y, lo + r), hi - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and lo <= x <= hi and lo <= y <= hi

def in_poly(x, y, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi:
            inside = not inside
        j = i
    return inside

cx, cy, a = 128, 134, 62
h = a * math.sin(math.radians(30))
w = a * math.cos(math.radians(30))
top = [(cx, cy - a), (cx + w, cy - a + h), (cx, cy - a + 2 * h), (cx - w, cy - a + h)]
left = [(cx - w, cy - a + h), (cx, cy - a + 2 * h), (cx, cy + a), (cx - w, cy + a - h)]
right = [(cx + w, cy - a + h), (cx, cy - a + 2 * h), (cx, cy + a), (cx + w, cy + a - h)]
faces = [(top, 1.0), (right, 0.78), (left, 0.58)]

rows = []
for py in range(S):
    row = bytearray([0])
    for px in range(S):
        acc = [0.0, 0.0, 0.0, 0.0]
        for sy in range(SS):
            for sx in range(SS):
                x = px + (sx + 0.5) / SS
                y = py + (sy + 0.5) / SS
                if not rounded_inside(x, y):
                    continue
                t = min(1.0, max(0.0, (x + y) / (2 * S)))
                col = [lerp(C1[i], C2[i], t) for i in range(3)]
                # soft top highlight
                hl = max(0.0, 1 - y / 140) * 0.10
                col = [c + (255 - c) * hl for c in col]
                for pts, alpha in faces:
                    if in_poly(x, y, pts):
                        col = [c + (255 - c) * alpha for c in col]
                        break
                acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
        n = SS * SS
        alpha = acc[3] / n
        if alpha > 0:
            r = acc[0] / (acc[3] / 255); g = acc[1] / (acc[3] / 255); b = acc[2] / (acc[3] / 255)
        else:
            r = g = b = 0
        row += bytes([int(min(255, r)), int(min(255, g)), int(min(255, b)), int(alpha)])
    rows.append(bytes(row))

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'wb') as f:
    f.write(png)
print(out_path, len(png), 'bytes')
