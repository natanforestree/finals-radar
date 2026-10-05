-- verdict-go.png: QUEUE UP. A happy ruby bouncing on a pool of teal light, 4 frames of 48x48:
-- squash on landing (eyes squeezed shut with joy), stretch on the way up, round at the top,
-- stretch on the way down. A teal neon glow hugs the gem and three sparkles twinkle in turn.
-- Run from anywhere: aseprite -b --script art/verdict-go.lua
-- Writes art/verdict-go.aseprite (4 frames, 180 ms) and docs/art/verdict-go.png (192x48 strip).
local here = debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$")
local L = dofile(here .. "lib.lua")
local G = dofile(here .. "gemchar.lua")(L)
local P = L.P
local N, CX, GROUND = 48, 24, 41

-- squash/stretch and height per frame: land, launch, apex, fall
-- arm: degrees above horizontal for the little arms, reach: their length
local POSES = {
  { sx = 1.18, sy = 0.80, lift = 0, joy = true, arm = -58, reach = 5.5 },
  { sx = 0.88, sy = 1.14, lift = 5, arm = 30, reach = 7.5 },
  { sx = 1.00, sy = 1.00, lift = 9, arm = 45, reach = 7.5 },
  { sx = 0.93, sy = 1.08, lift = 4, arm = 12, reach = 5.5 },
}
-- sparkles: position and size per frame
local SPARKS = {
  { x = 5, y = 9, sizes = { 2, 1, 0, 1 } },
  { x = 42, y = 5, sizes = { 0, 1, 2, 1 } },
  { x = 44, y = 31, sizes = { 1, 0, 1, 2 } },
}

local function eyeOpen(b, x, y)
  -- a 4x5 shiny eye: void with a cream catchlight and a teal reflection of the glow
  for dy = 0, 4 do
    for dx = 0, 3 do
      local corner = (dy == 0 or dy == 4) and (dx == 0 or dx == 3)
      if not corner then L.set(b, x + dx, y + dy, P.void) end
    end
  end
  L.set(b, x + 1, y + 1, P.cream)
  L.set(b, x + 2, y + 3, P.safeLight)
end

local function eyeJoy(b, x, y)
  -- squeezed-shut happy eye: an upturned arc
  L.set(b, x + 1, y, P.void); L.set(b, x + 2, y, P.void)
  L.set(b, x, y + 1, P.void); L.set(b, x + 3, y + 1, P.void)
end

local function mouth(b, cx, y, wide)
  -- an open grin: flat top, round bottom, a tongue
  local hw = wide and 4 or 3
  for x = cx - hw, cx + hw - 1 do L.set(b, x, y, P.void); L.set(b, x, y + 1, P.void) end
  for x = cx - hw + 1, cx + hw - 2 do L.set(b, x, y + 2, P.void) end
  for x = cx - hw + 2, cx + hw - 3 do L.set(b, x, y + 3, P.void) end
  for x = cx - hw + 2, cx + hw - 3 do L.set(b, x, y + 2, P.rubyLight) end
end

local function frame(f)
  local pose = POSES[f]
  local body = L.buffer(N, N)
  local bodyLayer = L.buffer(N, N)
  local g = G.body(bodyLayer, CX, GROUND - pose.lift, pose.sx, pose.sy)
  G.arm(body, g, -1, pose.arm, pose.reach); G.arm(body, g, 1, pose.arm, pose.reach)
  L.blit(body, bodyLayer)

  -- face, straddling the girdle
  local ey = math.floor(g.gy - 1)
  local spread = (pose.sx > 1.1) and 1 or 0
  local lx, rx = CX - 7 - spread, CX + 3 + spread
  if pose.joy then
    eyeJoy(body, lx, ey + 2); eyeJoy(body, rx, ey + 2)
  else
    eyeOpen(body, lx, ey); eyeOpen(body, rx, ey)
  end
  -- blush
  L.paint(body, lx - 1, ey + 5, P.rubyLight); L.paint(body, lx, ey + 5, P.rubyLight)
  L.paint(body, rx + 3, ey + 5, P.rubyLight); L.paint(body, rx + 4, ey + 5, P.rubyLight)
  mouth(body, CX, ey + 6, pose.joy)

  G.roundCorners(body, P.void, 0.45)
  L.outline(body, P.void)

  -- glow and the pool of light under it
  local b = L.buffer(N, N)
  local pool = 13 - pose.lift * 0.6
  for y = GROUND - 1, GROUND + 4 do
    for x = 0, N - 1 do
      local dx, dy = (x + 0.5 - CX) / pool, (y + 0.5 - (GROUND + 1.5)) / 2.2
      local d = dx * dx + dy * dy
      if d <= 1 then
        local a = (d < 0.35) and (150 - pose.lift * 8) or (d < 0.7 and 80 - pose.lift * 4 or 36)
        b[y][x] = L.alpha(P.safe, a)
      end
    end
  end
  L.blit(b, G.glow(body, P.safe, 5, 90))
  L.blit(b, body)
  for _, s in ipairs(SPARKS) do G.twinkle(b, s.x, s.y, s.sizes[f], P.cream, P.safe) end
  return b
end

local frames = {}
for f = 1, #POSES do frames[f] = frame(f) end
L.saveStrip(frames, "verdict-go", 180)
