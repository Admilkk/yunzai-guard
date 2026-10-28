import net from "node:net"
import os from "node:os"

/** 把 IPv4/IPv6 文本转为 128 位整数；IPv4 映射为 ::ffff:a.b.c.d。 */
function toBig(address: string): bigint | undefined {
  const version = net.isIP(address)
  if (version === 4) {
    const parts = address.split(".").map(Number)
    return (
      (0xffffn << 32n) |
      BigInt(((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0)
    )
  }
  if (version !== 6) return undefined
  let text = address.split("%")[0]!
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (tail) {
    const v4 = toBig(tail)!
    text =
      text.slice(0, -tail.length) +
      Number((v4 >> 16n) & 0xffffn).toString(16) +
      ":" +
      Number(v4 & 0xffffn).toString(16)
  }
  const [head = "", rest] = text.split("::")
  const left = head ? head.split(":") : []
  const right = rest === undefined ? [] : rest ? rest.split(":") : []
  const fill = 8 - left.length - right.length
  if (fill < 0 || (rest === undefined && left.length !== 8)) return undefined
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : fill).fill("0"), ...right]
  return groups.reduce((total, group) => (total << 16n) | BigInt(parseInt(group || "0", 16)), 0n)
}

/** 判断地址是否落在 128 位前缀内。 */
function inPrefix(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits)
  return value >> shift === base >> shift
}

const privateRanges: Array<[string, number]> = [
  ["::ffff:127.0.0.0", 104],
  ["::ffff:10.0.0.0", 104],
  ["::ffff:172.16.0.0", 108],
  ["::ffff:192.168.0.0", 112],
  ["::ffff:169.254.0.0", 112],
  ["::ffff:100.64.0.0", 106],
  ["::1", 128],
  ["fe80::", 10],
  ["fc00::", 7],
]

/**
 * 判断来源是否属于本机或局域网：回环、私有网段、链路本地、运营商级 NAT（含 Tailscale），
 * 以及与本机任一网卡同一子网的地址。后者让家用 IPv6 公网地址的同网段设备也能访问。
 */
export function isLocalAddress(
  address: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): boolean {
  const value = toBig(address)
  if (value === undefined) return false
  for (const [base, bits] of privateRanges) if (inPrefix(value, toBig(base)!, bits)) return true
  for (const items of Object.values(interfaces))
    for (const item of items ?? []) {
      const [, bitsText] = item.cidr?.split("/") ?? []
      const base = toBig(item.address)
      const bits = Number(bitsText)
      if (base === undefined || !Number.isInteger(bits)) continue
      if (inPrefix(value, base, item.family === "IPv4" ? bits + 96 : bits)) return true
    }
  return false
}
