# Ruby Radar: art direction + asset manifest

Look: **retro pixel arcade meets game-show broadcast** — like a 16-bit
arcade cabinet's attract screen for a TV game show. Chunky pixel UI, a pixel
font, crisp 1px-outlined sprites, little looping animations. Dark screen,
ruby red as the "sweats" colour. Original art only: no Embark/THE FINALS logos
or characters, no Twitch logo.

## Palette (shared by sprites and CSS)

| token | hex | use |
| --- | --- | --- |
| `--void` | `#0d0b1a` | page background, sprite outline |
| `--night` | `#1a1630` | panels |
| `--dusk` | `#2a2347` | panel borders, empty heatmap cells |
| `--haze` | `#4a4270` | muted borders, shadows |
| `--mute` | `#8b85a8` | secondary text |
| `--cream` | `#f4f0e6` | main text, highlights |
| `--safe` | `#3ee0c2` | "queue up", cool end of heatmap |
| `--safe-dark` | `#1b8f8a` | shading for safe |
| `--gold` | `#ffcc33` | "coin flip", mid heatmap, coins |
| `--gold-dark` | `#c78a1a` | shading for gold |
| `--ruby` | `#e0284d` | "sweats", hot end of heatmap, brand accent |
| `--ruby-dark` | `#8f1236` | shading for ruby |
| `--ruby-light` | `#ff6b8b` | ruby highlights |
| `--live` | `#a970ff` | live-on-stream accents |

Sprites may add a few in-between shades, but stay close to this palette.
Light comes from the top-left. Outline colour: `--void`.

## Assets (all in `docs/art/`, PNG, transparent background)

Animated sprites are **horizontal strips**: frames side by side, no padding,
frame 0 on the left. The page animates them with CSS
`steps(N)` on `background-position`. Show everything at an integer scale
(2×, 3× or 4×) with `image-rendering: pixelated`.

| file | frame size | frames | ms/frame | what |
| --- | --- | --- | --- | --- |
| `radar.png` | 32×32 | 8 | 110 | logo: round radar scope, sweep line rotating, a ruby blip that flares when the sweep passes |
| `verdict-go.png` | 48×48 | 4 | 180 | QUEUE UP: happy ruby gem character (or arcade "GO" light) bouncing, teal glow |
| `verdict-coin.png` | 48×48 | 8 | 90 | COIN FLIP: gold coin spinning edge-on and back |
| `verdict-sweat.png` | 48×48 | 4 | 160 | SWEATS ONLINE: angry ruby gem character dripping sweat, red glow |
| `verdict-calibrating.png` | 48×48 | 6 | 160 | CALIBRATING: radar dish turning, or hourglass flipping |
| `stale.png` | 16×16 | 2 | 500 | warning sign blinking |
| `live.png` | 16×16 | 2 | 400 | broadcast antenna with signal waves (generic, not the Twitch logo) |
| `gem.png` | 12×12 | 1 | – | small ruby gem, marks Ruby players in lists |
| `favicon.png` | 32×32 | 1 | – | ruby gem on a radar ring, readable at 16px |

Sources live in `art/` as Lua scripts (`aseprite -b --script art/<name>.lua`)
plus the `.aseprite` files they write, so the art can be regenerated.
