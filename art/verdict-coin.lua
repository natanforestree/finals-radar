-- verdict-coin.png: COIN FLIP. A gold coin spinning about its vertical axis, 8 frames of 48x48,
-- 45 degrees a frame: face, three-quarter, edge-on, three-quarter back, back, and round again.
-- Each pixel is mapped back onto the coin, so faces foreshorten properly and the reeded edge
-- shows on the side turned away from the face. Heads carries an embossed gem, tails a star.
-- The faces brighten as they turn toward the light (top-left) and dim as they turn away.
-- Run from anywhere: aseprite -b --script art/verdict-coin.lua
-- Writes art/verdict-coin.aseprite (8 frames, 90 ms) and docs/art/verdict-coin.png (384x48).
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P
local N, CX, CY = 48, 24, 24
local R, T = 16, 6 -- radius and thickness

local GEM = { { -4.5, -6.5 }, { 4.5, -6.5 }, { 8.5, -2 }, { 0, 9 }, { -8.5, -2 } }
local STAR = {}
for i = 0, 9 do
  local a = math.rad(-90 + i * 36)
  local r = (i % 2 == 0) and 9.5 or 4
  STAR[#STAR + 1] = { r * math.cos(a), r * math.sin(a) + 0.5 }
end

-- ramps per lighting: what the field, highlight, shadow and deep shadow use
local LIGHT = {
  bright = { field = P.gold, hi = P.cream, lit = P.goldLight, sh = P.goldMid, deep = P.goldDark },
  normal = { field = P.gold, hi = P.cream, lit = P.goldLight, sh = P.goldDark, deep = P.goldDeep },
  dim = { field = P.goldMid, hi = P.gold, lit = P.gold, sh = P.goldDark, deep = P.goldDeep },
}

local function frame(f)
  local th = math.rad(f * 45)
  local c, s = math.cos(th), math.sin(th)
  if math.abs(c) < 1e-6 then c = 0 end
  local ac = math.abs(c)
  local face = (c > 0) and "front" or ((c < 0) and "back" or nil)
  -- the visible face's centre shifts toward the side it is turning to; the edge shows behind it
  local ox = (c >= 0 and 1 or -1) * (T / 2) * s
  -- turning to face left (toward the light) is bright, turning right is dim
  local facing = (c >= 0) and -s or s
  local tone = (facing > 0.3) and LIGHT.bright or ((facing < -0.3) and LIGHT.dim or LIGHT.normal)
  local emblem = (face == "front") and GEM or STAR

  local b = L.buffer(N, N)
  local inFace = {}
  local function faceUV(px, py)
    if not face or ac < 1e-6 then return nil end
    local u = (px + 0.5 - CX - ox) / ac
    local v = py + 0.5 - CY
    if u * u + v * v <= R * R then return u, v end
  end
  local function inEmblem(px, py)
    local u, v = faceUV(px, py)
    return u and L.inPoly(emblem, u, v)
  end
  -- the raised rim, and the groove just inside it found in screen space so it stays an unbroken
  -- 1px line however far the face is turned
  local function inRim(px, py)
    local u, v = faceUV(px, py)
    return u and (u * u + v * v > (R - 2) ^ 2)
  end
  local function inGroove(px, py)
    return faceUV(px, py) and not inRim(px, py)
      and (inRim(px + 1, py) or inRim(px - 1, py) or inRim(px, py + 1) or inRim(px, py - 1))
  end

  for py = 0, N - 1 do
    for px = 0, N - 1 do
      local x, y = px + 0.5 - CX, py + 0.5 - CY
      if math.abs(y) <= R then
        local half = R * math.sqrt(1 - (y / R) ^ 2) * ac
        local reach = (T / 2) * math.abs(s)
        local u, v = faceUV(px, py)
        if u then
          -- the face: raised rim lit top-left, a groove inside it, the field, the emblem
          local r = math.sqrt(u * u + v * v)
          local lit = (-u - v) / math.max(r, 0.001) * 0.7071 -- +1 at top-left
          local col
          if inRim(px, py) then
            col = (lit > 0.35) and tone.lit or ((lit < -0.35) and tone.sh or tone.field)
            if r > R - 1 and lit > 0.6 then col = tone.hi end
          elseif inGroove(px, py) then
            -- the groove: shadowed top-left, lit bottom-right, fading out where the two meet
            col = (lit > 0.05) and tone.sh or ((lit < -0.35) and tone.lit or tone.field)
          else
            col = tone.field
          end
          if inEmblem(px, py) then
            -- embossed: lit edges where the emblem meets the field above or to the left
            local upOut = not inEmblem(px, py - 1)
            local leftOut = not inEmblem(px - 1, py)
            local downOut = not inEmblem(px, py + 1)
            local rightOut = not inEmblem(px + 1, py)
            col = tone.lit
            if upOut or leftOut then col = tone.hi end
            if (downOut or rightOut) and not (upOut or leftOut) then col = tone.sh end
            if face == "front" and math.abs(v + 1.5) < 0.1 and not (upOut or leftOut or downOut or rightOut) then
              col = tone.field -- the gem's girdle line
            end
          elseif not inRim(px, py) and not inGroove(px, py) then
            -- a soft shadow below and right of the emblem
            if inEmblem(px - 1, py - 1) then col = tone.sh end
          end
          b[py][px] = col
          inFace[py * N + px] = true
        elseif math.abs(x) <= half + reach and (reach > 0 or half > 0) then
          -- the reeded edge: shaded across its curve (top lit, bottom dark), ridged every other row
          local k = (y + R) / (2 * R) -- 0 at the top, 1 at the bottom
          local side = (ox > 0) and "left" or ((ox < 0) and "right" or "on")
          local base, ridge
          if side == "left" then -- faces the light
            base, ridge = (k < 0.4) and P.goldLight or P.gold, (k < 0.5) and P.gold or P.goldMid
          elseif side == "right" then
            base, ridge = (k < 0.4) and P.goldMid or P.goldDark, (k < 0.6) and P.goldDark or P.goldDeep
          else
            base, ridge = (k < 0.33) and P.gold or ((k < 0.7) and P.goldMid or P.goldDark),
              (k < 0.33) and P.goldMid or ((k < 0.7) and P.goldDark or P.goldDeep)
          end
          b[py][px] = (py % 2 == 0) and base or ridge
        end
      end
    end
  end
  L.outline(b, P.void)

  -- a glint flashes on the frames where a face swings toward the light
  if face and tone == LIGHT.bright then
    local gx, gy = math.floor(CX + ox - R * ac * 0.62), CY - 10
    L.set(b, gx, gy, P.cream)
    for _, d in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do L.set(b, gx + d[1], gy + d[2], P.goldLight) end
    L.set(b, gx, gy - 2, P.goldLight); L.set(b, gx, gy + 2, P.goldLight)
    L.set(b, gx - 2, gy, P.goldLight); L.set(b, gx + 2, gy, P.goldLight)
  end
  return b
end

local frames = {}
for f = 0, 7 do frames[#frames + 1] = frame(f) end
L.saveStrip(frames, "verdict-coin", 90)
