const http = require('http')

const LISTEN_HOST = '127.0.0.1'
const LISTEN_PORT = 18790
const GATEWAY_HOST = '127.0.0.1'
const GATEWAY_PORT = 18789

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('WS Relay OK\n')
    return
  }

  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Method Not Allowed\n')
})

server.on('upgrade', (req, browserSocket, browserHead) => {
  const remoteAddr = req.socket.remoteAddress || 'unknown'

  const proxyHeaders = {
    ...req.headers,
    origin: 'http://localhost:3005',
    host: `${GATEWAY_HOST}:${GATEWAY_PORT}`,
    'x-forwarded-for': '127.0.0.1',
  }

  const proxyReq = http.request({
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
    method: req.method || 'GET',
    path: req.url,
    headers: proxyHeaders,
  })

  let browserFrames = 0
  let gatewayFrames = 0
  let closed = false

  const closeBoth = (reason, err) => {
    if (closed) return
    closed = true

    if (err) {
      console.error(`[ws-relay] error ${remoteAddr}: ${reason}`, err)
    }

    if (!browserSocket.destroyed) browserSocket.destroy()
    if (gatewaySocketRef && !gatewaySocketRef.destroyed) gatewaySocketRef.destroy()

    console.log(
      `[ws-relay] closed ${remoteAddr} browser=${browserFrames} gateway=${gatewayFrames} frames`
    )
  }

  let gatewaySocketRef = null

  proxyReq.on('upgrade', (proxyRes, gatewaySocket, gatewayHead) => {
    gatewaySocketRef = gatewaySocket

    const statusLine = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
    let headerBlock = ''

    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      headerBlock += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`
    }

    browserSocket.write(`${statusLine}${headerBlock}\r\n`)

    if (browserHead && browserHead.length > 0) {
      gatewaySocket.write(browserHead)
    }

    if (gatewayHead && gatewayHead.length > 0) {
      browserSocket.write(gatewayHead)
    }

    console.log(`[ws-relay] connected ${remoteAddr}`)

    browserSocket.on('data', () => {
      browserFrames += 1
    })

    gatewaySocket.on('data', () => {
      gatewayFrames += 1
    })

    browserSocket.on('error', (err) => closeBoth('browser socket', err))
    gatewaySocket.on('error', (err) => closeBoth('gateway socket', err))

    browserSocket.on('close', () => closeBoth('browser closed'))
    gatewaySocket.on('close', () => closeBoth('gateway closed'))

    browserSocket.pipe(gatewaySocket)
    gatewaySocket.pipe(browserSocket)
  })

  proxyReq.on('response', (upstreamRes) => {
    browserSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    browserSocket.destroy()
    upstreamRes.resume()
    console.error(`[ws-relay] error ${remoteAddr}: upstream did not upgrade`)
  })

  proxyReq.on('error', (err) => {
    closeBoth('proxy request', err)
  })

  proxyReq.end()
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`> WS Relay ready on ${LISTEN_HOST}:${LISTEN_PORT} → ${GATEWAY_HOST}:${GATEWAY_PORT}`)
})
