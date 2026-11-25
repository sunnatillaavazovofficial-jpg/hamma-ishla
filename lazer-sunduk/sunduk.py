#!/usr/bin/env python3
"""
Lazerda kesiladigan SUNDUK (xazina qutisi) chizmasi generatori.

Quti: tishli (finger joint) korpus + egiluvchan (living hinge) yoysimon qopqoq
+ old tomonida magnitli yurak qulf. Orqa devor va qopqoq terisi BITTA bo'lak:
ular orasidagi egiluvchan zona sharnir (ilmoq) vazifasini bajaradi, ya'ni
hech qanday temir sharnir kerak emas.

Natija: SVG (LightBurn, RDWorks, CorelDraw, Inkscape) va DXF (AutoCAD, LaserCut).
  qora   (#000000) — kesish (CUT)   (--cut_color bilan o'zgartirsa bo'ladi)
  ko'k   (#0000FF) — gravirovka / chiziq (ENGRAVE)

Ishlatish:
  python3 sunduk.py                        # standart: 70x50 mm, 3 mm fanera
  python3 sunduk.py --W 120 --D 85 --H 55 --T 3 --name katta
  python3 sunduk.py --T 4 --kerf 0.15      # boshqa material / lazer
"""

import argparse
import math
import os
import random
from dataclasses import dataclass, field, asdict

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import (LineString, MultiLineString, MultiPolygon, Point,
                              Polygon, box)
from shapely.ops import unary_union


# --------------------------------------------------------------------------
# Parametrlar
# --------------------------------------------------------------------------
@dataclass
class Params:
    W: float = 70.0            # tashqi eni (chapdan o'ngga), mm
    D: float = 50.0            # tashqi chuqurligi (olddan orqaga), mm
    H: float = 35.0            # korpus tashqi balandligi (tagi bilan), mm
    T: float = 3.0             # material qalinligi, mm
    lid_straight: float = 10.0  # qopqoqning tik (to'g'ri) qismi balandligi
    lid_rise: float = 15.0     # qopqoq yoyining ko'tarilishi (ichki o'lcham)
    corner_r: float = 9.0      # qopqoq burchak yoyi radiusi (ichki)
    hinge_below: float = 10.0  # sharnir zonasining korpusdagi qismi
    finger: float = 6.5        # tish eni (taxminiy)
    kerf: float = 0.10         # lazer nuri eni kompensatsiyasi (0 = yo'q)
    kerf_pitch: float = 1.6    # egiluvchan kesiklar qatorlari orasidagi masofa
    slit_len: float = 20.0     # egiluvchan kesik uzunligi (taxminiy)
    slit_gap: float = 3.0      # kesiklar orasidagi ko'prikcha
    magnet_d: float = 6.0      # magnit diametri (6x3 mm neodim)
    heart_w: float = 0.0       # yurak eni (0 = avtomatik)
    tab_h: float = 2.0         # qopqoqni to'g'rilovchi tishcha balandligi
    tab_clear: float = 0.35    # tishcha uchun bo'shliq
    engrave: bool = True       # bezak gravirovkasini qo'shish
    seed: int = 7
    cut_color: str = "#000000"  # kesish chiziqlari rangi (qora)

    def check(self):
        a = (self.D - 2 * self.T) / 2
        assert self.T > 0 and self.W > 6 * self.T and self.D > 6 * self.T
        assert self.H > 4 * self.T, "H juda kichik"
        assert self.corner_r < self.lid_rise < a, \
            "shart: corner_r < lid_rise < (D-2T)/2"
        assert self.corner_r > 2.5 * self.T, "corner_r juda kichik (egilmaydi)"
        assert self.hinge_below < self.H - 3 * self.T


# --------------------------------------------------------------------------
# Yordamchi geometriya
# --------------------------------------------------------------------------
def odd_segments(a, b, target):
    """[a,b] oralig'ini toq sonli teng bo'laklarga bo'ladi."""
    L = b - a
    n = max(3, 2 * int(round((L / target - 1) / 2)) + 1)
    s = L / n
    return [(a + i * s, a + (i + 1) * s) for i in range(n)]


def arc_pts(cx, cy, r, a0, a1, step=0.25):
    n = max(2, int(abs(a1 - a0) * r / step) + 1)
    return [(cx + r * math.cos(t), cy + r * math.sin(t))
            for t in np.linspace(a0, a1, n)]


def lid_geom(p):
    """Qopqoq profili: ikki kichik yoy + bitta katta yoy (bir-biriga urinma)."""
    a = (p.D - 2 * p.T) / 2
    rc, s = p.corner_r, p.lid_rise
    Rt = ((a - rc) ** 2 + s ** 2 - rc ** 2) / (2 * (s - rc))
    phi = math.atan2(Rt - s, a - rc)
    return a, rc, Rt, phi


def lid_path(p, o=0.0):
    """Qopqoq profili (x, y) — orqa pastdan oldingi pastgacha, o: tashqariga siljish."""
    a, rc, Rt, phi = lid_geom(p)
    hs, T, D = p.lid_straight, p.T, p.D
    yc_top = hs + p.lid_rise - Rt
    pts = [(D - T + o, 0.0), (D - T + o, hs)]
    pts += arc_pts(D - T - rc, hs, rc + o, 0, phi)[1:]
    pts += arc_pts(D / 2, yc_top, Rt + o, phi, math.pi - phi)[1:]
    pts += arc_pts(T + rc, hs, rc + o, math.pi - phi, math.pi)[1:]
    pts += [(T - o, 0.0)]
    return pts


