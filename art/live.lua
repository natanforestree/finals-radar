-- live.png: on stream right now. A little broadcast tower, 2 frames of 16x16: the beacon on top
-- pulses and two rings of signal travel outward (inner ring bright, then outer ring bright).
-- Generic radio-tower art, not any platform's logo. Hand-placed pixels.
-- Run from anywhere: aseprite -b --script art/live.lua
-- Writes art/live.aseprite (2 frames, 400 ms) and docs/art/live.png (32x16 strip).
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P

-- i/o are the inner and outer signal arcs; the key decides which one is lit in each frame
local ROWS = {
  "................",
  "...o........o...",
  "..o..........o..",
  ".o...i.OO.i...o.",
  ".o..i.OWLO.i..o.",
  ".o..i.OvDO.i..o.",
  ".o...iOOOOi...o.",
  "..o...OmhO...o..",
  "...o..OmhO..o...",
  ".....OmmhhO.....",
  ".....OmOOhO.....",
  ".....OmhhhO.....",
  "....OmOOOOhO....",
  "...OmO....OhO...",
  "...OO......OO...",
  "................",
}

local base = { O = P.void, W = P.cream, m = P.mute, h = P.haze, d = P.dusk }
local function key(lit)
  local k = {}
  for c, v in pairs(base) do k[c] = v end
  if lit == "inner" then
    k.i, k.o = P.liveLight, P.liveDark
    k.L, k.v, k.D = P.liveLight, P.live, P.liveDark
  else
    k.i, k.o = P.liveDark, P.live
    k.L, k.v, k.D = P.live, P.liveDark, P.liveDark
    k.W = P.liveLight
  end
  return k
end

L.saveStrip({ L.map(ROWS, key("inner")), L.map(ROWS, key("outer")) }, "live", 400)
