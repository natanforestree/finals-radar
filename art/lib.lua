-- Shared helpers for Ruby Radar's sprite scripts: the palette, pixel buffers, shape tests,
-- outlining, hand-drawn pixel maps, and saving stills or horizontal animation strips.
-- Load from a script in art/ with:
--   local L = dofile(debug.getinfo(1, "S").source:sub(2):match("^(.-)[^/]+$") .. "lib.lua")
-- Buffers hold "#rrggbb" or "#rrggbbaa" strings (nil is transparent), indexed b[y][x] from 0.
local M = {}

local here = debug.getinfo(1, "S").source:sub(2)
M.ROOT = here:match("^(.-)art/[^/]+$") or ""
function M.path(rel) return M.ROOT .. rel end

-- The site palette (see dev/ART-MANIFEST.md), plus a few in-between shades for sprites.
M.P = {
  void = "#0d0b1a", night = "#1a1630", dusk = "#2a2347", haze = "#4a4270",
  mute = "#8b85a8", cream = "#f4f0e6",
  safe = "#3ee0c2", safeDark = "#1b8f8a",
  gold = "#ffcc33", goldDark = "#c78a1a",
  ruby = "#e0284d", rubyDark = "#8f1236", rubyLight = "#ff6b8b",
  live = "#a970ff",
  -- in-betweens
  rubyMid = "#b81c42",    -- between ruby and ruby-dark
  rubyDeep = "#5c0d2b",   -- below ruby-dark, for the deepest facet and AA against the outline
  rubyPale = "#ffb3c2",   -- between ruby-light and cream, for glints
  goldLight = "#ffe68a",  -- between gold and cream
  goldMid = "#e8ab26",    -- between gold and gold-dark
  goldDeep = "#8a5a12",   -- below gold-dark
  safeDeep = "#12524f",   -- below safe-dark, for the radar trail
  safeLight = "#a6f5e6",  -- between safe and cream
  liveDark = "#6a3fb8",   -- below live
  liveLight = "#d4b8ff",  -- between live and cream
}

