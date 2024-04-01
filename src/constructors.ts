import { BaseBootSectorInfo, Fat32Extension, FatBootInfo, FatFSDirectoryEntry, FatFSDirectoryEntryAttributes, FatFSInformation } from "./types";
import { nameNormalTo83, structFormatUnpack } from "./utils";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function createBootSectorInfo(input: Uint8Array, offset?: number): BaseBootSectorInfo {
    const data = structFormatUnpack("<3x8sHBHBHHBHHHII", input, offset) as any[];

    return {
        oemInfo: data[0],
        bytesPerLogicalSector: data[1],
        logicalSectorsPerCluster: data[2],
        reservedLogicalSectors: data[3],
        fatCount: data[4],
        deprecatedMaxRootDirEntries: data[5],
        deprecatedTotalLogicalSectors: data[6],
        mediaDescriptor: data[7],
        deprecatedLogicalSectorsPerFat: data[8],
        physicalSectorsPerTrack: data[9],
        numOfHeads: data[10],
        preceedingHiddenSectors: data[11],
        totalLogicalSectors: data[12],
    };
}

export function createFat32ExtendedInfo(input: Uint8Array, offset?: number): Fat32Extension{
    const data = structFormatUnpack("<IHHIHH12x", input, offset) as any[];

    return {
        logicalSectorsPerFat: data[0],
        mirroringFlags: data[1],
        version: data[2],
        rootDirCluster: data[3],
        fsInformationSectorNum: data[4],
        backupSectorNum: data[5],
    }
}

export function createFatBootInfo(input: Uint8Array, offset?: number) : FatBootInfo{
    const data = structFormatUnpack("<BxBI11s8s", input, offset) as any[];

    return {
        physicalDriveNumber: data[0],
        extendedBootSignature: data[1],
        volumeId: data[2],
        label: data[3],
        fsType: data[4]
    }
}

export function createFatFsInformation(input: Uint8Array, offset?: number): FatFSInformation {
    const data = structFormatUnpack("<4s480x4sII12x4s", input, offset) as any[];

    return {
        signature1: data[0],
        signature2: data[1],
        lastKnownFreeDataClusters: data[2],
        lastKnownAllocatedDataCluster: data[3],
        signature3: data[4],
    };
}

export function createFatFSDirectoryEntry(input: Uint8Array, offset?: number): FatFSDirectoryEntry {
    const data = structFormatUnpack("<11sBB5s2sH4sHI", input, offset) as any[];
    return {
        filename: data[0],
        attribs: data[1],
        reserved: data[2],
        creationDate: data[3],
        accessedDate: data[4],
        firstClusterAddressHigh: data[5],
        writtenDate: data[6],
        firstClusterAddressLow: data[7],
        fileSize: data[8],

        _filenameStr: textDecoder.decode(data[0]),
        _lfns: 0,
    };
}

export function newFatFSDirectoryEntry(name83: string, attribs: FatFSDirectoryEntryAttributes, rootCluster: number, fileSize: number): FatFSDirectoryEntry {
    return {
        filename: textEncoder.encode(name83),
        attribs,
        reserved: 0,
        creationDate: new Uint8Array(5).fill(0),
        accessedDate: new Uint8Array(2).fill(0),
        firstClusterAddressHigh: (rootCluster & 0xFFFF0000) >> 16,
        writtenDate: new Uint8Array(4).fill(0),
        firstClusterAddressLow: rootCluster & 0xFFFF,
        fileSize,

        _filenameStr: name83,
        _lfns: 0,
    };
}

export function serializeFatFSDirectoryEntry(input: FatFSDirectoryEntry): Uint8Array {
    const data = new Uint8Array(32);
    const dataView = new DataView(data.buffer);
    data.set(textEncoder.encode(input._filenameStr), 0);
    data[11] = input.attribs;
    data[12] = input.reserved;
    data.set(input.creationDate, 13);
    data.set(input.accessedDate, 18);
    dataView.setUint16(20, input.firstClusterAddressHigh, true);
    data.set(input.writtenDate, 22);
    dataView.setUint16(26, input.firstClusterAddressLow, true);
    dataView.setUint32(28, input.fileSize, true);
    // 28 + 4 = 32
    return data;
}
