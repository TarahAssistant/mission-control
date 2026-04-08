# MC Fix Log

## 2026-03-19: WebSocket "Gateway Offline" Fix

### Problem
MC dashboard showed "Gateway Offline" with WebSocket errors on every page load. The WS connection would open, receive the gateway's `connect.challenge` frame, then die within 0-1ms before the client could respond.

### Root Cause
**Next.js 16 lazily registers its own `upgrade` handler on the HTTP server**, which calls `socket.end()` on all WebSocket connections. Specifically:

1. `next/dist/server/next.js` line 316: `setupWebSocketHandler()` is called **lazily** — not during `app.prepare()`, but on the **first HTTP request** via `getRequestHandler()`.
2. It calls `customServer.on('upgrade', handler)` where `customServer = req.socket.server` (our HTTP server).
3. Both our handler AND Next.js's handler fire on every upgrade event.
4. Next.js's handler calls `socket.end()` asynchronously (via `processTicksAndRejections`), killing the socket before our proxy can relay the gateway's 101 response.
5. Stack trace: `NextCustomServer.upgradeHandler (router-server.js:649)` → `socket.end()`

### Diagnosis
1. Bare Node.js HTTP proxy worked perfectly (identical proxy logic)
2. Monkey-patching `socket.end()` revealed the caller: Next.js `router-server.js:649`
3. `server.listenerCount('upgrade')` was 0 after `prepare()` — confirmed lazy registration
4. After first HTTP request, Next.js added its upgrade listener to our server

### Fix (commit `7e69f1f`)
Rewrote `server.js` to:
1. Register our `/ws-proxy` upgrade handler on the server
2. **Monkey-patch `server.on()` and `server.addListener()`** to block Next.js from registering any additional `upgrade` listeners
3. Next.js's `setupWebSocketHandler()` calls `server.on('upgrade', ...)` — our patch silently drops it
4. Our WS proxy handler is the **only** upgrade listener on the server

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
2. **Next.js 16 upgrade interception is LAZY and SILENT.** Not during `prepare()` — on first request via `getRequestHandler()`. No error, no log. The only clue was `durationMs=0` in gateway logs and the bare proxy test working perfectly. Monkey-patching `socket.end()` was the breakthrough.
3. **The `ws` npm library gives "socket hang up" when the server closes during upgrade.** This is distinct from "connection refused" (server not running) and helped narrow it to the proxy layer.
4. **Registering upgrade handlers "first" isn't enough.** Both listeners fire on Node.js EventEmitter. You must actively PREVENT the unwanted listener from being registered.

---

## 2026-03-18: Upstream Merge + Initial WS Diagnosis

See `memory/2026-03-18.md` for the full session log. Key findings that led to today's fix:
- Identified Origin header stripping by Tailscale Serve
- Identified `http-proxy` npm library also strips Origin on WS upgrades (not relevant after server.js rewrite)
- Created initial `server.js` with manual WS proxy (correct logic, wrong initialization order)
