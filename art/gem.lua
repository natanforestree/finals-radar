-- gem.png: a 12x12 ruby that marks Ruby players in lists. Hand-placed pixels: a light crown
-- over a darker pavilion, facets converging on the culet, a cream glint on the table.
-- Run from anywhere: aseprite -b --script art/gem.lua
-- Writes art/gem.aseprite and docs/art/gem.png.
local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
local P = L.P

local key = {
  O = P.void, W = P.cream, p = P.rubyPale, l = P.rubyLight, r = P.ruby,
  m = P.rubyMid, d = P.rubyDark, e = P.rubyDeep,
}

local b = L.map({
  "............",
  "...OOOOOO...",
  "..OWllllrO..",
  ".OpppllrrmO.",
  "OppppprrrmdO",
  "OrrrllrrmddO",
  ".OrrllrmddO.",
  "..OrllmddO..",
  "...OrlmdO...",
  "....OldO....",
  ".....OO.....",
  "............",
}, key)

L.saveStill(b, "gem")
