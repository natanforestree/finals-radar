-- The ruby gem character shared by the verdict sprites: a squashable brilliant-cut body, a neon
-- glow that hugs its silhouette, and small face parts. Load with:
--   local G = dofile(here .. "gemchar.lua")(L)
return function(L)
  local P = L.P
  local G = {}

  -- Body proportions at sx = sy = 1 (pixels).
  G.W, G.WT, G.HC, G.BAND, G.HP, G.CUT = 13, 7.5, 7, 2, 13, 2.5

  -- Draws the body with its bottom (culet) at y = bottom, centred on cx (use a whole number so the
  -- gem is pixel-symmetric), squashed by sx, sy. Returns the geometry for placing a face.
  function G.body(b, cx, bottom, sx, sy, tint)
    tint = tint or {}
    local hp, band, hc = G.HP * sy, G.BAND * sy, G.HC * sy
    local gy = bottom - hp - band
    local g = {
      cx = cx, gy = gy, w = G.W * sx, wt = G.WT * sx, hc = hc, hp = hp, girdle = band,
      cut = G.CUT * sx,
      crown = tint.crown or { P.rubyLight, P.rubyPale, P.rubyLight, P.ruby, P.rubyMid },
      band = tint.band or { P.rubyLight, P.rubyMid },
      pavilion = tint.pavilion or { P.ruby, P.ruby, P.rubyMid, P.rubyDark },
    }
    g.inside = L.gem(b, g)
    g.top = gy - hc
    g.bottom = bottom
    -- a glint on the table's front-left corner
    local tx, ty = math.floor(cx - g.wt + 1), math.floor(g.top)
    L.paint(b, tx, ty, P.cream); L.paint(b, tx + 1, ty, P.cream); L.paint(b, tx, ty + 1, P.cream)
    L.paint(b, tx + 2, ty, P.rubyPale)
    return g
  end

  -- A stubby arm from the girdle corner (draw it before the body so it sits behind):
  -- side = -1 left, 1 right; deg above horizontal; len in pixels; hand = hand radius.
  function G.arm(b, g, side, deg, len, hand)
    len, hand = len or 7.5, hand or 1.7
    local sx0, sy0 = g.cx + side * (g.w - 2.5), g.gy + 1
    local a = math.rad(deg)
    local dx, dy = side * math.cos(a), -math.sin(a)
    local m = L.buffer(b.w, b.h)
    for t = 0, len, 0.25 do
      L.eachDisc(sx0 + dx * t, sy0 + dy * t, (t > len - 1) and hand or 1.25, function(px, py)
        L.set(m, px, py, true)
      end)
    end
    -- bevel in screen space: lit where the arm meets air above or to the left, shaded below/right
    for y = 0, b.h - 1 do
      for x = 0, b.w - 1 do
        if m[y][x] then
          local c = P.ruby
          if not L.get(m, x, y - 1) or not L.get(m, x - 1, y) then c = P.rubyLight
          elseif not L.get(m, x, y + 1) or not L.get(m, x + 1, y) then c = P.rubyMid end
          b[y][x] = c
        end
      end
    end
  end

  -- Softens convex corners of a silhouette: an edge pixel with two empty orthogonal neighbours that
  -- meet at an empty diagonal steps one shade darker (toward the outline). Run before outlining.
  local DARKER = {
    [P.cream] = P.rubyPale, [P.rubyPale] = P.rubyLight, [P.rubyLight] = P.ruby,
    [P.ruby] = P.rubyMid, [P.rubyMid] = P.rubyDark, [P.rubyDark] = P.rubyDeep,
  }
  function G.roundCorners(b, toward, k)
    local hits = {}
    for y = 0, b.h - 1 do
      for x = 0, b.w - 1 do
        local c = b[y][x]
        if c then
          local e = function(dx, dy) return L.get(b, x + dx, y + dy) == nil end
          for _, d in ipairs({ { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } }) do
            if e(d[1], 0) and e(0, d[2]) and e(d[1], d[2]) and not e(-d[1], 0) and not e(0, -d[2]) then
              hits[#hits + 1] = { x, y, DARKER[c] or L.mix(c, toward, k) }; break
            end
          end
        end
      end
    end
    for _, h in ipairs(hits) do b[h[2]][h[1]] = h[3] end
  end

  -- A glow that follows the silhouette of src: translucent bands of colour c out to radius r,
  -- strongest at the edge. Returns a new buffer to blit underneath.
  function G.glow(src, c, r, peak)
    local pts = {}
    for y = 0, src.h - 1 do
      for x = 0, src.w - 1 do
        if src[y][x] then
          -- only edge pixels matter for the distance
          if not (L.get(src, x + 1, y) and L.get(src, x - 1, y) and L.get(src, x, y + 1) and L.get(src, x, y - 1)) then
            pts[#pts + 1] = { x, y }
          end
        end
      end
    end
    local out = L.buffer(src.w, src.h)
    for y = 0, src.h - 1 do
      for x = 0, src.w - 1 do
        if not src[y][x] then
          local best = r * r + 1
          for _, p in ipairs(pts) do
            local dx, dy = p[1] - x, p[2] - y
            local d2 = dx * dx + dy * dy
            if d2 < best then best = d2 end
          end
          local d = math.sqrt(best)
          if d <= r then
            -- three stepped bands read as pixel art rather than an airbrush
            local t = d / r
            local a = (t < 0.3) and peak or ((t < 0.65) and peak * 0.45 or peak * 0.18)
            out[y][x] = L.alpha(c, a)
          end
        end
      end
    end
    return out
  end

  -- A four-point twinkle: size 2 is a cross with long arms, size 1 a small plus, 0 nothing.
  function G.twinkle(b, x, y, size, core, arm)
    if size <= 0 then return end
    L.set(b, x, y, core)
    for k = 1, size do
      local c = (k == size and size > 1) and arm or (size > 1 and core or arm)
      L.set(b, x - k, y, c); L.set(b, x + k, y, c); L.set(b, x, y - k, c); L.set(b, x, y + k, c)
    end
  end

  return G
end
