/**
 * The plus drawn for the quick-action buttons.
 *
 * The app used to draw this plus as a text glyph (`+`, `＋`), and every variant
 * sat about 2px below the centre of its circle: a glyph's ink is positioned by
 * the font's baseline and math axis, not by the centre of the line box, so flex
 * centring centres the line box and leaves the ink visibly low. The size of the
 * error also depended on which font resolved, which is why the same control
 * looked different in the sidebar, the tablet rail and the phone bar.
 *
 * Drawing it as two strokes removes the font from the equation. The path is
 * symmetric about (10, 10), which is the centre of the viewBox, so the ink is
 * centred by construction and cannot drift. `currentColor` keeps it inheriting
 * the existing colour rules.
 */
export function PlusIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}
