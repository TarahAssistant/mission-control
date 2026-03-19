const http = require('http')
const { parse } = require('url')
const next = require('next')

const port = parseInt(process.env.PORT || '3000', 10)
const GATEWAY_HOST = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1'
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10)

const app = next({ dev: false, hostname: '0.0.0.0', port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res, parse(req.url || '/', true))
  })

  // Register our WS proxy handler FIRST
  server.on('upgrade', wsProxyHandler)

  // Block Next.js from registering its own upgrade handler.
  // Next.js 16 lazily calls server.on('upgrade', ...) via setupWebSocketHandler
  // on the first request. We intercept addListener/on to prevent it.
  const origOn = server.on.bind(server)
  const origAddListener = server.addListener.bind(server)
  
  server.on = function(event, listener) {
    if (event === 'upgrade' && listener !== wsProxyHandler) {
      console.log('[server] blocked Next.js from registering upgrade handler')
      return server  // no-op
    }
    return origOn(event, listener)
  }
  server.addListener = function(event, listener) {
    if (event === 'upgrade' && listener !== wsProxyHandler) {
      console.log('[server] blocked Next.js addListener upgrade handler')
      return server
    }
    return origAddListener(event, listener)
  }

  server.listen(port, '0.0.0.0', () => {
    console.log('> MC ready on http://0.0.0.0:' + port)
    console.log('> WS proxy: /ws-proxy -> ws://' + GATEWAY_HOST + ':' + GATEWAY_PORT)
  })
})

function wsProxyHandler(req, socket, head) {
  if (!req.url || !req.url.startsWith('/ws-proxy')) {
    socket.destroy()
    return
  }

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
    if (socket.destroyed || !socket.writable) {
      proxySocket.destroy()
      return
    }

    let responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\n'
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      responseHeaders += proxyRes.rawHeaders[i] + ': ' + proxyRes.rawHeaders[i + 1] + '\r\n'
    }
    responseHeaders += '\r\n'

    socket.write(responseHeaders)
    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead)
    if (head && head.length > 0) proxySocket.write(head)

    proxySocket.pipe(socket)
    socket.pipe(proxySocket)

    let bFrames = 0, gFrames = 0
    socket.on('data', () => { bFrames++ })
    proxySocket.on('data', () => { gFrames++ })

    proxySocket.on('error', () => socket.destroy())
    socket.on('error', (err) => {
      console.error('[ws-proxy] browser err:', err.message, 'b=' + bFrames, 'g=' + gFrames)
      proxySocket.destroy()
    })
    proxySocket.on('close', () => {
      console.log('[ws-proxy] gw closed b=' + bFrames + ' g=' + gFrames)
      socket.destroy()
    })
    socket.on('close', () => {
      console.log('[ws-proxy] browser closed b=' + bFrames + ' g=' + gFrames)
      proxySocket.destroy()
    })
  })

  proxyReq.on('error', (err) => {
    console.error('[ws-proxy] proxy error:', err.message)
    socket.destroy()
  })

  proxyReq.on('response', (res) => {
    console.error('[ws-proxy] unexpected response:', res.statusCode)
    socket.destroy()
  })

  proxyReq.end()
}