function M.channels(hex)
  return tonumber(hex:sub(2, 3), 16), tonumber(hex:sub(4, 5), 16), tonumber(hex:sub(6, 7), 16),
    (#hex >= 9) and tonumber(hex:sub(8, 9), 16) or 255
end

function M.hex(r, g, b, a)
  local function c(v) return math.max(0, math.min(255, math.floor(v + 0.5))) end
  if a and a < 255 then return string.format("#%02x%02x%02x%02x", c(r), c(g), c(b), c(a)) end
  return string.format("#%02x%02x%02x", c(r), c(g), c(b))
end

-- Linear mix of two colours, t = 0 gives a, t = 1 gives b.
function M.mix(a, b, t)
  local r1, g1, b1 = M.channels(a)
  local r2, g2, b2 = M.channels(b)
  return M.hex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
end

-- The same colour at a given alpha (0-255).
function M.alpha(c, a)
  local r, g, b = M.channels(c)
  return M.hex(r, g, b, a)
end

function M.rgba(hex)
  local r, g, b, a = M.channels(hex)
  return app.pixelColor.rgba(r, g, b, a)
end

function M.buffer(w, h)
  local b = { w = w, h = h }
  for y = 0, h - 1 do b[y] = {} end
  return b
end

function M.copy(src)
  local b = M.buffer(src.w, src.h)
  for y = 0, src.h - 1 do for x = 0, src.w - 1 do b[y][x] = src[y][x] end end
  return b
end

function M.set(b, x, y, c)
  x, y = math.floor(x), math.floor(y)
  if x >= 0 and y >= 0 and x < b.w and y < b.h then b[y][x] = c end
end

function M.get(b, x, y)
  x, y = math.floor(x), math.floor(y)
  if x >= 0 and y >= 0 and x < b.w and y < b.h then return b[y][x] end
  return nil
end

-- Sets a pixel only where something is already drawn (for details that must stay inside a shape).
function M.paint(b, x, y, c)
  if M.get(b, x, y) then M.set(b, x, y, c) end
end

function M.fillRect(b, x0, y0, x1, y1, c)
  for y = y0, y1 do for x = x0, x1 do M.set(b, x, y, c) end end
end

-- Calls fn(x, y, dx, dy) for every pixel whose centre lies in the disc.
function M.eachDisc(cx, cy, r, fn)
  for y = math.floor(cy - r - 1), math.ceil(cy + r + 1) do
    for x = math.floor(cx - r - 1), math.ceil(cx + r + 1) do
      local dx, dy = x + 0.5 - cx, y + 0.5 - cy
      if dx * dx + dy * dy <= r * r then fn(x, y, dx, dy) end
    end
  end
end

function M.disc(b, cx, cy, r, c)
  M.eachDisc(cx, cy, r, function(x, y) M.set(b, x, y, c) end)
end

function M.ellipse(b, cx, cy, rx, ry, c)
  for y = math.floor(cy - ry - 1), math.ceil(cy + ry + 1) do
    for x = math.floor(cx - rx - 1), math.ceil(cx + rx + 1) do
      local dx, dy = (x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry
      if dx * dx + dy * dy <= 1 then M.set(b, x, y, c) end
    end
  end
end

-- Even-odd point-in-polygon test; poly is a list of {x, y}.
function M.inPoly(poly, px, py)
  local inside = false
  local j = #poly
  for i = 1, #poly do
    local xi, yi, xj, yj = poly[i][1], poly[i][2], poly[j][1], poly[j][2]
    if (yi > py) ~= (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi then inside = not inside end
    j = i
  end
  return inside
end

function M.fillPoly(b, poly, c)
  for y = 0, b.h - 1 do
    for x = 0, b.w - 1 do
      if M.inPoly(poly, x + 0.5, y + 0.5) then b[y][x] = c end
    end
  end
end

-- Bresenham line between pixel coordinates.
function M.line(b, x0, y0, x1, y1, c)
  x0, y0, x1, y1 = math.floor(x0), math.floor(y0), math.floor(x1), math.floor(y1)
  local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
  local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
  local err = dx + dy
  while true do
    M.set(b, x0, y0, c)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
  end
end

-- Adds a 1px outline of colour c around every opaque pixel (4-neighbour by default, or 8).
-- Pixels listed in skip (a set of colours) do not get an outline.
function M.outline(b, c, eight, skip)
  local add = {}
  local dirs = eight and { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, 1 }, { 1, -1 }, { -1, -1 } }
    or { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
  for y = 0, b.h - 1 do
    for x = 0, b.w - 1 do
      if not b[y][x] then
        for _, d in ipairs(dirs) do
          local n = M.get(b, x + d[1], y + d[2])
          if n and n ~= c and select(4, M.channels(n)) == 255 and not (skip and skip[n]) then
            add[#add + 1] = { x, y }; break
          end
        end
      end
    end
  end
  for _, a in ipairs(add) do b[a[2]][a[1]] = c end
end

-- Removes lone pixels among the colours in `set` (a table colour -> true): a pixel of one of those
-- colours with no 8-neighbour of the same colour takes the commonest neighbouring colour from the
-- set. Useful after banded procedural fills.
function M.despeckle(b, set)
  local fixes = {}
  for y = 0, b.h - 1 do
    for x = 0, b.w - 1 do
      local c = b[y][x]
      if c and set[c] then
        local count, alone = {}, true
        for dy = -1, 1 do
          for dx = -1, 1 do
            if dx ~= 0 or dy ~= 0 then
              local n = M.get(b, x + dx, y + dy)
              if n == c then alone = false end
              if n and set[n] then count[n] = (count[n] or 0) + 1 end
            end
          end
        end
        if alone then
          local best, bc = nil, 0
          for n, k in pairs(count) do if k > bc or (k == bc and n < best) then best, bc = n, k end end
          if best then fixes[#fixes + 1] = { x, y, best } end
        end
      end
    end
  end
  for _, f in ipairs(fixes) do b[f[2]][f[1]] = f[3] end
end

-- Draws src onto dst at (ox, oy); translucent pixels blend over what is already there, and over
-- transparency they stay translucent.
function M.blit(dst, src, ox, oy)
  ox, oy = ox or 0, oy or 0
  for y = 0, src.h - 1 do
    for x = 0, src.w - 1 do
      local c = src[y][x]
      if c then
        local r, g, bl, a = M.channels(c)
        local under = M.get(dst, ox + x, oy + y)
        if a < 255 and under then
          local r2, g2, b2, a2 = M.channels(under)
          local k = a / 255
          local outA = a + a2 * (1 - k)
          local function ch(s, d) return (s * a + d * a2 * (1 - k)) / outA end
          c = M.hex(ch(r, r2), ch(g, g2), ch(bl, b2), outA)
        end
        if a > 0 then M.set(dst, ox + x, oy + y, c) end
      end
    end
  end
end

-- Parses a hand-drawn pixel map: rows of characters, key maps a character to a colour
-- ("." and " " are transparent). Returns a buffer.
function M.map(rows, key)
  local h, w = #rows, 0
  for _, r in ipairs(rows) do w = math.max(w, #r) end
  local b = M.buffer(w, h)
  for y, r in ipairs(rows) do
    for x = 1, #r do
      local ch = r:sub(x, x)
      if ch ~= "." and ch ~= " " then
        b[y - 1][x - 1] = assert(key[ch], "no colour for '" .. ch .. "'")
      end
    end
  end
  return b
end

-- Mirror image left to right.
function M.flip(src)
  local b = M.buffer(src.w, src.h)
  for y = 0, src.h - 1 do for x = 0, src.w - 1 do b[y][src.w - 1 - x] = src[y][x] end end
  return b
end

-- A side-on brilliant-cut gem, drawn facet by facet (no outline; add one with M.outline).
-- o = { cx, gy (girdle y), w (girdle half-width), wt (table half-width), hc (crown height),
--       hp (pavilion height), girdle (band height, default 0), cut (culet half-width, default 0),
--       crown = 5 colours left to right, pavilion = 4 colours left to right,
--       band = { left, right } girdle colours }
-- The crown is a zigzag of five triangles between table and girdle, the pavilion four
-- triangles meeting at the culet. Returns a function inside(x, y) for the silhouette.
function M.gem(b, o)
  local cx, gy, w, wt, hc, hp = o.cx, o.gy, o.w, o.wt, o.hc, o.hp
  local band, cut = o.girdle or 0, o.cut or 0
  local y0, gb, yc = gy - hc, gy + band, gy + band + hp
  local crown = {
    { { cx - w, gy }, { cx - wt, y0 }, { cx - w / 2, gy } },
    { { cx - wt, y0 }, { cx, y0 }, { cx - w / 2, gy } },
    { { cx, y0 }, { cx + w / 2, gy }, { cx - w / 2, gy } },
    { { cx, y0 }, { cx + wt, y0 }, { cx + w / 2, gy } },
    { { cx + wt, y0 }, { cx + w, gy }, { cx + w / 2, gy } },
  }
  local pav = {
    { { cx - w, gb }, { cx - w / 2, gb }, { cx - cut, yc } },
    { { cx - w / 2, gb }, { cx, gb }, { cx, yc }, { cx - cut, yc } },
    { { cx, gb }, { cx + w / 2, gb }, { cx + cut, yc }, { cx, yc } },
    { { cx + w / 2, gb }, { cx + w, gb }, { cx + cut, yc } },
  }
  local sil = { { cx - wt, y0 }, { cx + wt, y0 }, { cx + w, gy }, { cx + w, gb }, { cx + cut, yc },
    { cx - cut, yc }, { cx - w, gb }, { cx - w, gy } }
  local function inside(x, y) return M.inPoly(sil, x + 0.5, y + 0.5) end
  for y = math.floor(y0) - 1, math.ceil(yc) + 1 do
    for x = math.floor(cx - w) - 1, math.ceil(cx + w) + 1 do
      local px, py = x + 0.5, y + 0.5
      if M.inPoly(sil, px, py) then
        local c
        if py < gy then
          for i, t in ipairs(crown) do if M.inPoly(t, px, py) then c = o.crown[i]; break end end
          c = c or (px < cx and o.crown[1] or o.crown[5])
        elseif py < gb then
          c = (px < cx) and o.band[1] or o.band[2]
        else
          for i, t in ipairs(pav) do if M.inPoly(t, px, py) then c = o.pavilion[i]; break end end
          c = c or (px < cx and o.pavilion[2] or o.pavilion[3])
        end
        M.set(b, x, y, c)
      end
    end
  end
  return inside
end

local function toImage(b)
  local img = Image(b.w, b.h, ColorMode.RGB)
  img:clear(app.pixelColor.rgba(0, 0, 0, 0))
  for y = 0, b.h - 1 do
    for x = 0, b.w - 1 do
      local c = b[y][x]
      if c then img:drawPixel(x, y, M.rgba(c)) end
    end
  end
  return img
end

local function ensureDir(abs) app.fs.makeAllDirectories(app.fs.filePath(abs)) end

-- Saves one buffer as art/<name>.aseprite and docs/art/<name>.png.
function M.saveStill(b, name)
  local spr = Sprite(b.w, b.h, ColorMode.RGB)
  spr.cels[1].image = toImage(b)
  local ase, png = M.path("art/" .. name .. ".aseprite"), M.path("docs/art/" .. name .. ".png")
  ensureDir(ase); ensureDir(png)
  spr:saveAs(ase)
  spr:saveCopyAs(png)
  spr:close()
  print(string.format("wrote art/%s.aseprite and docs/art/%s.png (%dx%d)", name, name, b.w, b.h))
end

-- Saves a list of equal-sized frame buffers: an animated art/<name>.aseprite (one frame each,
-- ms per frame, tagged "loop") and a horizontal strip docs/art/<name>.png, frame 0 on the left.
function M.saveStrip(frames, name, ms)
  local fw, fh, n = frames[1].w, frames[1].h, #frames
  local spr = Sprite(fw, fh, ColorMode.RGB)
  for i = 2, n do spr:newEmptyFrame() end
  for i = 1, n do
    spr:newCel(spr.layers[1], spr.frames[i], toImage(frames[i]), Point(0, 0))
    spr.frames[i].duration = ms / 1000
  end
  local tag = spr:newTag(1, n)
  tag.name = "loop"
  local ase = M.path("art/" .. name .. ".aseprite")
  ensureDir(ase)
  spr:saveAs(ase)
  spr:close()

  local strip = M.buffer(fw * n, fh)
  for i = 1, n do
    for y = 0, fh - 1 do for x = 0, fw - 1 do strip[y][(i - 1) * fw + x] = frames[i][y][x] end end
  end
  local s2 = Sprite(fw * n, fh, ColorMode.RGB)
  s2.cels[1].image = toImage(strip)
  local png = M.path("docs/art/" .. name .. ".png")
  ensureDir(png)
  s2:saveCopyAs(png)
  s2:close()
  print(string.format("wrote art/%s.aseprite and docs/art/%s.png (%d frames of %dx%d = %dx%d)",
    name, name, n, fw, fh, fw * n, fh))
end

return M
