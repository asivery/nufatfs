import { BaseBootSectorInfo, Fat32Extension, FatBootInfo, FatFSDirectoryEntry, FatFSInformation } from "./types";
import { structFormatUnpack } from "./utils";

const textDecoder = new TextDecoder();

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