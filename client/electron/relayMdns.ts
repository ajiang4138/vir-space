// relayMdns.ts
// mDNS-based relay advertisement and discovery for VIR Space
// Requires: npm install multicast-dns

import mdns from 'multicast-dns';

const SERVICE_TYPE = '_virrelay._tcp.local';
const RELAY_PORT = 8787;

// Advertise relay (call this in the relay/host process)
export function advertiseRelay(hostName: string, port: number = RELAY_PORT) {
  const mdnsInstance = mdns();
  mdnsInstance.on('query', (query) => {
    query.questions.forEach((q) => {
      if (q.type === 'PTR' && q.name === SERVICE_TYPE) {
        mdnsInstance.respond({
          answers: [
            { name: SERVICE_TYPE, type: 'PTR', data: `${hostName}.${SERVICE_TYPE}` },
            { name: `${hostName}.${SERVICE_TYPE}`, type: 'SRV', data: { port, target: hostName } },
            { name: `${hostName}.${SERVICE_TYPE}`, type: 'A', data: '127.0.0.1' }, // Replace with actual IP if needed
          ],
        });
      }
    });
  });
  return mdnsInstance;
}

// Discover relays (call this in the client process)
export function discoverRelays(timeoutMs = 1000): Promise<{ host: string, port: number }[]> {
  return new Promise((resolve) => {
    const mdnsInstance = mdns();
    const found: { host: string, port: number }[] = [];
    const seen = new Set();
    mdnsInstance.on('response', (response) => {
      let host = '';
      let port = RELAY_PORT;
      response.answers.forEach((a) => {
        if (a.type === 'SRV' && a.name.endsWith(SERVICE_TYPE)) {
          host = a.data.target;
          port = a.data.port;
        }
      });
      if (host && !seen.has(host + ':' + port)) {
        found.push({ host, port });
        seen.add(host + ':' + port);
      }
    });
    mdnsInstance.query([{ name: SERVICE_TYPE, type: 'PTR' }]);
    setTimeout(() => {
      mdnsInstance.destroy();
      resolve(found);
    }, timeoutMs);
  });
}
