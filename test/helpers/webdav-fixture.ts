import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

function encodeDavHref(value: string): string {
  return value.split('/').map(segment => {
    try { return encodeURIComponent(decodeURIComponent(segment)) }
    catch { return encodeURIComponent(segment) }
  }).join('/')
}

export class DavFixture {
  readonly files = new Map<string, Buffer>()
  readonly collections = new Set<string>(['/dav/'])
  readonly requests: Array<{ method: string; url: string }> = []
  private readonly server: Server
  baseUrl = ''

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response))
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/dav/`
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? ''
    const url = request.url ?? ''
    this.requests.push({ method, url })
    if (method === 'MKCOL') {
      this.collections.add(url.endsWith('/') ? url : `${url}/`)
      response.writeHead(201).end()
      return
    }
    if (method === 'PUT') {
      const body = await requestBytes(request)
      this.files.set(url, body)
      response.writeHead(201).end()
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      const body = this.files.get(url)
      if (!body) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' })
      if (method === 'HEAD') { response.end(); return }
      response.end(body)
      return
    }
    if (method === 'PROPFIND') {
      const body = this.multistatus(url)
      response.writeHead(207, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    response.writeHead(405).end()
  }

  private multistatus(root: string): string {
    const normalized = root.endsWith('/') ? root : `${root}/`
    const children = [...this.collections]
      .filter(candidate => candidate.startsWith(normalized) && candidate !== normalized
        && !candidate.slice(normalized.length).replace(/\/$/u, '').includes('/'))
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[normalized, ...children]
      .map(href => `<d:response><d:href>${escapeXml(encodeDavHref(href))}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`)
      .join('')}</d:multistatus>`
  }
}
