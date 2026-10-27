/** Stable releases >= 6.0.14 are eligible; daemon shape and identity checks still apply. */
export function isSupportedPm2Version(value) {
    if (typeof value !== "string" || value.length > 128)
        return false;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match || match[0] !== value)
        return false;
    const major = BigInt(match[1]), minor = BigInt(match[2]), patch = BigInt(match[3]);
    return major > 6n || (major === 6n && (minor > 0n || patch >= 14n));
}
//# sourceMappingURL=pm2-versions.js.map