def lid_path_len(p, o):
    a, rc, Rt, phi = lid_geom(p)
    return 2 * p.lid_straight + 2 * (rc + o) * phi + (Rt + o) * (math.pi - 2 * phi)


def heart_poly(cx, top, w):
    t = np.linspace(0, 2 * np.pi, 1441)[:-1]
    x = 16 * np.sin(t) ** 3
    y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
    sc = w / (x.max() - x.min())
    poly = Polygon(np.c_[cx + x * sc, top + (y - y.max()) * sc]).buffer(0)
    # o'tkir ichki burchakni va uchini biroz yumaloqlash
    return poly.buffer(0.4).buffer(-0.4).buffer(-0.3).buffer(0.3)


def width_at(poly, y):
    minx, _, maxx, _ = poly.bounds
    inter = poly.intersection(LineString([(minx - 1, y), (maxx + 1, y)]))
    return inter.length


def as_lines(geom):
    """Har qanday geometriyani LineString ro'yxatiga aylantiradi."""
    out = []
    if geom.is_empty:
        return out
    if isinstance(geom, (Polygon, MultiPolygon)):
        polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
        for pg in polys:
            out.append(LineString(pg.exterior.coords))
            out += [LineString(r.coords) for r in pg.interiors]
        return out
    if isinstance(geom, LineString):
        return [geom]
    if hasattr(geom, "geoms"):
        for g in geom.geoms:
            out += as_lines(g)
    return out


