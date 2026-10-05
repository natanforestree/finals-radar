-- favicon.png: a 32x32 ruby on a radar ring, built to survive being shrunk to 16x16: a thick
-- teal ring, a dark scope with one sweep wedge, and a big two-tone gem in front.
-- Run from anywhere: aseprite -b --script art/favicon.lua
-- Writes art/favicon.aseprite and docs/art/favicon.png.
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P
local N, C = 32, 16
local b = L.buffer(N, N)

-- The scope: outline, a 2px teal ring lit from the top-left, a dark screen.
for y = 0, N - 1 do
  for x = 0, N - 1 do
    local dx, dy = x + 0.5 - C, y + 0.5 - C
    local d = math.sqrt(dx * dx + dy * dy)
    local lit = (-dx - dy) / math.max(d, 0.001) -- 1 at the top-left, -1 at the bottom-right
    if d <= 15.6 then
      local c
      if d > 14.6 then c = P.void
      elseif d > 12.4 then
        c = (lit > 0.55) and P.safeLight or (lit > -0.45 and P.safe or P.safeDark)
      elseif d > 11.5 then c = P.void
      else
        c = P.night
        local a = math.deg(math.atan(dy, dx)) -- 0 = east, -90 = north
        if a > -90 and a < -30 then c = (a > -50) and P.safeDark or P.safeDeep end
        -- the sweep's leading edge at -30 degrees
        local sx, sy = math.cos(math.rad(-30)), math.sin(math.rad(-30))
        if dx * sx + dy * sy > 0 and math.abs(dx * sy - dy * sx) < 0.55 then c = P.safe end
      end
      b[y][x] = c
    end
  end
end

-- The gem, big and centred a little low so the crown fills the scope.
local g = L.buffer(N, N)
L.gem(g, {
  cx = C, gy = 14, w = 10, wt = 5.5, hc = 5, hp = 12, girdle = 1,
  crown = { P.rubyLight, P.rubyPale, P.rubyLight, P.ruby, P.rubyMid },
  band = { P.rubyLight, P.rubyMid },
  pavilion = { P.ruby, P.rubyLight, P.rubyMid, P.rubyDark },
})
L.set(g, 12, 9, P.cream); L.set(g, 13, 9, P.cream); L.set(g, 12, 10, P.cream)
L.outline(g, P.void)
L.blit(b, g, 0, 0)

L.saveStill(b, "favicon")
