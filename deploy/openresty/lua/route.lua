-- route.lua — front-router logic for a multi-instance operon-broker cluster.
--
-- A node's tunnel (SSE downlink + streaming-POST uplink) is pinned to ONE broker
-- instance (the owner). The owner publishes its routes to Redis:
--     route:node:<uid>:<nid>  -> http://<owner>:<port>   (web + terminal traffic)
--     route:conn:<connId>     -> http://<owner>:<port>   (the node's own uplink)
--     drain:instance:<host:port> -> 1                    (skip for new RR traffic)
-- We read those and `set_current_peer` straight to the owner — no broker→broker hop.
--
--   * GET  /agent/down            -> no owner yet → round-robin (it becomes the owner)
--   * POST /agent/up?connId=...   -> route:conn:<connId>
--   * /u/<uid>/n/<nid>/...        -> route:node:<uid>:<nid>  (incl. terminal WS)
--   * everything else (auth/etc.) -> round-robin (state is shared in Redis/Postgres)
--
-- Failover hardening (passive health, no extra module):
--   * a backend that fails to connect is marked bad for BAD_TTL and skipped — both
--     when picking the owner (access phase) and on round-robin;
--   * `set_more_tries` lets a failed GET retry onto another live backend. POSTs are
--     NOT retried (would double-run a turn); after the owner is marked bad they just
--     get a fast agent_offline from a live instance instead of a 502.
--   * draining backends are skipped for round-robin traffic, while existing owner
--     routes still go to that owner so in-flight requests can finish.

local redis = require "resty.redis"
local balancer = require "ngx.balancer"
local resolver = require "resty.dns.resolver"

local _M = {}

local REDIS_HOST = os.getenv("REDIS_HOST") or "127.0.0.1"
local REDIS_PORT = tonumber(os.getenv("REDIS_PORT") or "6379")
-- Docker embedded DNS by default; set to kube-dns in k8s (or register pod IPs as
-- INSTANCE_ADDR via the downward API to skip DNS entirely).
local DNS_RESOLVER = os.getenv("DNS_RESOLVER") or "127.0.0.11"
local BAD_TTL = 5 -- seconds a backend stays ejected after a connect failure
local DRAIN_CACHE_TTL = 1 -- seconds; keeps drain pickup fast without Redis per RR pick

local BACKENDS = {}
do
  local raw = os.getenv("BROKER_BACKENDS") or "127.0.0.1:8080"
  for hp in raw:gmatch("[^,]+") do
    BACKENDS[#BACKENDS + 1] = hp
  end
end

-- "http://h:p" | "h:p" -> "h:p"
local function norm(addr)
  return (addr:gsub("^%w+://", ""))
end

local function split(hp)
  local host, port = hp:match("^(.-):(%d+)$")
  if host then
    return host, tonumber(port)
  end
  return hp, 8080
end

-- passive health: eject a backend for BAD_TTL after a connect failure
local function mark_bad(hp)
  ngx.shared.bad:set(hp, true, BAD_TTL)
end
local function is_bad(hp)
  return ngx.shared.bad:get(hp)
end

local function redis_get(key)
  local red = redis:new()
  red:set_timeout(200)
  local ok, err = red:connect(REDIS_HOST, REDIS_PORT)
  if not ok then
    ngx.log(ngx.ERR, "redis connect failed: ", err)
    return nil
  end
  local v = red:get(key)
  red:set_keepalive(10000, 100)
  if not v or v == ngx.null then
    return nil
  end
  return v
end

local function is_draining(hp)
  local key = norm(hp)
  local cache = ngx.shared.drain
  if cache then
    local hit = cache:get(key)
    if hit ~= nil then
      return hit == 1
    end
  end

  local draining = redis_get("drain:instance:" .. key) ~= nil
  if cache then
    cache:set(key, draining and 1 or 0, DRAIN_CACHE_TTL)
  end
  return draining
end

local function is_ipv4(s)
  return s:match("^%d+%.%d+%.%d+%.%d+$") ~= nil
end

-- balancer.set_current_peer needs an IP, so resolve hostnames (cached 10s).
local function resolve(host)
  if is_ipv4(host) then
    return host
  end
  local cache = ngx.shared.dns
  local hit = cache:get(host)
  if hit then
    return hit
  end
  local r, err = resolver:new({ nameservers = { DNS_RESOLVER }, retrans = 2, timeout = 300 })
  if not r then
    ngx.log(ngx.ERR, "dns resolver init failed: ", err)
    return nil
  end
  local ans, qerr = r:query(host, { qtype = r.TYPE_A }, {})
  if not ans or ans.errcode then
    ngx.log(ngx.ERR, "dns query failed for ", host, ": ", qerr or (ans and ans.errstr))
    return nil
  end
  for _, rec in ipairs(ans) do
    if rec.address then
      cache:set(host, rec.address, 10)
      return rec.address
    end
  end
  return nil
end

-- round-robin over live (not-bad, not-excluded) backends; degrade gracefully if all
-- are bad rather than dropping the request.
local function pick_rr(exclude)
  local d = ngx.shared.rr
  local start = d:incr("c", 1, 0) or 0
  local n = #BACKENDS
  for i = 0, n - 1 do
    local hp = BACKENDS[((start + i) % n) + 1]
    if hp ~= exclude and not is_bad(hp) and not is_draining(hp) then
      return hp
    end
  end
  for i = 0, n - 1 do
    local hp = BACKENDS[((start + i) % n) + 1]
    if hp ~= exclude and not is_bad(hp) then
      return hp
    end
  end
  for i = 0, n - 1 do
    local hp = BACKENDS[((start + i) % n) + 1]
    if hp ~= exclude then
      return hp
    end
  end
  return BACKENDS[(start % n) + 1]
end

local function owner_from_redis(key)
  return redis_get(key)
end

-- access phase: choose the initial backend ("host:port") and stash it.
function _M.route()
  local uri = ngx.var.uri
  local key
  local uid, nid = uri:match("^/u/([^/]+)/n/([^/]+)/")
  if uid then
    key = "route:node:" .. uid .. ":" .. nid
  elseif uri == "/agent/up" then
    local cid = ngx.var.arg_connId
    if cid and cid ~= "" then
      key = "route:conn:" .. cid
    end
  end

  local hp
  if key then
    local owner = owner_from_redis(key)
    if owner then
      owner = norm(owner)
      if not is_bad(owner) then -- skip a known-dead owner; fall back to round-robin
        hp = owner
      end
    end
  end
  if not hp then
    hp = pick_rr(nil)
  end
  ngx.ctx.backend = hp
end

-- balancer phase: dial the chosen backend; on a connect failure, eject it and retry
-- another live backend (GET only — POSTs aren't retried).
function _M.balance()
  if not ngx.ctx.init then
    ngx.ctx.init = true
    balancer.set_more_tries(math.min(#BACKENDS - 1, 2))
  else
    if balancer.get_last_failure() and ngx.ctx.backend then
      mark_bad(ngx.ctx.backend)
    end
    ngx.ctx.backend = pick_rr(ngx.ctx.backend)
  end

  local host, port = split(ngx.ctx.backend)
  local ip = resolve(host)
  if not ip then
    ngx.log(ngx.ERR, "could not resolve broker host: ", host)
    return -- no peer set → nginx fails the request (502)
  end
  local ok, err = balancer.set_current_peer(ip, port)
  if not ok then
    ngx.log(ngx.ERR, "set_current_peer failed: ", err)
  end
end

return _M
