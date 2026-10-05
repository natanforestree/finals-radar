-- radar.png: the logo, a round radar scope, 8 frames of 32x32. The sweep line turns 45 degrees a
-- frame with a fading phosphor trail behind it; a ruby blip flares as the sweep crosses it, then
-- cools back to a dim ember.
-- Run from anywhere: aseprite -b --script art/radar.lua
-- Writes art/radar.aseprite (8 frames, 110 ms) and docs/art/radar.png (256x32 strip).
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P
local N, FRAMES = 32, 8
-- Centred on a pixel centre so the sweep line is a clean 1px line at every 45-degree step.
local CX, CY = 15.5, 15.5
local R_OUT, R_BEZEL, R_SCREEN = 15.5, 14.5, 12.5
-- the phosphor trail, brightest right behind the line
local TEAL_MID = L.mix(P.safeDark, P.safeDeep, 0.5)  -- the two in-betweens this sprite adds
local TEAL_FAINT = L.mix(P.safeDeep, P.night, 0.55)
local TRAIL = {
  { 18, P.safeDark },
  { 40, TEAL_MID },
  { 66, P.safeDeep },
  { 100, TEAL_FAINT },
}
local gridOff, gridOn = P.dusk, TEAL_MID
-- glass glare lifts whatever is under it one step up its own ramp
local GLARE = {
  [P.night] = P.dusk, [P.dusk] = P.haze, [TEAL_FAINT] = P.safeDeep, [P.safeDeep] = TEAL_MID,
  [TEAL_MID] = P.safeDark, [P.safeDark] = P.safe,
}

-- The blip sits at radius 8, a little before the frame-1 sweep angle.
local BLIP_A = -66
local BX = math.floor(CX + 8 * math.cos(math.rad(BLIP_A)))
local BY = math.floor(CY + 8 * math.sin(math.rad(BLIP_A)))

-- the glass glare: a 1px arc just inside the screen's edge ring, on the top-left
local function inScreen(x, y)
  local dx, dy = x + 0.5 - CX, y + 0.5 - CY
  return dx * dx + dy * dy <= R_SCREEN * R_SCREEN
end
local function onEdge(x, y)
  return inScreen(x, y) and not (inScreen(x + 1, y) and inScreen(x - 1, y) and inScreen(x, y + 1) and inScreen(x, y - 1))
end
local function onGlare(x, y)
  if not inScreen(x, y) or onEdge(x, y) then return false end
  if not (onEdge(x + 1, y) or onEdge(x - 1, y) or onEdge(x, y + 1) or onEdge(x, y - 1)) then return false end
  local dx, dy = x + 0.5 - CX, y + 0.5 - CY
  return (-dx - dy) / math.sqrt(dx * dx + dy * dy) / math.sqrt(2) > 0.72
end

local function angleOf(dx, dy) return math.deg(math.atan(dy, dx)) end
-- How far angle a trails behind the sweep angle s, going clockwise, in [0, 360).
local function behind(s, a) return (s - a) % 360 end

local function frame(f)
  local b = L.buffer(N, N)
  local sweep = -90 + 45 * f -- screen degrees: -90 is north, increasing is clockwise
  local sx, sy = math.cos(math.rad(sweep)), math.sin(math.rad(sweep))
  for y = 0, N - 1 do
    for x = 0, N - 1 do
      local dx, dy = x + 0.5 - CX, y + 0.5 - CY
      local d = math.sqrt(dx * dx + dy * dy)
      if d <= R_OUT then
        local c
        local lit = (-dx - dy) / math.max(d, 0.001) / math.sqrt(2) -- +1 top-left, -1 bottom-right
        if d > R_BEZEL then
          c = P.void
        elseif d > R_SCREEN + 1 then -- outer bevel, lit from the top-left
          c = lit > 0.6 and P.cream or (lit > 0.1 and P.mute or (lit > -0.6 and P.haze or P.dusk))
        elseif d > R_SCREEN then -- inner bevel faces the other way
          c = lit < -0.5 and P.mute or (lit < 0.3 and P.haze or P.dusk)
        else
          -- the screen: grid first, then the trail tints it
          local a = angleOf(dx, dy)
          local t = behind(sweep, a)
          local onGrid = (math.abs(dx) < 0.1 or math.abs(dy) < 0.1) or math.abs(d - 7) < 0.5
          if d > R_SCREEN - 1 then onGrid = false end
          c = P.night
          for _, band in ipairs(TRAIL) do if t < band[1] then c = band[2]; break end end
          local inTrail = t < TRAIL[#TRAIL][1]
          if onGrid then c = inTrail and gridOn or gridOff end
          -- glare on the glass: a pale arc on the top-left, over whatever is under it
          if onGlare(x, y) then c = GLARE[c] or c end
          -- the sweep line itself: along the ray, ahead of the centre
          local along = dx * sx + dy * sy
          local across = math.abs(dx * sy - dy * sx)
          if along > 0 and across < 0.5 then c = (d < 6) and P.safe or P.safeLight end
        end
        b[y][x] = c
      end
    end
  end
  -- tidy lone pixels where the trail bands meet at a slant
  local bands = { [P.night] = true }
  for _, band in ipairs(TRAIL) do bands[band[2]] = true end
  L.despeckle(b, bands)
  b[15][15] = P.cream -- hub

  -- the blip: flares the frame the sweep crosses it, then cools over four frames
  local since = behind(sweep, BLIP_A) / 45 -- 0..8 frames since the line passed
  local age = math.floor(since)
  local function px(ox, oy, c) L.set(b, BX + ox, BY + oy, c) end
  if age == 0 then
    for _, o in ipairs({ { -2, 0 }, { 2, 0 }, { 0, -2 }, { 0, 2 } }) do px(o[1], o[2], P.ruby) end
    for _, o in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do px(o[1], o[2], P.rubyLight) end
    for _, o in ipairs({ { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } }) do px(o[1], o[2], P.rubyMid) end
    px(0, 0, P.cream)
  elseif age == 1 then
    for _, o in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do px(o[1], o[2], P.ruby) end
    px(0, 0, P.rubyPale)
  elseif age == 2 then
    for _, o in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do px(o[1], o[2], P.rubyDark) end
    px(0, 0, P.rubyLight)
  elseif age <= 4 then
    px(0, 0, P.ruby)
  else
    px(0, 0, P.rubyMid)
  end
  return b
end

local frames = {}
for f = 0, FRAMES - 1 do frames[#frames + 1] = frame(f) end
L.saveStrip(frames, "radar", 110)
