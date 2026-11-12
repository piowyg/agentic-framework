/**
 * The only way out of a session container: an HTTP proxy that tunnels `CONNECT host:443` to hosts on
 * `sandbox.network.allow` and refuses everything else. Runs as `node egress-proxy.mjs <port> <host>…` in its own
 * container, the one attached to both the session's internal network and the outside; no imports outside `node:`.
 * Each decision is one stdout line (`allow host` / `deny host:port`), kept as the session's egress log; the first
 * line, `listening`, tells the sandbox it is up.
 */
import http from 'node:http';
import net from 'node:net';

const TLS_PORT = 443;

/** `example.com` allows exactly that host; `.example.com` any host under it. */
export function isAllowed(allow: readonly string[], host: string, port: number): boolean {
  if (port !== TLS_PORT) return false;
  const name = host.toLowerCase().replace(/\.$/, '');
  return allow.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('.') ? name.endsWith(pattern) : name === pattern;
  });
}

/** `host:port` from a CONNECT target, `[v6]:port` too; undefined when it is not one. */
export function connectTarget(target: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(target);
  if (!match) return undefined;
  const port = Number(match[3]);
  return port > 0 && port < 65536 ? { host: (match[1] ?? match[2])!, port } : undefined;
}

/** Opens the upstream connection; tests point it at a local server. */
export type Dial = (host: string, port: number, onConnect: () => void) => net.Socket;

export function createEgressProxy(
  allow: readonly string[],
  log: (line: string) => void = console.log,
  dial: Dial = (host, port, onConnect) => net.connect(port, host, onConnect),
): http.Server {
  const server = http.createServer((request, response) => {
    // plain HTTP would bypass TLS to the allowed host; every harness and build tool speaks HTTPS through CONNECT
    log(`deny ${request.headers.host ?? '?'} (plain http)`);
    response.writeHead(403).end('agentic egress: only HTTPS (CONNECT) to allowed hosts\n');
  });
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const target = connectTarget(request.url ?? '');
    if (!target || !isAllowed(allow, target.host, target.port)) {
      log(`deny ${request.url ?? '?'}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    log(`allow ${target.host}`);
    const upstream = dial(target.host, target.port, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return server;
}

const [, script, port, ...allow] = process.argv;
if (script?.endsWith('egress-proxy.mjs') && port) {
  const server = createEgressProxy(allow);
  server.listen(Number(port), '0.0.0.0', () => console.log(`listening ${port}`));
}
