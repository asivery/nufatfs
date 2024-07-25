import { Driver } from "./types";

export function createChunkingDriver(underlying: Driver, maxSectors: number, sectorSize: number): Driver {
    return {
        ...underlying,
        readSectors: async (sectorIndex: number, sectorCount: number) => {
            let outputBuffers: Uint8Array[] = [];
            while(sectorCount > 0){
                let toRead = Math.min(sectorCount, maxSectors);
                outputBuffers.push(await underlying.readSectors(sectorIndex, toRead));
                sectorIndex += toRead;
                sectorCount -= toRead;
            }
            const newBuffer = new Uint8Array(outputBuffers.reduce((a, b) => a + b.length, 0));
            let bufferIndex = 0;
            for(const bfr of outputBuffers) {
                newBuffer.set(bfr, bufferIndex);
                bufferIndex += bfr.length;
            }
            return newBuffer;
        },
        writeSectors: underlying.writeSectors !== null ? async (sectorIndex: number, data: Uint8Array) => {
            let offset = 0;
            while(offset < data.length) {
                let toWrite = data.subarray(offset, offset + Math.min(data.length - offset, sectorSize * maxSectors));
                await underlying.writeSectors!(sectorIndex, toWrite);
                offset += toWrite.length;
                sectorIndex += toWrite.length / sectorSize;
            }
        } : null,
    }
}
