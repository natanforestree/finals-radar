-- verdict-sweat.png: SWEATS ONLINE. An angry, sweating ruby, 4 frames of 48x48: it trembles a
-- pixel side to side, glares from under furrowed brows, grits its teeth, and
-- sweat drops form, slide down the crown and fall off, one on each side, half a cycle apart.
-- A red glow pulses behind it.
-- Run from anywhere: aseprite -b --script art/verdict-sweat.lua
-- Writes art/verdict-sweat.aseprite (4 frames, 160 ms) and docs/art/verdict-sweat.png (192x48).
local here = debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$")
local L = dofile(here .. "lib.lua")
local G = dofile(here .. "gemchar.lua")(L)
local P = L.P
local N, CX, BOTTOM = 48, 24, 38

local SHAKE = { 0, 1, 0, -1 }
local GLOW = { 150, 100, 150, 100 }

-- the left eye under its brow; the right eye is its mirror image
local EYE = {
  "OO......",
  "OOOO....",
  ".OOOOOO.",
  ".OWWOOO.",
  ".OWWOOO.",
  ".OWWWWO.",
  "..OOOO..",
}
local TEETH = { -- clenched, wider at the bottom: a grimace
  "..OOOOOO..",
  ".OWOWWOWO.",
  "OOOOOOOOOO",
  "OWWOWWOWWO",
  ".OOOOOOOO.",
}
-- sweat drops by stage: forming, sliding, hanging, falling
local DROPS = {
  { "..O..", ".OsO.", "OWssO", "OssdO", ".OOO." },
  { "..O..", ".OsO.", ".OsO.", "OWssO", "OWsdO", "OssdO", ".OOO." },
  { "...O...", "..OsO..", "..OsO..", ".OWssO.", "OWsssdO", "OWsssdO", "OsssddO", ".OsddO.", "..OOO.." },
  { "..O..", ".OsO.", "..O..", ".....", "..O..", ".OsO.", "OWssO", "OWsdO", "OssdO", ".OOO." },
}
local DROP_KEY = { O = P.void, W = P.cream, s = P.safeLight, d = P.safe }

local function stamp(b, rows, x0, y0, key, mirror)
  for y, r in ipairs(rows) do
    for i = 1, #r do
      local ch = r:sub(i, i)
      if ch ~= "." then
        local x = mirror and (x0 + #r - i) or (x0 + i - 1)
        L.set(b, x, y0 + y - 1, key[ch])
      end
    end
  end
end

local function frame(f)
  local cx = CX + SHAKE[f]
  local body = L.buffer(N, N)
  local g = G.body(body, cx, BOTTOM, 1, 1)
  local gy, top = math.floor(g.gy), math.floor(g.top)

  -- face: glaring eyes under furrowed brows, gritted teeth
  local key = { O = P.void, W = P.cream }
  stamp(body, EYE, cx - 10, gy - 5, key, false)
  stamp(body, EYE, cx + 2, gy - 5, key, true)
  stamp(body, TEETH, cx - 5, gy + 4, key, false)
  G.roundCorners(body, P.void, 0.45)
  L.outline(body, P.void)

  -- sweat: the right drop runs stages 1-4, the left one half a cycle behind
  local path = {
    { dx = g.wt + 2, y = top },
    { dx = (g.wt + g.w) / 2 + 2, y = math.floor((top + gy) / 2) - 2 },
    { dx = g.w + 1, y = gy - 3 },
    { dx = g.w + 3, y = gy + 5 },
  }
  for side = -1, 1, 2 do
    local stage = (side == 1) and f or ((f + 1) % 4 + 1)
    local p, rows = path[stage], DROPS[stage]
    local half = math.floor(#rows[1] / 2)
    -- the same drop on both sides (lit from the top-left), placed pixel-symmetrically
    local x0 = (side == 1) and math.floor(cx + p.dx) - half or math.floor(cx - p.dx) - half - 1
    stamp(body, rows, x0, p.y, DROP_KEY, false)
  end

  local b = L.buffer(N, N)
  L.blit(b, G.glow(body, P.ruby, 5, GLOW[f]))
  L.blit(b, body)
  return b
end

local frames = {}
for f = 1, 4 do frames[f] = frame(f) end
L.saveStrip(frames, "verdict-sweat", 160)
