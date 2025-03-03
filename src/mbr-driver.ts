import type { Driver } from "./types";

export function getLEUint32(data: Uint8Array, offset: number = 0){
    return  (data[offset+0] << 0) |
            (data[offset+1] << 8) |
            (data[offset+2] << 16) |
            (data[offset+3] << 24);
}

export function getNthPartitionFromMBR(mbrSector: Uint8Array, n: number){
    return {
        firstLBA: getLEUint32(mbrSector, 0x01BE + 0x10 * n + 8),
        sectorCount: getLEUint32(mbrSector, 0x01BE + 0x10 * n + 12),
    };
}

export async function createMBRPartitionDriver(rootDriver: Driver, partition: number, mbrSector?: Uint8Array): Promise<Driver>{
    mbrSector ??= await rootDriver.readSectors(0, 1);
    const info = getNthPartitionFromMBR(mbrSector, partition);
    return {
        ...rootDriver,
        numSectors: info.sectorCount,
        readSectors: (start, read) => rootDriver.readSectors(start + info.firstLBA, read),
        writeSectors: rootDriver.writeSectors ? (start, data) => rootDriver.writeSectors!(start + info.firstLBA, data) : null,
    };
}
