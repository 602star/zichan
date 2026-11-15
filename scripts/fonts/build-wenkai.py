"""Convert the complete upstream v1.530 TTF to a bundled WOFF2, without subsetting.

Requires Python and fonttools[woff]==4.60.1. Usage:
  python scripts/fonts/build-wenkai.py path/to/LXGWWenKaiScreen.ttf
Download: https://github.com/lxgw/LxgwWenKai-Screen/releases/tag/v1.530
Retain public/licenses/lxgw-wenkai-screen.txt when distributing the font.
"""
import hashlib
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

SOURCE_HASH = 'abd13364163e3cd84372b333f2fdcee9efb848634668f1c0ce5788dcd059ee61'
source = Path(sys.argv[1])
if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_HASH:
    raise SystemExit('Expected the official LXGWWenKaiScreen.ttf v1.530; SHA-256 mismatch.')
output = Path(__file__).resolve().parents[2] / 'apps/web/src/assets/fonts'
output.mkdir(parents=True, exist_ok=True)
font = TTFont(source, recalcTimestamp=False)
original_cmap = font.getBestCmap()
original_glyphs = font.getGlyphOrder()
filename = 'wenkai-screen-1.530-full.woff2'
font.flavor = 'woff2'
font.save(output / filename)
converted = TTFont(output / filename)
if converted.getBestCmap() != original_cmap or converted.getGlyphOrder() != original_glyphs:
    raise SystemExit('Conversion changed characters or glyphs.')
(output / 'wenkai.css').write_text(
    "/* Complete upstream v1.530; format conversion only. SIL OFL 1.1. */\n"
    "@font-face {\n  font-family: 'LXGW WenKai Screen';\n"
    f"  src: url('./{filename}') format('woff2');\n"
    '  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n}\n',
    encoding='utf-8',
)
print(f'{filename}: {len(original_cmap)} codepoints, {len(original_glyphs)} glyphs, '
      f'{(output / filename).stat().st_size:,} bytes; complete character map and glyph order verified.')
