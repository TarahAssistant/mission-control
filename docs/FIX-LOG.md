# MC Fix Log

## 2026-03-19: WebSocket "Gateway Offline" Fix

### Problem
MC dashboard showed "Gateway Offline" with WebSocket errors on every page load. The WS connection would open, receive the gateway's `connect.challenge` frame, then die within 0-1ms before the client could respond.

### Root Cause
**Next.js 16 intercepts WebSocket upgrades.** The previous `server.js` created the HTTP server inside `app.prepare().then(...)`, which meant Next.js registered its own `upgrade` handler first. When a browser sent a WS upgrade to `/ws-proxy`, Next.js consumed the upgrade event and closed the socket before our custom proxy handler could run.

### Fix (commit `8892a0b`)
Rewrote `server.js` to:
1. Create the `http.Server` **before** `app.prepare()` 
2. Register our `/ws-proxy` upgrade handler **first** (so it fires before Next.js)
3. Wire Next.js request handling via `server.on('request')` after `prepare()` completes
4. Non-ws-proxy upgrades pass through to Next.js by returning early without destroying the socket

### Also Done
- **ws-relay.js** (commit `a9a76cb`) — standalone WS relay on port 18790 that injects `Origin: http://localhost:3005` for Tailscale Serve paths. Tailscale strips Origin headers on proxy pass-through; the relay restores them before forwarding to the gateway.
- **Tailscale Serve** reconfigured: `/ws-proxy → relay:18790` instead of direct to gateway:18789
- **PM2** — `ws-relay` process added alongside `mc-v2`
- **openclaw.json** — removed stale `google` plugin from `plugins.allow` and `plugins.entries` (caused `openclaw status` to fail)

### Architecture After Fix
```
Browser (localhost:3005)
  → ws://127.0.0.1:3005/ws-proxy
  → server.js upgrade handler (injects Origin)
  → gateway:18789
  
Browser (Tailscale HTTPS)
  → wss://tailscale.../ws-proxy
  → Tailscale Serve → relay:18790 (injects Origin)
  → gateway:18789
```

### How to Verify
```bash
# WS through MC proxy (localhost)
node -e "const W=require('ws');const w=new W('ws://127.0.0.1:3005/ws-proxy');w.on('open',()=>console.log('OK'));w.on('message',d=>console.log(d.toString().substring(0,100)));setTimeout(()=>{w.close();process.exit()},3000)"

# WS through relay (Tailscale path)
node -e "const W=require('ws');const w=new W('ws://127.0.0.1:18790/');w.on('open',()=>console.log('OK'));w.on('message',d=>console.log(d.toString().substring(0,100)));setTimeout(()=>{w.close();process.exit()},3000)"

# Both should print: OK + connect.challenge JSON
```

### Mistakes / Lessons
1. **PM2 loses env vars on delete/recreate.** When PM2 is started with `pm2 start npm -- start`, it inherits the current shell's env. But `pm2 resurrect` or `pm2 start server.js` after delete doesn't carry those vars. Always use `set -a; source .env.local; set +a` before `pm2 start`, or use a PM2 ecosystem file.
2. **Next.js 16 upgrade interception is silent.** No error, no log — it just eats the upgrade and closes the socket. The only clue was `durationMs=0` in gateway logs and the bare proxy test working perfectly.
3. **The `ws` npm library gives "socket hang up" when the server closes during upgrade.** This is distinct from "connection refused" (server not running) and helped narrow it to the proxy layer.

---

## 2026-03-18: Upstream Merge + Initial WS Diagnosis

See `memory/2026-03-18.md` for the full session log. Key findings that led to today's fix:
- Identified Origin header stripping by Tailscale Serve
- Identified `http-proxy` npm library also strips Origin on WS upgrades (not relevant after server.js rewrite)
- Created initial `server.js` with manual WS proxy (correct logic, wrong initialization order)