def planks(x0, x1, y0, y1, pitch, rng, gap=1.8, lmin=7, lmax=28):
    """Taxta ko'rinishidagi bezak chiziqlari (gravirovka)."""
    lines = []
    n = int((y1 - y0) // pitch)
    if n < 1:
        return lines
    off = (y1 - y0 - (n - 1) * pitch) / 2
    for i in range(n):
        y = y0 + off + i * pitch
        pos = x0 + rng.uniform(0, lmin)
        if rng.random() < 0.5:
            lines.append(LineString([(x0, y), (pos - gap, y)])) if pos - gap - x0 > 3 else None
        else:
            pos = x0
        while pos < x1 - 3:
            end = min(x1, pos + rng.uniform(lmin, lmax))
            if x1 - end < lmin:
                end = x1
            if end - pos > 3:
                lines.append(LineString([(pos, y), (end, y)]))
            pos = end + gap
    return lines


def kerf_rows(W, u0, u1, pitch, slit_len, gap, ext):
    """Egiluvchan zona kesiklari (strip koordinatasida: z bo'ylab, u qatorlar)."""
    N = max(1, round(W / (slit_len + gap)))
    P = W / N
    L = P - gap
    lines = []
    u = u0 + pitch / 2
    i = 0
    while u <= u1 - pitch / 2 + 1e-9:
        if i % 2 == 0:            # A qator — chetlari yopiq
            for k in range(N):
                z0 = k * P + gap / 2
                lines.append(LineString([(z0, u), (z0 + L, u)]))
        else:                      # B qator — chetlarga chiqadi
            lines.append(LineString([(-ext, u), (P / 2 - gap / 2, u)]))
            for k in range(N - 1):
                z0 = P / 2 + k * P + gap / 2
                lines.append(LineString([(z0, u), (z0 + L, u)]))
            lines.append(LineString([(W - P / 2 + gap / 2, u), (W + ext, u)]))
        u += pitch
        i += 1
    return lines


# --------------------------------------------------------------------------
# Detal (bo'lak)
# --------------------------------------------------------------------------
@dataclass
class Piece:
    name: str
    label: str
    shape: object                       # shapely Polygon (kerf kompensatsiyasiz)
    kerf_lines: list = field(default_factory=list)   # kesiladigan ochiq chiziqlar
    engrave: list = field(default_factory=list)      # gravirovka chiziqlari

    def mirrored_x(self, cx):
        f = lambda g: affinity.scale(g, -1, 1, origin=(cx, 0))
        return Piece(self.name, self.label, f(self.shape),
                     [f(g) for g in self.kerf_lines], [f(g) for g in self.engrave])


# --------------------------------------------------------------------------
# Quti
# --------------------------------------------------------------------------
class Chest:
    def __init__(self, p: Params):
        p.check()
        self.p = p
        T, W, D, H = p.T, p.W, p.D, p.H
        self.hb = p.hinge_below
        # tish naqshlari
        self.v_front = odd_segments(-H, 0, p.finger)            # old <-> yon (y)
        self.v_back = odd_segments(-H, -self.hb, p.finger)      # orqa <-> yon (y)
        self.b_w = odd_segments(T, W - T, p.finger)             # tag <-> old/orqa (z)
        self.b_d = odd_segments(T, D - T, p.finger)             # tag <-> yon (x)
        # qopqoq
        self.U_lid = lid_path_len(p, T / 2)
        self.U_total = H + self.U_lid
        # to'g'rilovchi tishcha (qopqoq yon detalining pasti, old tomonda)
        self.tab_x0 = T + 5.0
        self.tab_x1 = T + 5.0 + 2 * T
        # magnit va yurak
        self.mag_r = p.magnet_d / 2
        self.mag_y = -(self.mag_r + 2.5)
        self.heart_top = p.lid_straight - 0.6
        self.heart_w = p.heart_w or self._auto_heart_w()
        self.heart = heart_poly(W / 2, self.heart_top, self.heart_w)
        self.rng = random.Random(p.seed)

    def _auto_heart_w(self):
        p = self.p
        need = p.magnet_d + 3.2
        w = 0.38 * p.W
        while w < 0.65 * p.W:
            h = heart_poly(p.W / 2, self.heart_top, w)
            if (width_at(h, self.mag_y - self.mag_r) >= need and
                    h.bounds[1] <= self.mag_y - self.mag_r - 2.5):
                return round(w, 1)
            w += 0.5
        return round(w, 1)

    # ---- korpus -------------------------------------------------------
    def front(self):
        p, T, W, H = self.p, self.p.T, self.p.W, self.p.H
        g = box(0, -H, W, 0)
        for i, (a, b) in enumerate(self.v_front):
            if i % 2:
                g = g.difference(box(-1, a, T, b)).difference(box(W - T, a, W + 1, b))
        for i, (a, b) in enumerate(self.b_w):
            if i % 2:
                g = g.difference(box(a, -H - 1, b, -H + T))
        g = g.difference(Point(W / 2, self.mag_y).buffer(self.mag_r, 64))
        eng = []
        if p.engrave:
            area = box(T + 1.5, -H + T + 2, W - T - 1.5, -2.2)
            eng = planks(T + 1.5, W - T - 1.5, -H + T + 2.5, -2.5, 4.3, self.rng)
            hole = Point(W / 2, self.mag_y).buffer(self.mag_r + 1.2)
            eng = [l.difference(hole) for l in eng]
            eng = [x for l in eng for x in as_lines(l.intersection(area))]
        return Piece("front", "OLD DEVOR", g, [], eng)

    def side(self):
        """O'ng yon devor, tashqaridan qaralganda (x: 0=old, D=orqa)."""
        p, T, D, H = self.p, self.p.T, self.p.D, self.p.H
        g = box(0, -H, D, 0)
        for i, (a, b) in enumerate(self.v_front):
            if i % 2 == 0:
                g = g.difference(box(-1, a, T, b))
        for i, (a, b) in enumerate(self.v_back):
            if i % 2 == 0:
                g = g.difference(box(D - T, a, D + 1, b))
        g = g.difference(box(D - T, -self.hb - 0.001, D + 1, 1))   # sharnir zonasi
        for i, (a, b) in enumerate(self.b_d):
            if i % 2:
                g = g.difference(box(a, -H - 1, b, -H + T))
        c = p.tab_clear
        g = g.difference(box(self.tab_x0 - c, -p.tab_h - c, self.tab_x1 + c, 1))
        eng = []
        if p.engrave:
            eng = planks(T + 1.5, D - T - 1.5, -H + T + 2.5, -p.tab_h - 2.5, 4.3, self.rng)
        return Piece("side", "YON DEVOR", g, [], eng)

    def bottom(self):
        T, W, D = self.p.T, self.p.W, self.p.D
        g = box(T, T, W - T, D - T)
        parts = [g]
        for i, (a, b) in enumerate(self.b_w):
            if i % 2:
                parts += [box(a, 0, b, T), box(a, D - T, b, D)]
        for i, (a, b) in enumerate(self.b_d):
            if i % 2:
                parts += [box(0, a, T, b), box(W - T, a, W, b)]
        return Piece("bottom", "TAG", unary_union(parts), [], [])

    def strip(self):
        """Orqa devor + sharnir + qopqoq terisi (bitta bo'lak). Koordinata (z, u)."""
        p, T, W, H = self.p, self.p.T, self.p.W, self.p.H
        U = self.U_total
        g = box(0, 0, W, U)
        for i, (a, b) in enumerate(self.v_back):
            if i % 2:
                g = g.difference(box(-1, a + H, T, b + H)).difference(
                    box(W - T, a + H, W + 1, b + H))
        for i, (a, b) in enumerate(self.b_w):
            if i % 2:
                g = g.difference(box(a, -1, b, T))
        u_front = U - p.lid_straight          # oldingi tik qism boshlanishi
        ext = p.kerf / 2 + 0.4
        kl = kerf_rows(W, H - self.hb, u_front + 1.2, p.kerf_pitch,
                       p.slit_len, p.slit_gap, ext)
        eng = []
        if p.engrave:
            eng += planks(T + 1.5, W - T - 1.5, T + 2.5, H - self.hb - 2.0, 4.3, self.rng)
            eng += planks(1.5, W - 1.5, u_front + 3.0, U - 1.5, 3.2, self.rng)
        return Piece("strip", "ORQA DEVOR + SHARNIR + QOPQOQ", g, kl, eng)

    def lid_side(self):
        """Qopqoq yon detali (o'ng, tashqaridan), dunyo x koordinatasida."""
        p = self.p
        g = Polygon(lid_path(p, 0.0))
        h = p.tab_h
        tab = Polygon([(self.tab_x0 + 0.6, -h), (self.tab_x1, -h),
                       (self.tab_x1, 0.001), (self.tab_x0, 0.001), (self.tab_x0, -h + 0.6)])
        return Piece("lid_side", "QOPQOQ YONI", unary_union([g, tab]), [], [])

    def heart_front(self):
        p = self.p
        hp = self.heart
        eng = []
        if p.engrave:
            eng = self._heart_ornament(hp)
        return Piece("heart_front", "YURAK (old qatlam)", hp, [], eng)

    def heart_back(self):
        hole = Point(self.p.W / 2, self.mag_y).buffer(self.mag_r, 64)
        return Piece("heart_back", "YURAK (orqa qatlam, magnit)", self.heart.difference(hole), [], [])

    def _heart_ornament(self, hp):
        """Yurak ustidagi gul-naqsh (o'zimizning dizayn)."""
        w = self.heart_w
        minx, miny, maxx, maxy = hp.bounds
        h = maxy - miny
        cx = (minx + maxx) / 2
        inner = hp.buffer(-0.09 * w)
        clip = inner.buffer(-0.5)
        geo = [inner.exterior]

        def flower(x, y, R, n=5, rot=90):
            petals = []
            for k in range(n):
                ang = math.radians(rot + 360 * k / n)
                e = affinity.scale(Point(0, 0).buffer(1, 48), 0.46 * R, 0.27 * R)
                e = affinity.rotate(e, math.degrees(ang), origin=(0, 0))
                petals.append(affinity.translate(e, x + 0.52 * R * math.cos(ang),
                                                 y + 0.52 * R * math.sin(ang)))
            fl = unary_union(petals)
            c = Point(x, y).buffer(0.2 * R, 32)
            return [fl.difference(c).exterior, c.exterior]

        def curl(x, y, r, turns=1.6, sgn=1, a0=0.0):
            th = np.linspace(0, 2 * np.pi * turns, 200)
            rr = r * (0.15 + th / th.max())
            pts = np.c_[x + sgn * rr * np.cos(th + a0), y + rr * np.sin(th + a0)]
            return LineString(pts)

        def leaf(x, y, L, ang):
            e = affinity.scale(Point(0, 0).buffer(1, 48), L / 2, L / 5.5)
            e = affinity.rotate(e, ang, origin=(0, 0))
            e = affinity.translate(e, x, y)
            mid = affinity.translate(affinity.rotate(
                LineString([(-L / 2.4, 0), (L / 2.4, 0)]), ang, origin=(0, 0)), x, y)
            return [e.exterior, mid]

        top = maxy
        geo += flower(cx, top - 0.43 * h, 0.17 * w, 6, 90)
        for s in (-1, 1):
            geo += flower(cx + s * 0.25 * w, top - 0.22 * h, 0.105 * w, 5, 90)
            geo.append(curl(cx + s * 0.27 * w, top - 0.52 * h, 0.06 * w, 1.5, s, math.pi))
            geo += leaf(cx + s * 0.11 * w, top - 0.68 * h, 0.13 * w, 90 - s * 40)
            geo.append(Point(cx + s * 0.13 * w, top - 0.08 * h).buffer(0.025 * w, 24).exterior)
        out = []
        for gm in geo:
            ln = LineString(gm.coords) if not isinstance(gm, LineString) else gm
            if gm is geo[0]:
                out.append(ln)
            else:
                out += as_lines(ln.intersection(clip))
        return out

    # ---- hammasi --------------------------------------------------------
    def pieces(self):
        p = self.p
        side_r = self.side()
        side_l = side_r.mirrored_x(p.D / 2)
        side_r.label += " (o'ng)"
        side_l.label += " (chap)"
        lid_r = self.lid_side()
        lid_l = lid_r.mirrored_x(p.D / 2)
        lid_r.label += " (o'ng)"
        lid_l.label += " (chap)"
        return [self.strip(), self.bottom(), self.front(), side_l, side_r,
                lid_l, lid_r, self.heart_front(), self.heart_back()]


# --------------------------------------------------------------------------
# Joylashtirish va eksport
# --------------------------------------------------------------------------
def compensate(shape, kerf):
    if kerf <= 0:
        return shape
    return shape.buffer(kerf / 2, join_style="mitre", mitre_limit=4)


def layout(pieces, gap=4.0, max_w=None):
    """Detallarni varaqqa joylaydi. Qaytaradi: [(piece, dx, dy)] (y pastga)."""
    # SVG uchun y ni teskari qilamiz
    flipped = []
    for pc in pieces:
        f = lambda g: affinity.scale(g, 1, -1, origin=(0, 0))
        flipped.append(Piece(pc.name, pc.label, f(pc.shape),
                             [f(g) for g in pc.kerf_lines], [f(g) for g in pc.engrave]))
    widths = [pc.shape.bounds[2] - pc.shape.bounds[0] for pc in flipped]
    if max_w is None:
        max_w = max(widths[0] + 3 * max(widths[1:]) + 4 * gap, 220)
    order = sorted(range(len(flipped)),
                   key=lambda i: -(flipped[i].shape.bounds[3] - flipped[i].shape.bounds[1]))
    placed = []
    x = y = gap
    row_h = 0
    # birinchi (eng baland) — chap ustun; qolganlari o'ngda qatorlarda
    first = order[0]
    pc = flipped[first]
    b = pc.shape.bounds
    placed.append((pc, gap - b[0], gap - b[1]))
    col_x = gap + (b[2] - b[0]) + gap
    col_h = b[3] - b[1]
    x, y = col_x, gap
    for i in order[1:]:
        pc = flipped[i]
        b = pc.shape.bounds
        w, h = b[2] - b[0], b[3] - b[1]
        if x + w > max_w and x > col_x:
            x = col_x if y + row_h + gap < col_h else gap
            y += row_h + gap
            row_h = 0
        placed.append((pc, x - b[0], y - b[1]))
        x += w + gap
        row_h = max(row_h, h)
    return placed


def fmt(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def path_d(coords, dx, dy, close):
    pts = [(x + dx, y + dy) for x, y in coords]
    if close and len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    d = "M" + " L".join(f"{fmt(x)},{fmt(y)}" for x, y in pts)
    return d + (" Z" if close else "")


def export(chest, out_dir, name):
    p = chest.p
    pieces = chest.pieces()
    placed = layout(pieces)
    os.makedirs(out_dir, exist_ok=True)

    cut_paths, kerf_paths, eng_paths = [], [], []
    maxx = maxy = 0
    polys_for_preview = []
    for pc, dx, dy in placed:
        g = compensate(pc.shape, p.kerf)
        g = g.simplify(0.01)
        geoms = [g] if isinstance(g, Polygon) else list(g.geoms)
        for pg in geoms:
            cut_paths.append(path_d(pg.exterior.coords, dx, dy, True))
            for r in pg.interiors:
                cut_paths.append(path_d(r.coords, dx, dy, True))
        for ln in pc.kerf_lines:
            kerf_paths.append(path_d(ln.coords, dx, dy, False))
        for ln in pc.engrave:
            eng_paths.append(path_d(ln.simplify(0.01).coords, dx, dy, False))
        b = g.bounds
        maxx = max(maxx, b[2] + dx)
        maxy = max(maxy, b[3] + dy)
        polys_for_preview.append((pc, dx, dy, g))
    Wd, Hd = maxx + 4, maxy + 4

    def svg(preview=False):
        sw = 0.35 if preview else 0.1
        o = [f'<?xml version="1.0" encoding="UTF-8"?>',
             f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(Wd)}mm" height="{fmt(Hd)}mm" '
             f'viewBox="0 0 {fmt(Wd)} {fmt(Hd)}">']
        if preview:
            o.append(f'<rect width="{fmt(Wd)}" height="{fmt(Hd)}" fill="#ffffff"/>')
            for pc, dx, dy, g in polys_for_preview:
                geoms = [g] if isinstance(g, Polygon) else list(g.geoms)
                for pg in geoms:
                    d = path_d(pg.exterior.coords, dx, dy, True)
                    for r in pg.interiors:
                        d += " " + path_d(r.coords, dx, dy, True)
                    o.append(f'<path d="{d}" fill="#ecd3a8" fill-rule="evenodd" stroke="none"/>')
        o.append(f'<g id="ENGRAVE" fill="none" stroke="#0000FF" stroke-width="{sw}">')
        o += [f'<path d="{d}"/>' for d in eng_paths]
        o.append('</g>')
        o.append(f'<g id="KERF" fill="none" stroke="{p.cut_color}" stroke-width="{sw}">')
        o += [f'<path d="{d}"/>' for d in kerf_paths]
        o.append('</g>')
        o.append(f'<g id="CUT" fill="none" stroke="{p.cut_color}" stroke-width="{sw}">')
        o += [f'<path d="{d}"/>' for d in cut_paths]
        o.append('</g>')
        if preview:
            for pc, dx, dy, g in polys_for_preview:
                c = g.representative_point() if pc.name.startswith("heart") else g.centroid
                cxp, cyp = c.x + dx, c.y + dy
                fs = 2.6 if not pc.name.startswith("heart") else 1.8
                yb = g.bounds[3] + dy + 3.2
                o.append(f'<text x="{fmt(cxp)}" y="{fmt(yb)}" font-family="DejaVu Sans, Arial" '
                         f'font-size="{fs}" text-anchor="middle" fill="#333">{pc.label}</text>')
        o.append('</svg>')
        return "\n".join(o)

    base = os.path.join(out_dir, name)
    with open(base + ".svg", "w") as f:
        f.write(svg(False))
    with open(base + "_preview.svg", "w") as f:
        f.write(svg(True))

    # DXF
    import ezdxf
    doc = ezdxf.new("R2010", setup=True)
    doc.units = ezdxf.units.MM
    doc.header["$INSUNITS"] = 4
    cc = p.cut_color.lstrip("#").lower()
    aci = {"000000": 7, "ff0000": 1, "0000ff": 5, "00ff00": 3}.get(cc, 7)
    for lname in ("CUT", "KERF"):
        lay = doc.layers.add(lname, color=aci)
        lay.rgb = tuple(int(cc[i:i + 2], 16) for i in (0, 2, 4))
    cut_attr = {"color": aci, "true_color": int(cc, 16)}
    doc.layers.add("ENGRAVE", color=5)
    msp = doc.modelspace()
    for pc, dx, dy, g in polys_for_preview:
        geoms = [g] if isinstance(g, Polygon) else list(g.geoms)
        for pg in geoms:
            for ring in [pg.exterior, *pg.interiors]:
                pts = [(x + dx, Hd - (y + dy)) for x, y in ring.coords[:-1]]
                msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "CUT", **cut_attr})
        for ln in pc.kerf_lines:
            pts = [(x + dx, Hd - (y + dy)) for x, y in ln.coords]
            msp.add_lwpolyline(pts, dxfattribs={"layer": "KERF", **cut_attr})
        for ln in pc.engrave:
            pts = [(x + dx, Hd - (y + dy)) for x, y in ln.simplify(0.01).coords]
            msp.add_lwpolyline(pts, dxfattribs={"layer": "ENGRAVE"})
    doc.saveas(base + ".dxf")
    try:
        import cairosvg
        cairosvg.svg2pdf(url=base + ".svg", write_to=base + ".pdf")
        cairosvg.svg2png(url=base + "_preview.svg", write_to=base + "_chizma.png",
                         output_width=2400)
        os.remove(base + "_preview.svg")   # yozuvli nusxani kesishga adashtirmaslik uchun
    except Exception as ex:  # cairosvg ixtiyoriy
        print("PDF/PNG yaratilmadi:", ex)
    return base, (Wd, Hd), placed


