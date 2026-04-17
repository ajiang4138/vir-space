import os from "node:os";

export interface RankedIpv4Address {
  ip: string;
  interfaceName: string;
  internal: boolean;
  score: number;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }

    const num = Number.parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

function isLoopbackIpv4(ip: string): boolean {
  return ip === "127.0.0.1";
}

function isLinkLocalIpv4(ip: string): boolean {
  return ip.startsWith("169.254.");
}

function isKnownHostOnlyVirtualIpv4(ip: string): boolean {
  return ip.startsWith("192.168.56.");
}

function scoreInterfaceName(name: string): number {
  const lower = name.toLowerCase();

  if (/(vpn|wireguard|nordlynx|proton|tailscale|zerotier|hamachi|openvpn|ipsec|ppp|utun|tun|tap|wg)/.test(lower)) {
    return -30;
  }

  if (/(wi-?fi|wifi|wireless|wlan)/.test(lower)) {
    return 8;
  }

  if (/(virtual|vbox|vmware|hyper-v|vethernet|docker|podman|wsl|loopback|virbr|bridge)/.test(lower)) {
    return 20;
  }

  return 0;
}

function scoreIpAddress(ip: string, internal: boolean): number {
  if (isLoopbackIpv4(ip)) {
    return 100;
  }

  if (internal) {
    return 90;
  }

  if (isLinkLocalIpv4(ip)) {
    return 80;
  }

  if (isKnownHostOnlyVirtualIpv4(ip)) {
    return 70;
  }

  return 0;
}

export function getRankedIpv4Addresses(): RankedIpv4Address[] {
  const bestByIp = new Map<string, RankedIpv4Address>();

  for (const [interfaceName, interfaces] of Object.entries(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    for (const detail of interfaces) {
      if (detail.family !== "IPv4" || !detail.address || !isIpv4Address(detail.address)) {
        continue;
      }

      const score = scoreIpAddress(detail.address, detail.internal) + scoreInterfaceName(interfaceName);
      const candidate: RankedIpv4Address = {
        ip: detail.address,
        interfaceName,
        internal: detail.internal,
        score,
      };

      const existing = bestByIp.get(candidate.ip);
      if (!existing || candidate.score < existing.score) {
        bestByIp.set(candidate.ip, candidate);
      }
    }
  }

  const ranked = Array.from(bestByIp.values()).sort((left, right) => {
    const scoreDelta = left.score - right.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const ifaceDelta = left.interfaceName.localeCompare(right.interfaceName);
    if (ifaceDelta !== 0) {
      return ifaceDelta;
    }

    return left.ip.localeCompare(right.ip);
  });

  if (ranked.length === 0) {
    return [{ ip: "127.0.0.1", interfaceName: "loopback", internal: true, score: 100 }];
  }

  return ranked;
}

export function getPreferredNonLoopbackIpv4Addresses(): string[] {
  return getRankedIpv4Addresses()
    .map((entry) => entry.ip)
    .filter((ip) => !isLoopbackIpv4(ip) && !isLinkLocalIpv4(ip) && !isKnownHostOnlyVirtualIpv4(ip));
}

export function getPreferredIpv4AddressesIncludingLoopback(): string[] {
  const nonLoopback = getPreferredNonLoopbackIpv4Addresses();
  if (nonLoopback.length === 0) {
    return ["127.0.0.1"];
  }

  return [...nonLoopback, "127.0.0.1"];
}
