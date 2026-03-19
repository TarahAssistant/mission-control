const http = require('http')
const { parse } = require('url')
const next = require('next')

const port = parseInt(process.env.PORT || '3000', 10)

const GATEWAY_HOST = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1'
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10)

// Create server FIRST, before Next.js can hook into it
const server = http.createServer()

// Register our WS upgrade handler BEFORE Next.js
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws-proxy')) {
    // Let Next.js (or anything else) handle non-ws-proxy upgrades
    // by NOT destroying the socket — just return and let other listeners fire
    return
  }

  // Prevent any other upgrade listeners from firing for /ws-proxy
  req._wsProxyHandled = true

  const targetPath = req.url.replace('/ws-proxy', '') || '/'
  const headers = { ...req.headers }
  headers['host'] = GATEWAY_HOST + ':' + GATEWAY_PORT
  headers['x-forwarded-host'] = req.headers.host || 'localhost:' + port
  headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1'
  headers['origin'] = 'http://localhost:' + port
  
  const proxyReq = http.request({
    hostname: GATEWAY_HOST,
    port: GATEWAY_PORT,
    path: targetPath,
    method: 'GET',
    headers,
  })

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // Send 101 back to browser
    let responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\n'
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      responseHeaders += proxyRes.rawHeaders[i] + ': ' + proxyRes.rawHeaders[i + 1] + '\r\n'
    }
    responseHeaders += '\r\n'
    socket.write(responseHeaders)

    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead)
    if (head && head.length > 0) proxySocket.write(head)

    // Bi-directional pipe
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)

    let browserFrames = 0
    let gatewayFrames = 0
    socket.on('data', () => { browserFrames++ })
    proxySocket.on('data', () => { gatewayFrames++ })

    proxySocket.on('error', () => socket.destroy())
    socket.on('error', (err) => {
      console.error('[ws-proxy] browser socket error: ' + err.message + ', browser sent ' + browserFrames + ' frames, gateway sent ' + gatewayFrames + ' frames')
      proxySocket.destroy()
    })
    proxySocket.on('close', () => {
      console.log('[ws-proxy] gateway closed. browser=' + browserFrames + ' gateway=' + gatewayFrames + ' frames')
      socket.destroy()
    })
    socket.on('close', () => {
      console.log('[ws-proxy] browser closed. browser=' + browserFrames + ' gateway=' + gatewayFrames + ' frames')
      proxySocket.destroy()
    })
  })

  proxyReq.on('error', (err) => {
    console.error('[ws-proxy] error:', err.message)
    socket.destroy()
  })

  proxyReq.on('response', (res) => {
    console.error('[ws-proxy] unexpected response:', res.statusCode)
    socket.destroy()
  })

  proxyReq.end()
})

// Now initialize Next.js and wire it into our existing server
const app = next({ dev: false, hostname: '0.0.0.0', port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // Wire Next.js request handling into our server
  server.on('request', (req, res) => {
    handle(req, res, parse(req.url || '/', true))
  })

  server.listen(port, '0.0.0.0', () => {
    console.log('> MC ready on http://0.0.0.0:' + port)
    console.log('> WS proxy: /ws-proxy → ws://' + GATEWAY_HOST + ':' + GATEWAY_PORT)
  })
})
