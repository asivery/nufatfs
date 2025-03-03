import type { Driver } from "./types";

export function createOverlayDriver(baseDriver: Driver): Driver & { deltas: { at: number, data: Uint8Array }[] } {
    function overlap(a: number, b: number, x: number, y: number) {
        const overlapStart = Math.max(a, x);
        const overlapEnd = Math.min(b, y);

        return overlapStart < overlapEnd ? [overlapStart, overlapEnd] : null;
    }

    function overlay(data: Uint8Array, start: number, deltas: { at: number; data: Uint8Array }[]) {
        for (const delta of deltas) {
            const olp = overlap(delta.at, delta.at + delta.data.length, start, start + data.length);
            if (olp) {
                const [olpStart, olpEnd] = olp;
                const deltaOffset = olpStart - delta.at;
                const dataOffset = olpStart - start;

                data.set(delta.data.subarray(deltaOffset, deltaOffset + (olpEnd - olpStart)), dataOffset);
            }
        }
    }

    const newDriver = {
        ...baseDriver,
        deltas: [] as { at: number; data: Uint8Array }[],
        async readSectors(startIndex: number, readSectors: number): Promise<Uint8Array> {
            const base = await baseDriver.readSectors(startIndex, readSectors);
            overlay(base, startIndex * baseDriver.sectorSize, newDriver.deltas);
            return base;
        },
        async writeSectors(startIndex: number, data: Uint8Array): Promise<void> {
            newDriver.deltas.push({ at: startIndex * baseDriver.sectorSize, data: data.slice() });
        },
    };

    return newDriver;
}
