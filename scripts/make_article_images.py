"""Render captured CLI output (with ANSI colours) into terminal-style PNGs for articles.

    python scripts/make_article_images.py

Reads docs/images/*.txt, writes docs/images/*.png next to them.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "docs" / "images"

FONT_ASCII = "C:/Windows/Fonts/consola.ttf"
FONT_ASCII_BOLD = "C:/Windows/Fonts/consolab.ttf"
FONT_CJK = "C:/Windows/Fonts/simsun.ttc"
FONT_CJK_BOLD = "C:/Windows/Fonts/simhei.ttf"
FONT_SYMBOL = "C:/Windows/Fonts/seguisym.ttf"

BG = (13, 17, 23)
BAR = (30, 34, 42)
BORDER = (48, 54, 61)
FG = (201, 209, 217)
TITLE_FG = (139, 148, 158)

PALETTE = {
    30: (72, 79, 88),
    31: (255, 107, 107),
    32: (86, 211, 100),
    33: (240, 198, 87),
    34: (97, 175, 239),
    35: (198, 120, 221),
    36: (86, 182, 194),
    37: (201, 209, 217),
    90: (110, 118, 129),
    91: (255, 129, 129),
    92: (117, 227, 130),
    93: (255, 219, 122),
    94: (121, 192, 255),
    95: (210, 140, 230),
    96: (110, 205, 216),
    97: (230, 237, 243),
}

ANSI_RE = re.compile(r"\x1b\[([0-9;]*)m")
FONT_SIZE = 19
CELL_W = 10.4
LINE_H = 29

# Consolas and SimSun lack these; Segoe UI Symbol has them all.
SYMBOLS = set("✓✗▪▍→↳↔·…≥√")


def is_wide(ch: str) -> bool:
    code = ord(ch)
    return (
        0x1100 <= code <= 0x115F
        or 0x2E80 <= code <= 0xA4CF
        or 0xAC00 <= code <= 0xD7A3
        or 0xF900 <= code <= 0xFAFF
        or 0xFE30 <= code <= 0xFE6F
        or 0xFF00 <= code <= 0xFF60
        or 0xFFE0 <= code <= 0xFFE6
        or 0x1F300 <= code <= 0x1FAFF
    )


def parse_ansi(text: str):
    """Return lines of [(char, rgb, bold)] and the max display width."""
    lines = []
    for raw_line in text.replace("\r\n", "\n").replace("\r", "").split("\n"):
        line = []
        fg = FG
        bold = False
        idx = 0
        for match in ANSI_RE.finditer(raw_line):
            for ch in raw_line[idx:match.start()]:
                line.append((ch, fg, bold))
            for token in match.group(1).split(";"):
                if token == "":
                    continue
                code = int(token)
                if code == 0:
                    fg, bold = FG, False
                elif code == 1:
                    bold = True
                elif code == 2:
                    fg = PALETTE[90]
                elif code == 22:
                    bold = False
                elif code == 39:
                    fg = FG
                elif code in PALETTE:
                    fg = PALETTE[code]
            idx = match.end()
        for ch in raw_line[idx:]:
            line.append((ch, fg, bold))
        lines.append(line)

    while lines and not "".join(c for c, _, _ in lines[-1]).strip():
        lines.pop()
    width = max(
        (sum(2 if is_wide(c) else 1 for c, _, _ in line) for line in lines),
        default=0,
    )
    return lines, width


def render(txt_path: Path, png_path: Path, title: str) -> None:
    text = redact(txt_path.read_text(encoding="utf-8"))
    lines, cols = parse_ansi(text)

    pad_x, pad_y = 26, 20
    chrome_h = 40
    width = int(pad_x * 2 + cols * CELL_W) + 24
    height = int(chrome_h + pad_y * 2 + len(lines) * LINE_H)
    width = max(width, 720)

    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)

    # window chrome
    draw.rounded_rectangle([0, 0, width - 1, height - 1], radius=12, outline=BORDER, width=1, fill=BG)
    draw.rounded_rectangle([0, 0, width - 1, chrome_h], radius=12, fill=BAR)
    draw.rectangle([0, chrome_h - 12, width - 1, chrome_h], fill=BAR)
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 20 + i * 20
        draw.ellipse([cx, 15, cx + 11, 26], fill=color)

    title_font = ImageFont.truetype(FONT_ASCII, 14)
    draw.text((width / 2, chrome_h / 2), title, font=title_font, fill=TITLE_FG, anchor="mm")

    fonts = {
        (False, False): ImageFont.truetype(FONT_ASCII, FONT_SIZE),
        (False, True): ImageFont.truetype(FONT_CJK, FONT_SIZE),
        (True, False): ImageFont.truetype(FONT_ASCII_BOLD, FONT_SIZE),
        (True, True): ImageFont.truetype(FONT_CJK_BOLD, FONT_SIZE),
    }
    symbol_font = ImageFont.truetype(FONT_SYMBOL, FONT_SIZE)

    y = chrome_h + pad_y
    for line in lines:
        x = pad_x
        for ch, color, bold in line:
            if ch == "\t":
                ch = "    "
            wide = is_wide(ch)
            if ch in SYMBOLS:
                # centre the glyph inside its single cell
                try:
                    glyph_w = symbol_font.getlength(ch)
                except Exception:
                    glyph_w = CELL_W
                draw.text((x + (CELL_W - glyph_w) / 2, y), ch, font=symbol_font, fill=color)
            elif ch.strip():
                draw.text((x, y), ch, font=fonts[(bold, wide)], fill=color)
            x += CELL_W * (2 if wide else 1)
        y += LINE_H

    png_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(png_path, "PNG", optimize=True)
    print(f"{png_path.name}: {width}x{height} ({png_path.stat().st_size // 1024} KB)")


JOBS = [
    ("agc-doctor-before.txt", "agc-doctor-before.png", "hss doctor — real AGC material"),
    ("agc-fix.txt", "agc-fix.png", "hss fix — before / after"),
    ("agc-doctor-after.txt", "agc-doctor-after.png", "hss doctor — after fix"),
]

# Never publish real developer names / IDs in screenshots.
REDACTIONS = [
    (re.compile(r"廖海钞\(\d+\)\\*"), "<developer>"),
    (re.compile(r"廖海钞"), "<developer>"),
    (re.compile(r"\(\d{10,}\)"), "(<developer-id>)"),
]

def redact(text: str) -> str:
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def main() -> int:
    for src, dst, title in JOBS:
        src_path = IMG_DIR / src
        if not src_path.exists():
            print(f"missing {src_path}", file=sys.stderr)
            return 1
        render(src_path, IMG_DIR / dst, title)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
