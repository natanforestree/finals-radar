-- verdict-calibrating.png: CALIBRATING. An hourglass, 6 frames of 48x48: sand runs from the top
-- bulb to the bottom over four frames (the top drains with a dip, the bottom builds a mound),
-- then the glass flips clockwise in two 60-degree steps, the sand slumping level as it turns, and
-- lands upright with the full bulb on top again, so the loop is seamless.
-- Every frame is rendered by mapping pixels back into the glass's own coordinates; sand levels are
-- solved so the amount of sand stays the same. Shading is worked out in screen space, so the light
-- stays top-left while the glass turns.
-- Run from anywhere: aseprite -b --script art/verdict-calibrating.lua
-- Writes art/verdict-calibrating.aseprite (6 frames, 160 ms) and docs/art/verdict-calibrating.png.
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P
local N, CX, CY = 48, 24, 24

-- the glass: two round bulbs joined by funnels to a narrow neck
local function inGlass(x, y)
  local ay = math.abs(y)
  if ay > 15.5 then return false end
  local bx, by = x / 7.6, (ay - 9) / 6.6
  if bx * bx + by * by <= 1 then return true end
  return ay <= 9 and math.abs(x) <= 1.2 + (ay / 9) * 6.4
end
local function inCap(x, y) -- the two end caps, with clipped corners
  local ay, ax = math.abs(y), math.abs(x)
  if ay < 15.5 or ay > 19.5 or ax > 12 then return false end
  return not (ax > 11 and (ay > 18.5 or ay < 16.5))
end
local function inPost(x, y)
  local ax = math.abs(x)
  return ax >= 8.6 and ax <= 11.4 and math.abs(y) < 15.5
end
-- a shape covers a pixel when at least two of four sub-samples fall inside it, which keeps thin
-- parts solid when the glass is turned
local SUB = { { -0.25, -0.25 }, { 0.25, -0.25 }, { -0.25, 0.25 }, { 0.25, 0.25 } }

-- per frame: rotation (degrees clockwise), how much of the sand is still in the top bulb, and
-- whether a stream is falling
local FRAMES = {
  { rot = 0, top = 0.96, stream = true },
  { rot = 0, top = 0.66, stream = true },
  { rot = 0, top = 0.33, stream = true },
  { rot = 0, top = 0.0, stream = false },
  { rot = 60, top = 0.0, stream = false },
  { rot = 120, top = 0.0, stream = false },
}

-- how many glass pixels a bulb holds when upright (used as the unit for sand amounts)
local SAND_FULL = 0
for y = 0, N - 1 do
  for x = 0, N - 1 do
    local lx, ly = x + 0.5 - CX, y + 0.5 - CY
    if inGlass(lx, ly) and ly > 0 and ly < 15 then SAND_FULL = SAND_FULL + 1 end
  end
end
SAND_FULL = math.floor(SAND_FULL * 0.62)

