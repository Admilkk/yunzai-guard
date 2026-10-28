import os from "node:os";
/**
 * 判断来源是否属于本机或局域网：回环、私有网段、链路本地、运营商级 NAT（含 Tailscale），
 * 以及与本机任一网卡同一子网的地址。后者让家用 IPv6 公网地址的同网段设备也能访问。
 */
export declare function isLocalAddress(address: string, interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): boolean;
