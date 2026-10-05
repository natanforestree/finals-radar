-- stale.png: the data is old. A warning triangle, 2 frames of 16x16 that blink: lit gold with a
-- cream glint, then dimmed to amber. Hand-placed pixels.
-- Run from anywhere: aseprite -b --script art/stale.lua
-- Writes art/stale.aseprite (2 frames, 500 ms) and docs/art/stale.png (32x16 strip).
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P

-- l = lit left edge, y = face, r = shaded right edge, b = bottom lip, g = glint, O = outline/mark
local ROWS = {
  "................",
  ".......OO.......",
  "......OgyO......",
  "......OlyO......",
  ".....OlyyrO.....",
  ".....OlOOrO.....",
  "....OlyOOyrO....",
  "....OlyOOyrO....",
  "...OlyyOOyyrO...",
  "...OlyyOOyyrO...",
  "..OlyyyyyyyyrO..",
  "..OlyyyOOyyyrO..",
  ".OlyyyyOOyyyyrO.",
  ".ObbbbbbbbbbbbO.",
  "..OOOOOOOOOOOO..",
  "................",
}

local lit = { O = P.void, g = P.cream, l = P.goldLight, y = P.gold, r = P.goldDark, b = P.goldDark }
local dim = { O = P.void, g = P.goldMid, l = P.goldMid, y = P.goldDark, r = P.goldDeep, b = P.goldDeep }

L.saveStrip({ L.map(ROWS, lit), L.map(ROWS, dim) }, "stale", 500)