local function frame(fr)
  local a = math.rad(fr.rot)
  local ca, sa = math.cos(a), math.sin(a)
  -- screen pixel -> glass coordinates (inverse of a clockwise turn, y down)
  local function toLocal(x, y, ox, oy)
    local dx, dy = x + 0.5 + (ox or 0) - CX, y + 0.5 + (oy or 0) - CY
    return dx * ca + dy * sa, -dx * sa + dy * ca
  end
  local function covers(fn, x, y)
    if fr.rot == 0 then return fn(toLocal(x, y)) end
    local n = 0
    for _, o in ipairs(SUB) do if fn(toLocal(x, y, o[1], o[2])) then n = n + 1 end end
    return n >= 2
  end
  local glass, cap, post, sand = {}, {}, {}, {}
  local function key(x, y) return y * N + x end
  for y = 0, N - 1 do
    for x = 0, N - 1 do
      local lx, ly = toLocal(x, y)
      if covers(inGlass, x, y) then glass[key(x, y)] = { lx, ly } end
      if covers(inCap, x, y) then cap[key(x, y)] = true end
      if covers(inPost, x, y) then post[key(x, y)] = true end
    end
  end

  -- sand: fill a bulb (the one on side sgn of the neck, in glass coordinates) from the bottom
  -- of the screen up to a level, with a surface shape, until it holds `amount` pixels
  local function fill(sgn, amount, shape)
    if amount <= 0 then return end
    local lo, hi = -30, 30
    for _ = 1, 40 do
      local mid = (lo + hi) / 2
      local n = 0
      for k, p in pairs(glass) do
        if p[2] * sgn > 0.6 then
          local sy = math.floor(k / N) + 0.5 - CY
          local sx = k % N + 0.5 - CX
          if sy > mid + shape(sx) then n = n + 1 end
        end
      end
      if n > amount then lo = mid else hi = mid end
    end
    for k, p in pairs(glass) do
      if p[2] * sgn > 0.6 then
        local sy = math.floor(k / N) + 0.5 - CY
        local sx = k % N + 0.5 - CX
        if sy > hi + shape(sx) then sand[k] = true end
      end
    end
  end
  local flat = function() return 0 end
  if fr.rot == 0 then
    local top = math.floor(SAND_FULL * fr.top + 0.5)
    -- the top bulb drains from the middle; the bottom one builds a mound under the stream
    fill(-1, top, function(x) return math.max(0, 2.2 - math.abs(x) * 0.55) end)
    fill(1, SAND_FULL - top, function(x) return -math.max(0, 3.2 - math.abs(x) * 0.5) end)
  else
    fill(1, SAND_FULL, flat) -- the full (formerly bottom) bulb, slumped level
  end

  local b = L.buffer(N, N)
  local function has(t, x, y) return x >= 0 and y >= 0 and x < N and y < N and t[key(x, y)] end

  -- glass: a pale tint inside, a rim shaded by its outward normal (from the empty pixels
  -- around it) so the light arcs stay smooth on the top-left
  for k in pairs(glass) do
    local x, y = k % N, math.floor(k / N)
    local edge = not (has(glass, x - 1, y) and has(glass, x + 1, y) and has(glass, x, y - 1) and has(glass, x, y + 1))
    if edge then
      local nx, ny = 0, 0
      for dy = -2, 2 do
        for dx = -2, 2 do
          if not has(glass, x + dx, y + dy) then nx, ny = nx + dx, ny + dy end
        end
      end
      local len = math.sqrt(nx * nx + ny * ny)
      local lit = (len > 0) and (-(nx + ny) / len * 0.7071) or 0
      b[y][x] = (lit > 0.45) and P.cream or ((lit > -0.8) and P.mute or P.haze)
    else
      b[y][x] = L.alpha(P.cream, 30)
    end
  end
  -- a reflection streak down the left of each bulb (it turns with the glass)
  for k, p in pairs(glass) do
    local x, y = k % N, math.floor(k / N)
    local lx, ly = p[1], p[2]
    local ay = math.abs(ly)
    if ay > 6 and ay < 13 and lx > -6 and lx < -4.8 and not sand[k] then
      b[y][x] = L.alpha(P.cream, 150)
    end
  end
  -- sand, shaded in screen space: light surface, darker against the glass on the lower right;
  -- the glass rim stays on top of it
  local function rim(x, y)
    return not (has(glass, x - 1, y) and has(glass, x + 1, y) and has(glass, x, y - 1) and has(glass, x, y + 1))
  end
  for k in pairs(sand) do
    local x, y = k % N, math.floor(k / N)
    if rim(x, y) then goto continue end
    local c = P.gold
    if not has(sand, x, y - 1) then c = P.goldLight
    elseif not has(sand, x + 1, y) or not has(sand, x, y + 1) or not has(sand, x + 1, y + 1) then c = P.goldMid end
    if rim(x + 1, y) or rim(x, y + 1) then c = P.goldMid end
    if not has(sand, x, y - 1) then c = P.goldLight end
    b[y][x] = c
    ::continue::
  end
  L.despeckle(b, { [P.gold] = true, [P.goldMid] = true })
  if fr.stream then
    -- a one-pixel stream from the neck to the top of the mound
    local y = CY
    while has(glass, CX - 1, y) and not sand[key(CX - 1, y)] do
      b[y][CX - 1] = P.goldLight
      y = y + 1
    end
  end

  -- posts and caps: pewter. Each edge pixel takes the outward normal of the nearest side of its
  -- part (in glass coordinates), turned to the screen, and is lit by how much that faces the
  -- top-left; so each side keeps one clean shade at any angle.
  local function capNormal(lx, ly)
    local sy = (ly < 0) and -1 or 1
    local d = { { 12 + lx, -1, 0 }, { 12 - lx, 1, 0 }, { math.abs(ly) - 15.5, 0, -sy }, { 19.5 - math.abs(ly), 0, sy } }
    table.sort(d, function(p, q) return p[1] < q[1] end)
    return d[1][2], d[1][3]
  end
  local function postNormal(lx, ly)
    local sx = (lx < 0) and -1 or 1
    if math.abs(math.abs(lx) - 11.4) < math.abs(math.abs(lx) - 8.6) then return sx, 0 end
    return -sx, 0
  end
  local function metal(t, normal, light, mid, dark)
    for k in pairs(t) do
      local x, y = k % N, math.floor(k / N)
      local c = mid
      if not (has(t, x - 1, y) and has(t, x + 1, y) and has(t, x, y - 1) and has(t, x, y + 1)) then
        local lx, ly = toLocal(x, y)
        local nx, ny = normal(lx, ly)
        local wx, wy = nx * ca - ny * sa, nx * sa + ny * ca -- glass -> screen
        local lit = -(wx + wy) * 0.7071
        c = (lit > 0.3) and light or ((lit < -0.3) and dark or mid)
      end
      b[y][x] = c
    end
  end
  metal(post, postNormal, P.mute, P.haze, P.dusk)
  metal(cap, capNormal, P.mute, P.haze, P.dusk)
  -- a cream glint on the top-left corner of each cap's lit edge (upright only; on a slant every
  -- stair step would catch one)
  for k in pairs(fr.rot == 0 and cap or {}) do
    local x, y = k % N, math.floor(k / N)
    if b[y][x] == P.mute and not has(cap, x - 1, y) and not has(cap, x, y - 1) then b[y][x] = P.cream end
  end

  L.outline(b, P.void)
  return b
end

local frames = {}
for i, fr in ipairs(FRAMES) do frames[i] = frame(fr) end
L.saveStrip(frames, "verdict-calibrating", 160)
