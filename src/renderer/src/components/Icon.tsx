// Custom icon system. Hand-tuned 16×16 SVG paths in a HUD/aerospace line-art
// style — 1.25px stroke, geometric, every glyph carries a small "instrumented"
// detail (notch, marker, asymmetric tail) so the set feels distinct from
// stock libraries. All icons use currentColor so text-color drives them.
// Exception: `alphacod` is the brand mark — rendered as the user's 3D ribbon
// PNG (see scripts/generate-icon.mjs), not as a stroke glyph.

import type { CSSProperties, SVGProps } from 'react'
import alphacodLogo from '../assets/alphacod-logo.png'

export type IconName =
  | 'pin'
  | 'reload'
  | 'external'
  | 'close'
  | 'max'
  | 'restore'
  | 'attach'
  | 'attach-image'
  | 'attach-doc'
  | 'attach-video'
  | 'attach-audio'
  | 'send'
  | 'sun'
  | 'moon'
  | 'spawn'
  | 'search'
  | 'check'
  | 'warn'
  | 'plus'
  | 'minus'
  | 'chevron-right'
  | 'chevron-down'
  | 'copy'
  | 'terminal'
  | 'chat'
  | 'desktop'
  | 'tablet'
  | 'mobile'
  | 'power'
  | 'alphacod'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName
  size?: number
  strokeWidth?: number
  style?: CSSProperties
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.25,
  style,
  ...rest
}: IconProps): React.JSX.Element {
  if (name === 'alphacod') {
    return (
      <img
        src={alphacodLogo}
        width={size}
        height={size}
        alt=""
        style={{
          flexShrink: 0,
          display: 'inline-block',
          verticalAlign: 'middle',
          objectFit: 'contain',
          ...style
        }}
      />
    )
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle', ...style }}
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}

const paths: Record<IconName, React.JSX.Element> = {
  // Pin: tilted diamond head + tail. The notch on the head makes it asymmetric.
  pin: (
    <>
      <path d="M9 2.2 L13.8 7 L11 8.5 L8 11.5 L4.5 8 Z" />
      <path d="M8 11.5 L4 15.5" />
      <path d="M10 4.5 L11 5.5" strokeWidth={0.8} />
    </>
  ),

  // Reload: 3/4 arc with arrowhead and inner tick (status mark).
  reload: (
    <>
      <path d="M13.5 4 V 8 H 9.5" />
      <path d="M13.2 8 A 5.5 5.5 0 1 0 11.5 12.5" />
      <path d="M3 11 L 3.7 11.7" strokeWidth={0.8} />
    </>
  ),

  // External: square-bracket frame opening upper-right + escape arrow.
  external: (
    <>
      <path d="M8 3 H 3 V 13 H 13 V 8" />
      <path d="M9 7 L 13.5 2.5" />
      <path d="M9.5 2.5 H 13.5 V 6.5" />
    </>
  ),

  // Close: clean × made of two crossed lines, slightly inset (12px effective).
  close: (
    <>
      <path d="M3.5 3.5 L 12.5 12.5" />
      <path d="M12.5 3.5 L 3.5 12.5" />
    </>
  ),

  // Max: 4 corner brackets only (no full box) — feels HUD-like.
  max: (
    <>
      <path d="M2.5 5 V 2.5 H 5" />
      <path d="M11 2.5 H 13.5 V 5" />
      <path d="M13.5 11 V 13.5 H 11" />
      <path d="M5 13.5 H 2.5 V 11" />
    </>
  ),

  // Restore (exit max): 4 inward-pointing corner ticks.
  restore: (
    <>
      <path d="M5 2.5 V 5 H 2.5" />
      <path d="M11 2.5 V 5 H 13.5" />
      <path d="M13.5 11 H 11 V 13.5" />
      <path d="M2.5 11 H 5 V 13.5" />
    </>
  ),

  // Attach (generic): paperclip-rejected. Uses a notched-corner card + marker.
  attach: (
    <>
      <path d="M3 4 H 10 L 13 7 V 13 H 3 Z" />
      <path d="M10 4 V 7 H 13" />
      <path d="M5.5 9.5 H 10.5" strokeWidth={0.8} />
    </>
  ),

  // Attach image: card + horizon line + sun mark.
  'attach-image': (
    <>
      <path d="M3 4 H 10 L 13 7 V 13 H 3 Z" />
      <path d="M10 4 V 7 H 13" />
      <circle cx="6" cy="9" r="1" />
      <path d="M3.5 12 L 6 10 L 9 12 L 12.5 9.5" />
    </>
  ),

  // Attach doc: card + 2 text lines.
  'attach-doc': (
    <>
      <path d="M3 4 H 10 L 13 7 V 13 H 3 Z" />
      <path d="M10 4 V 7 H 13" />
      <path d="M5 9.5 H 11" strokeWidth={0.8} />
      <path d="M5 11.5 H 9" strokeWidth={0.8} />
    </>
  ),

  // Attach video: card + play triangle.
  'attach-video': (
    <>
      <path d="M3 4 H 10 L 13 7 V 13 H 3 Z" />
      <path d="M10 4 V 7 H 13" />
      <path d="M6 8.5 V 12 L 10 10.25 Z" />
    </>
  ),

  // Attach audio: card + waveform marks.
  'attach-audio': (
    <>
      <path d="M3 4 H 10 L 13 7 V 13 H 3 Z" />
      <path d="M10 4 V 7 H 13" />
      <path d="M5 11 V 9.5" strokeWidth={0.8} />
      <path d="M7 11.5 V 9" strokeWidth={0.8} />
      <path d="M9 11 V 9.5" strokeWidth={0.8} />
      <path d="M11 11.3 V 9.7" strokeWidth={0.8} />
    </>
  ),

  // Send: angle-chevron with extending tail right.
  send: (
    <>
      <path d="M3 8 H 12.5" />
      <path d="M9 4.5 L 12.5 8 L 9 11.5" />
      <path d="M3 6 V 10" strokeWidth={0.8} />
    </>
  ),

  // Sun: octagonal core + 8 rays (no full circle — feels engineered).
  sun: (
    <>
      <path d="M6 5.5 L 10 5.5 L 11.5 7 L 11.5 9 L 10 10.5 L 6 10.5 L 4.5 9 L 4.5 7 Z" />
      <path d="M8 1.5 V 3" />
      <path d="M8 13 V 14.5" />
      <path d="M1.5 8 H 3" />
      <path d="M13 8 H 14.5" />
      <path d="M3.5 3.5 L 4.5 4.5" />
      <path d="M11.5 11.5 L 12.5 12.5" />
      <path d="M3.5 12.5 L 4.5 11.5" />
      <path d="M11.5 4.5 L 12.5 3.5" />
    </>
  ),

  // Moon: crescent + inner hairline (the hairline is the "instrument" detail).
  moon: (
    <>
      <path d="M12.5 10.5 A 5.5 5.5 0 1 1 6 3 A 4 4 0 0 0 12.5 10.5 Z" />
      <path d="M9 6.5 L 10.5 8" strokeWidth={0.7} />
    </>
  ),

  // Spawn: + inside corner-notched square.
  spawn: (
    <>
      <path d="M3.5 5 V 3.5 H 5" />
      <path d="M11 3.5 H 12.5 V 5" />
      <path d="M12.5 11 V 12.5 H 11" />
      <path d="M5 12.5 H 3.5 V 11" />
      <path d="M8 5 V 11" />
      <path d="M5 8 H 11" />
    </>
  ),

  // Search: rhombus lens + tail (rhombus replaces standard circle).
  search: (
    <>
      <path d="M7 2.5 L 11 6.5 L 7 10.5 L 3 6.5 Z" />
      <path d="M9.8 9 L 13.5 12.7" />
    </>
  ),

  // Check: bent tick made of two clear segments, no curve.
  check: (
    <>
      <path d="M3 8.5 L 6.5 12 L 13 5" />
    </>
  ),

  // Warn: triangle + 2 stacked dots (vertical line is two short dashes).
  warn: (
    <>
      <path d="M8 2.5 L 14 13 H 2 Z" />
      <path d="M8 6.5 V 9" strokeWidth={1} />
      <path d="M8 10.8 V 11.4" strokeWidth={1.2} />
    </>
  ),

  plus: (
    <>
      <path d="M8 3 V 13" />
      <path d="M3 8 H 13" />
    </>
  ),

  minus: (
    <>
      <path d="M3 8 H 13" />
    </>
  ),

  'chevron-right': (
    <>
      <path d="M6 3.5 L 10.5 8 L 6 12.5" />
    </>
  ),

  'chevron-down': (
    <>
      <path d="M3.5 6 L 8 10.5 L 12.5 6" />
    </>
  ),

  // Copy: two stacked notched-corner cards.
  copy: (
    <>
      <path d="M5 2.5 H 11 L 13 4.5 V 11 H 5 Z" />
      <path d="M11 2.5 V 4.5 H 13" />
      <path d="M3 5.5 V 13.5 H 11 V 11" />
    </>
  ),

  // Terminal: bracket frame with caret prompt.
  terminal: (
    <>
      <path d="M3 3.5 H 13 V 12.5 H 3 Z" />
      <path d="M5 7 L 7 8.5 L 5 10" />
      <path d="M8 10 H 11" strokeWidth={0.8} />
    </>
  ),

  // Chat: rounded-corner speech with tail-notch.
  chat: (
    <>
      <path d="M3 4 H 13 V 11 H 8.5 L 6 13.5 V 11 H 3 Z" />
      <path d="M6 7.5 H 10" strokeWidth={0.8} />
      <path d="M6 9 H 9" strokeWidth={0.8} />
    </>
  ),

  // Desktop: monitor with stand + corner mark.
  desktop: (
    <>
      <path d="M2.5 3 H 13.5 V 11 H 2.5 Z" />
      <path d="M6.5 13.5 H 9.5" />
      <path d="M8 11 V 13.5" strokeWidth={0.8} />
      <path d="M3.5 4 H 4.5" strokeWidth={0.8} />
    </>
  ),

  // Tablet: rounded-corner slate + home dot.
  tablet: (
    <>
      <path d="M4 2.5 H 12 V 13.5 H 4 Z" />
      <path d="M6.5 11.5 H 9.5" strokeWidth={0.8} />
    </>
  ),

  // Mobile: narrower slate + signal dot.
  mobile: (
    <>
      <path d="M5.5 2 H 10.5 V 14 H 5.5 Z" />
      <path d="M7 11.5 H 9" strokeWidth={0.8} />
      <path d="M7.5 3.5 H 8.5" strokeWidth={0.8} />
    </>
  ),

  // Power: 5/6 arc (gap at top) + vertical stem — universal restart symbol.
  power: (
    <>
      <path d="M 11.4 3.8 A 5.2 5.2 0 1 1 4.6 3.8" />
      <path d="M 8 2 V 8" />
    </>
  ),

  // Alphacod brand mark: α-character with descender tail and caudal fork.
  // Two layered shapes — diagonal ribbon strip (tail) + bowl ring with
  // counter (alpha). Tail draws first so the bowl renders over it at the
  // X-cross intersection. Both paths override Icon's default fill/stroke.
  alphacod: (
    <>
      <path
        fill="currentColor"
        stroke="none"
        d="M 2.55 2.5 L 12.55 12.5 L 14 12.15 L 12.5 13.5 L 11.15 15 L 11.45 13.5 L 1.45 3.5 Z"
      />
      <path
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
        d="M 9.7 8.5 A 3.2 3.5 0 0 1 3.3 8.5 A 3.2 3.5 0 0 1 9.7 8.5 Z M 8 8.5 A 1.5 1.8 0 0 0 5 8.5 A 1.5 1.8 0 0 0 8 8.5 Z"
      />
    </>
  )
}