# --------------------------------------------------------------------------
# 3D tekshiruv (voksel): detallar bir-biriga kirmasligi va tirqish yo'qligi
# --------------------------------------------------------------------------
def voxelize(chest, res=None):
    p = chest.p
    T, W, D, H = p.T, p.W, p.D, p.H
    top = p.lid_straight + p.lid_rise + T
    if res is None:   # ~10 mln voksel atrofida
        res = max(0.25, round((W * D * (H + top) / 1.0e7) ** (1 / 3) * 8) / 8)
    xs = np.arange(0, D, res) + res / 2
    ys = np.arange(-H, top, res) + res / 2
    zs = np.arange(0, W, res) + res / 2
    ids = np.zeros((len(xs), len(ys), len(zs)), np.int8)
    cnt = np.zeros_like(ids)
    names = {}

    def put(pid, name, mask3):
        names[pid] = name
        cnt[mask3] += 1
        ids[mask3] = pid

    def m2(poly, A, B):
        return shapely.contains_xy(poly, A, B)

    def rng(arr, lo, hi):
        return (arr > lo) & (arr < hi)

    # old devor (z,y), x in [0,T]
    Z, Y = np.meshgrid(zs, ys, indexing="ij")
    fr = m2(chest.front().shape, Z, Y)                     # (z, y)
    put(1, "old", rng(xs, 0, T)[:, None, None] & fr.T[None, :, :])
    # yon devorlar (x,y)
    X, Y2 = np.meshgrid(xs, ys, indexing="ij")
    sd = m2(chest.side().shape, X, Y2)
    put(2, "yon chap", sd[:, :, None] & rng(zs, 0, T)[None, None, :])
    put(3, "yon o'ng", sd[:, :, None] & rng(zs, W - T, W)[None, None, :])
    # tag (z,x), y in [-H,-H+T]
    Z2, X2 = np.meshgrid(zs, xs, indexing="ij")
    bt = m2(chest.bottom().shape, Z2, X2)                  # (z, x)
    put(4, "tag", bt.T[:, None, :] & rng(ys, -H, -H + T)[None, :, None])
    # strip korpus qismi (z,u=y+H) x in [D-T, D], y<=0
    st = chest.strip().shape.intersection(box(-5, -5, W + 5, H))
    stm = m2(st, Z, Y + H) & (Y <= 0)
    put(5, "orqa+qopqoq", rng(xs, D - T, D)[:, None, None] & stm.T[None, :, :])
    # qopqoq terisi
    pin = Polygon(lid_path(p, 0))
    pout = pin.buffer(T, 64).intersection(box(-1, 0, D + 1, top + 5))
    skin = pout.difference(pin)
    sk = m2(skin, X, Y2)
    put(5, "orqa+qopqoq", sk[:, :, None] & rng(zs, 0, W)[None, None, :])
    # qopqoq yon detallari
    ls = m2(chest.lid_side().shape, X, Y2)
    put(6, "qopqoq yoni chap", ls[:, :, None] & rng(zs, 0, T)[None, None, :])
    put(7, "qopqoq yoni o'ng", ls[:, :, None] & rng(zs, W - T, W)[None, None, :])
    return dict(xs=xs, ys=ys, zs=zs, ids=ids, cnt=cnt, names=names, res=res,
                pin=pin, pout=pout)


