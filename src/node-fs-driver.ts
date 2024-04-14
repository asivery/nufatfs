import { Driver } from "./types";
import fs from 'fs';

export function createImageFileDriver(imageFile: string, sectorSize: number, writable = false): Driver {
    const stat = fs.statSync(imageFile);
    const handle = fs.openSync(imageFile, writable ? 'r+' : 'r');
    return {
        sectorSize,
        numSectors: Math.floor(stat.size / sectorSize),
        readSectors: async (startIndex: number, count: number) => {
            return new Promise((res, rej) => {
                const buffer = new Uint8Array(count * sectorSize);
                fs.read(handle, buffer, 0, buffer.length, startIndex * sectorSize, (err, read, buffer) => {
                    if(err) rej(err);
                    else if(buffer.length != read) throw new Error(`Failed to read required number of bytes - expected ${buffer.length}, got ${read}`);
                    else res(buffer);
                });
            })
        },
        writeSectors: writable ? async (startIndex: number, data: Uint8Array) => {
            return new Promise((res, rej) => fs.write(handle, data, 0, data.length, startIndex * sectorSize, (err, written) => {
                if(err) rej(err);
                else res();
            }));
        } : null,
    }
}
