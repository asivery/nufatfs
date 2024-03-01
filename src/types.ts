export interface Driver {
    sectorSize: number;
    numSectors: number;
    readSectors: (startIndex: number, readSectors: number) => Promise<Uint8Array>;
    writeSectors: null | ((startIndex: number, data: Uint8Array) => Promise<void>);
};

export interface BaseBootSectorInfo {
    oemInfo: Uint8Array;
    bytesPerLogicalSector: number;
    logicalSectorsPerCluster: number;
    reservedLogicalSectors: number;
    fatCount: number;
    deprecatedMaxRootDirEntries: number;
    deprecatedTotalLogicalSectors: number;
    mediaDescriptor: number;
    deprecatedLogicalSectorsPerFat: number;
    physicalSectorsPerTrack: number;
    numOfHeads: number;
    preceedingHiddenSectors: number;
    totalLogicalSectors: number;
};

export interface Fat32Extension{
    logicalSectorsPerFat: number;
    mirroringFlags: number;
    version: number;
    rootDirCluster: number;
    fsInformationSectorNum: number;
    backupSectorNum: number;
}

export interface FatBootInfo {
    physicalDriveNumber: number;
    extendedBootSignature: number;
    volumeId: number;
    label: Uint8Array;
    fsType: Uint8Array;
}

export interface FatFSInformation {
    signature1: Uint8Array;
    signature2: Uint8Array;
    lastKnownFreeDataClusters: number;
    lastKnownAllocatedDataCluster: number;
    signature3: Uint8Array;
};

export enum FatFSDirectoryEntryAttributes {
    None = 0,
    ReadOnly = 0x01,
    Hidden = 0x02,
    System = 0x04,
    VolumeLabel = 0x08,
    Directory = 0x10,
    Archive = 0x20,

    EqLFN = 0x0F,
}

export interface FatFSDirectoryEntry {
    filename: Uint8Array;
    _filenameStr: string;
    attribs: FatFSDirectoryEntryAttributes;
    reserved: number;
    creationDate: Uint8Array;
    accessedDate: Uint8Array;
    firstClusterAddressHigh: number;
    writtenDate: Uint8Array;
    firstClusterAddressLow: number;
    fileSize: number;
    _lfns: number;
};