def verify(chest):
    p = chest.p
    T, W, D, H = p.T, p.W, p.D, p.H
    v = voxelize(chest)
    xs, ys, zs, cnt = v["xs"], v["ys"], v["zs"], v["cnt"]
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
    rep = []
    over = int((cnt > 1).sum())
    rep.append(f"bir-biriga kirgan vokselllar: {over}")
    # korpus qobig'i
    base = Y < 0
    shell = base & ((X < T) | (X > D - T) | (Z < T) | (Z > W - T) | (Y < -H + T))
    known = ((Z - W / 2) ** 2 + (Y - chest.mag_y) ** 2 < (chest.mag_r + 0.3) ** 2) & (X < T)
    c = p.tab_clear
    known |= ((X > chest.tab_x0 - c - 0.3) & (X < chest.tab_x1 + c + 0.3) &
              (Y > -p.tab_h - c - 0.3) & ((Z < T) | (Z > W - T)))
    holes = shell & (cnt == 0) & ~known
    rep.append(f"korpus devorlarida tirqish vokselllari: {int(holes.sum())}")
    inside = base & ~shell & (cnt > 0)
    rep.append(f"korpus ichiga chiqib qolgan vokselllar: {int(inside.sum())}")
    # qopqoq
    lid = Y > 0
    pin, pout = v["pin"], v["pout"]
    in_out = shapely.contains_xy(pout, X[:, :, 0], Y[:, :, 0])[:, :, None]
    in_in = shapely.contains_xy(pin, X[:, :, 0], Y[:, :, 0])[:, :, None]
    lid_shell = lid & in_out & (~in_in | (Z < T) | (Z > W - T))
    rep.append(f"qopqoqda tirqish vokselllari: {int((lid_shell & (cnt == 0)).sum())}")
    # qopqoq terisi uzunligi
    mid = LineString(lid_path(p, T / 2))
    rep.append(f"qopqoq terisi uzunligi: hisob {chest.U_lid:.2f} mm, "
               f"egri chiziq {mid.length:.2f} mm")
    return rep, v


# --------------------------------------------------------------------------
# 3D ko'rinish (voksel render)
# --------------------------------------------------------------------------
def render(chest, v, path, az=-35, el=24, px_per_mm=None, flip_back=False):
    from scipy import ndimage
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    p = chest.p
    T, W, D, H = p.T, p.W, p.D, p.H
    if px_per_mm is None:
        px_per_mm = 660 / max(W, D, H + p.lid_straight + p.lid_rise + T)
    ids = v["ids"]
    res = v["res"]
    occ = ids > 0
    # sirt vokselllari
    er = ndimage.binary_erosion(occ, structure=np.ones((3, 3, 3)), border_value=0)
    surf = occ & ~er
    ii, jj, kk = np.nonzero(surf)
    x = v["xs"][ii]; y = v["ys"][jj]; z = v["zs"][kk]
    pid = ids[ii, jj, kk]
    # silliq normal (har bir detal alohida)
    nrm = np.zeros((len(x), 3))
    for k in np.unique(pid):
        f = ndimage.gaussian_filter((ids == k).astype(np.float32), 1.6,
                                    mode="constant", cval=0.0)
        g = np.gradient(f)
        sel = pid == k
        for a in range(3):
            nrm[sel, a] = -g[a][ii[sel], jj[sel], kk[sel]]
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    # dunyo: x=chuqurlik, y=yuqori, z=en. Ko'rinish koordinatasi
    P = np.c_[z - W / 2, x - D / 2, y]          # (en, chuqurlik, balandlik) -> X,Y,Z
    N = np.c_[nrm[:, 2], nrm[:, 0], nrm[:, 1]]
    if flip_back:
        P[:, 0] *= -1; P[:, 1] *= -1; N[:, 0] *= -1; N[:, 1] *= -1
    a, e = math.radians(az), math.radians(el)
    # kamera: old tomondan (−Y), az bo'yicha aylantirish
    Rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    Rx = np.array([[1, 0, 0], [0, math.cos(e), -math.sin(e)], [0, math.sin(e), math.cos(e)]])
    R = Rx @ Rz
    Q = P @ R.T
    NQ = N @ R.T
    # ekran: u=Q0, v=Q2, chuqurlik=Q1 (kattasi uzoqda)
    vis = NQ[:, 1] < 0.15
    # rang
    wood = np.array([0.93, 0.80, 0.60])
    burnt = np.array([0.36, 0.22, 0.13])
    col = np.tile(wood, (len(x), 1))
    # kesilgan qirralar (burnt): normal detal qalinligi o'qiga perpendikulyar
    edge = np.zeros(len(x), bool)
    thick_axis = {1: 0, 2: 2, 3: 2, 4: 1, 6: 2, 7: 2}
    for k, ax in thick_axis.items():
        sel = pid == k
        edge[sel] = np.abs(nrm[sel, ax]) < 0.6
    sel = pid == 5
    base_part = sel & (y < 0)
    edge[base_part] = np.abs(nrm[base_part, 0]) < 0.6
    lidpart = sel & (y >= 0)
    edge[lidpart] = np.abs(nrm[lidpart, 2]) > 0.6
    col[edge] = burnt
    # gravirovka va egiluvchan kesiklar — sirtda qoramtir chiziqlar
    dark = np.zeros(len(x), bool)
    def mark(mask, A, B, lines, wdt):
        if not lines or not mask.any():
            return
        g = unary_union([l.buffer(wdt / 2) for l in lines])
        dark[mask] |= shapely.contains_xy(g, A[mask], B[mask])
    fr = chest.front()
    mark((pid == 1) & ~edge & (x < T / 2), z, y, fr.engrave, 0.35)
    sdp = chest.side()
    mark((pid == 3) & ~edge & (z > W - T / 2), x, y, sdp.engrave, 0.35)
    mark((pid == 2) & ~edge & (z < T / 2), x, y, sdp.engrave, 0.35)
    stp = chest.strip()
    mark(base_part & ~edge & (x > D - T / 2), z, y + H, stp.engrave + stp.kerf_lines, 0.4)
    # qopqoq terisi: u koordinatasi
    mid = LineString(lid_path(p, T / 2))
    lm = lidpart & ~edge
    if lm.any():
        uu = shapely.line_locate_point(mid, shapely.points(x[lm], y[lm])) + H
        tmp = np.zeros(lm.sum(), bool)
        g = unary_union([l.buffer(0.25) for l in stp.kerf_lines + stp.engrave])
        tmp = shapely.contains_xy(g, z[lm], uu)
        dd = dark.copy()
        dd_l = dd[lm]; dd_l |= tmp; dark[lm] = dd_l
    col[dark & ~edge] = burnt * 1.15
    # yurak (alohida sirt, old devor oldida)
    light = np.array([-0.45, -0.75, 0.55]); light /= np.linalg.norm(light)
    Lr = R @ light
    shade = np.clip(-(NQ @ -Lr) * 0.0 + (NQ @ Lr), 0, 1)
    shade = 0.45 + 0.55 * shade
    col = col * shade[:, None]
    # yurakni qo'shamiz (old devor tekisligida, 2 qatlam)
    hp = chest.heart
    hpts = []
    grid = np.arange(0, 1, 1)
    hz = np.arange(hp.bounds[0], hp.bounds[2], res / 1.5)
    hy = np.arange(hp.bounds[1], hp.bounds[3], res / 1.5)
    HZ, HY = np.meshgrid(hz, hy)
    inside = shapely.contains_xy(hp, HZ, HY)
    hz_, hy_ = HZ[inside], HY[inside]
    hf = chest.heart_front()
    g = unary_union([l.buffer(0.18) for l in hf.engrave])
    hd = shapely.contains_xy(g, hz_, hy_)
    edge_h = ~shapely.contains_xy(hp.buffer(-0.35), hz_, hy_)
    hx = np.full(len(hz_), -2 * T)
    HPw = np.c_[hz_ - W / 2, hx - D / 2, hy_]
    if flip_back:
        HPw[:, 0] *= -1; HPw[:, 1] *= -1
    HQ = HPw @ R.T
    hn = np.array([0, -1, 0.0]) @ R.T
    hcol = np.tile(wood * (0.45 + 0.55 * max(0, hn @ Lr)), (len(hz_), 1))
    hcol[hd] = burnt * 1.1
    hcol[edge_h] = burnt
    hvis = np.full(len(hz_), (hn[1] < 0.15))
    Q = np.r_[Q[vis], HQ[hvis]]
    col = np.r_[col[vis], hcol[hvis]]
    # z-bufer
    U = Q[:, 0] * px_per_mm
    V = -Q[:, 2] * px_per_mm
    U -= U.min() - 20; V -= V.min() - 20
    w_img, h_img = int(U.max()) + 21, int(V.max()) + 21
    zbuf = np.full(w_img * h_img, np.inf)
    img = np.ones((w_img * h_img, 3)) * np.array([0.97, 0.96, 0.94])
    rad = max(1, int(math.ceil(res * px_per_mm * 0.75)))
    offs = [(du, dv) for du in range(-rad, rad + 1) for dv in range(-rad, rad + 1)]
    for du, dv in offs:
        pix = (np.round(V).astype(int) + dv) * w_img + (np.round(U).astype(int) + du)
        np.minimum.at(zbuf, pix, Q[:, 1])
    for du, dv in offs:
        pix = (np.round(V).astype(int) + dv) * w_img + (np.round(U).astype(int) + du)
        ok = Q[:, 1] <= zbuf[pix] + 1e-6
        img[pix[ok]] = col[ok]
    img = np.clip(img.reshape(h_img, w_img, 3), 0, 1)
    plt.imsave(path, img)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Lazer uchun sunduk generatori")
    for k, vdef in asdict(Params()).items():
        if isinstance(vdef, bool):
            ap.add_argument(f"--no-{k}", dest=k, action="store_false")
        else:
            ap.add_argument(f"--{k}", type=type(vdef), default=vdef)
    ap.add_argument("--out", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--name", default=None)
    ap.add_argument("--check", action="store_true", help="3D tekshiruv + render")
    a = ap.parse_args()
    kw = {k: getattr(a, k) for k in asdict(Params())}
    p = Params(**kw)
    ch = Chest(p)
    top = p.lid_straight + p.lid_rise + p.T
    name = a.name or f"sunduk_{fmt(p.W)}x{fmt(p.D)}x{fmt(p.H + top)}_{fmt(p.T)}mm"
    base, (wd, hd), _ = export(ch, a.out, name)
    print(f"Tayyor: {base}.svg / .dxf   varaq: {wd:.0f} x {hd:.0f} mm")
    print(f"Quti tashqi o'lchami: {p.W:g} x {p.D:g} x {p.H + top:g} mm "
          f"(korpus {p.H:g}, qopqoq {top:g}); yurak eni {ch.heart_w} mm")
    print(f"Orqa+qopqoq bo'lagi uzunligi: {ch.U_total:.1f} mm")
    if a.check:
        rep, v = verify(ch)
        print("\n".join(" - " + r for r in rep))
        render(ch, v, base + "_3d_old.png", az=-35, el=24)
        render(ch, v, base + "_3d_orqa.png", az=-35, el=20, flip_back=True)


if __name__ == "__main__":
    main()
