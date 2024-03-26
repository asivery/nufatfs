import { Chain, ChainLink } from "./chained-structures";
import { ClusterAllocator } from "./cluster-allocator";
import { ClusterChainLink } from "./cluster-chain";
import { createBootSectorInfo, createFat32ExtendedInfo, createFatBootInfo, createFatFSDirectoryEntry, createFatFsInformation, serializeFatFSDirectoryEntry } from "./constructors";
import { BaseBootSectorInfo, Driver, Fat32Extension, FatBootInfo, FatFSDirectoryEntry, FatFSDirectoryEntryAttributes, FatFSInformation } from "./types";
import { arraysEq, name83toNormal, namesEqual, structFormatUnpack } from "./utils";

export class FatError extends Error {}

const textEncoder = new TextEncoder();

// The idea of this filesystem implementation is serializing the whole
// file allocation table, along with the directory entries in memory upon initial reading.
// The cached entries have an 'altered' flag. If the flag is set, upon cache flushing these
// entries will be written to disk, and the flags will be cleared.
// Writing data to files / disk is never cached. Only FS structures are. (At least by the core driver)
// ( External drivers might provide caching of their own )

export type CachedFatDirectoryEntry = CachedDirectory | FatFSDirectoryEntry;

const forbiddenAttribsForFile =
    FatFSDirectoryEntryAttributes.Directory |
    FatFSDirectoryEntryAttributes.VolumeLabel;


export class CachedDirectory {
    public rawDirectoryEntries?: CachedFatDirectoryEntry[];
    constructor(private fat: LowLevelFatFilesystem, public initialCluster: number, public underlying: FatFSDirectoryEntry | null){}
    public async getEntries(): Promise<CachedFatDirectoryEntry[]>{
        if(!this.rawDirectoryEntries){
            // Load it all first
            const initialCluster = this.underlying!.firstClusterAddressLow | (this.underlying!.firstClusterAddressHigh << 16);
            const rawEntries = await this.fat.readAndConsumeAllDirectoryEntries(initialCluster);
            this.rawDirectoryEntries = rawEntries.map((e: FatFSDirectoryEntry) => {
                if(e.attribs & FatFSDirectoryEntryAttributes.Directory){
                    return new CachedDirectory(this.fat, initialCluster, e);
                }
                return e;
            });
        }
        return this.rawDirectoryEntries;
    }

    public async findEntry(name: string, typeRequired?: 'directory' | 'file'){
        const entries = await this.getEntries();
        return entries.find(e => {
            if(e instanceof CachedDirectory){
                if(typeRequired !== 'file'){
                    return namesEqual(name, e.underlying!._filenameStr);
                }
                return false;
            }
            return !(e.attribs & forbiddenAttribsForFile) && namesEqual(name, e._filenameStr) && e.attribs !== FatFSDirectoryEntryAttributes.EqLFN;
        }) ?? null;
    }

    public async listDir(): Promise<string[] | null> {
        const entries = await this.getEntries();
        return entries.map(e => {
            if(e instanceof CachedDirectory) {
                if(["..", "."].includes(name83toNormal(e.underlying!._filenameStr))) return null;
                return name83toNormal(e.underlying!._filenameStr) + '/';
            }
            if(e.attribs === FatFSDirectoryEntryAttributes.EqLFN) return null;
            if(e.attribs & forbiddenAttribsForFile) return null;
            return name83toNormal(e._filenameStr);
        }).filter(e => typeof e === 'string') as string[];
    }

    static readyMade(fat: LowLevelFatFilesystem, entries: FatFSDirectoryEntry[], initialCluster: number, underlying: FatFSDirectoryEntry | null){
        const entry = new CachedDirectory(fat, initialCluster, underlying ?? null);
        entry.rawDirectoryEntries = entries.map((e: FatFSDirectoryEntry) => {
            if(e.attribs & FatFSDirectoryEntryAttributes.Directory){
                return new CachedDirectory(fat, initialCluster, e);
            }
            return e;
        });
        return entry;
    }
}

export class LowLevelFatFilesystem {
    bootsectorInfo?: BaseBootSectorInfo;
    fatBootInfo?: FatBootInfo;
    fat32Extension?: Fat32Extension;
    fsInfo?: FatFSInformation;
    maxCluster: number = 0;
    isFat16: boolean = false;
    fat16ClusterAreaOffset = 0;
    root?: CachedDirectory;
    isWritable: boolean;
    endOfChain: number = 0;
    writeFATClusterEntry?: (number: number, next: number) => void;
    readFATClusterEntry?: (number: number) => number;

    fatContents?: DataView;

    private alteredDirectoryEntries: CachedDirectory[] = [];
    private allocator: ClusterAllocator = new ClusterAllocator();

    private clusterToSector(cluster: number){
        // cluster - 2:
        // FAT16 and FAT32 reserve two first clusters - cluster 0 means "No data", and 1 is reserved for the FAT itself.
        // Therefore, we need to decrease the value by two.
        return this.bootsectorInfo!.logicalSectorsPerCluster * (cluster - 2) + this.dataSectorOffset + this.fat16ClusterAreaOffset;
    }

    private get logicalSectorsPerFat(){ return this.isFat16 ? this.bootsectorInfo!.deprecatedLogicalSectorsPerFat : this.fat32Extension!.logicalSectorsPerFat }
    private get dataSectorOffset() { return this.bootsectorInfo!.reservedLogicalSectors + this.bootsectorInfo!.fatCount * this.logicalSectorsPerFat };
    public get clusterSizeInBytes() { return this.bootsectorInfo!.logicalSectorsPerCluster * this.bootsectorInfo!.bytesPerLogicalSector; }

    private constructor(public driver: Driver){
        this.isWritable = !!driver.writeSectors;
    };
    private async load(){
        const firstSector = await this.driver.readSectors(0, 1);
        this.bootsectorInfo = createBootSectorInfo(firstSector);
        this.isFat16 = this.bootsectorInfo.deprecatedLogicalSectorsPerFat !== 0;
        this.endOfChain = this.isFat16 ? 0xFFFF : 0xFFFFFFFF;
        this.readFATClusterEntry = this.isFat16 ? 
            (number: number) => this.fatContents!.getUint16(number * 2, true) :
            (number: number) => this.fatContents!.getUint32(number * 4, true);
        this.writeFATClusterEntry = this.isFat16 ?
            (number: number, next: number) => this.fatContents!.setUint16(number * 2, next, true):
            (number: number, next: number) => this.fatContents!.setUint32(number * 4, next, true);
        let offset = 0x24;
        if(!this.isFat16){
            this.fat32Extension = createFat32ExtendedInfo(firstSector, offset);
            offset += 28;
        }
        this.fatBootInfo = createFatBootInfo(firstSector, offset);

        if(this.bootsectorInfo.bytesPerLogicalSector !== this.driver.sectorSize){
            throw new FatError("The number of bytes per logical sector doesn't match driver's declaration!");
        }
        if(!Number.isInteger(this.bootsectorInfo.bytesPerLogicalSector / 128)) throw new FatError(`Expected logical sector size to be a multiple of 128, got ${this.bootsectorInfo.bytesPerLogicalSector}`);
        if(!Number.isInteger(Math.log2(this.bootsectorInfo.logicalSectorsPerCluster))) throw new FatError(`Expected sectors per cluster ot be a power of 2. Got ${this.bootsectorInfo.logicalSectorsPerCluster}`);

        if(this.fatBootInfo.extendedBootSignature === 0x28) {
            this.fatBootInfo.label = textEncoder.encode("NO NAME    ");
            this.fatBootInfo.fsType = textEncoder.encode("FAT16   ");
        }else if(this.fatBootInfo.extendedBootSignature !== 0x29) {
            throw new FatError(`Found invalid extended boot signature: 0x${this.fatBootInfo.extendedBootSignature.toString(16)}`);
        }

        if(!this.isFat16){
            const fsInfoSector = await this.driver.readSectors(this.fat32Extension!.fsInformationSectorNum, 1);
            this.fsInfo = createFatFsInformation(fsInfoSector);
            if(!(
                arraysEq(this.fsInfo.signature1, textEncoder.encode("RRaA")) &&
                arraysEq(this.fsInfo.signature2, textEncoder.encode("rrAa")) &&
                arraysEq(this.fsInfo.signature3, new Uint8Array([0x00, 0x00, 0x55, 0xaa]))
            )){
                console.log(`[NUFATFS]: Found invalid values in fat32 signatures. Ignoring values.`)
                this.fsInfo.lastKnownFreeDataClusters = 0xFFFFFFFF
                this.fsInfo.lastKnownAllocatedDataCluster = 0xFFFFFFFF
            }
        }

        this.maxCluster = Math.floor((this.bootsectorInfo.totalLogicalSectors - this.dataSectorOffset) / this.bootsectorInfo.logicalSectorsPerCluster);
        if(this.maxCluster > 0x0FFF_FFF7){
            console.log("[NUFATFS]: Warning: FAT Device is too big. Some data will be inaccessible");
            this.maxCluster = 0x0FFF_FFF7;
        }
        if(this.isFat16){
            this.fat16ClusterAreaOffset = (this.bootsectorInfo.deprecatedMaxRootDirEntries * 32) / this.bootsectorInfo.bytesPerLogicalSector;
        }
        let rawFat = await this.driver.readSectors(this.bootsectorInfo.reservedLogicalSectors, this.logicalSectorsPerFat);
        this.fatContents = new DataView(rawFat.buffer);
        for(let alternativeFat = 1; alternativeFat < this.bootsectorInfo.fatCount; alternativeFat++){
            let altFatContents = await this.driver.readSectors(this.bootsectorInfo.reservedLogicalSectors + this.logicalSectorsPerFat*alternativeFat, this.logicalSectorsPerFat);
            if(!arraysEq(altFatContents, rawFat)){
                throw new FatError("Fat backup invalid - filesystem damaged. Run CHKDSK or fsck!");
            }
        }
        
        // If we're dealing with FAT16, this.dataSectorOffset points to the root directory.
        // Else, read the directory table from 32extension
        if(this.isFat16){
            let rootSectorLength = (this.bootsectorInfo!.deprecatedMaxRootDirEntries * 32) / this.driver.sectorSize;
            // -1 as initialSector for root directory location:
            // In FAT16, there's a limited amount of entries that can be stored in the root.
            // That limit is defined in the filesystem's bootsectorInfo, so it can't be changed.
            // Therefore, the allocator that in the case of the FAT32 FS would extend the root dir's
            // chains by providing new links has to be disabled.
            this.root = CachedDirectory.readyMade(this, await this.consumeAllDirectoryEntries(await this.driver.readSectors(this.dataSectorOffset, rootSectorLength)), -1, null);
        }else{
            const rootCluster = this.fat32Extension!.rootDirCluster;
            this.root = CachedDirectory.readyMade(this, await this.readAndConsumeAllDirectoryEntries(rootCluster), rootCluster, null);
        }
    }

    public markAsAltered(entry: CachedDirectory){
        this.alteredDirectoryEntries.push(entry);
    }

    private async consumeAllDirectoryEntries(data: Uint8Array): Promise<FatFSDirectoryEntry[]> {
        let output = [];
        let offset = 0;
        let lfnCounter = 0;
        for(;;){
            let entry = createFatFSDirectoryEntry(data, offset);
            if(entry.attribs === FatFSDirectoryEntryAttributes.EqLFN) lfnCounter++;
            else{
                entry._lfns = lfnCounter;
                lfnCounter = 0;
            }
            offset += 32;
            if(entry.filename[0] == 0xe5) continue;
            if(entry.filename[0] == 0x00) break;
            output.push(entry);
        }
        if(lfnCounter){
            console.log(`[NUFATFS]: Warning! Encountered unused LFNs while traversing directory trees`);
        }
        return output;
    }

    public getClusterChainFromFAT(initialCluster: number): number[]{
        let link = initialCluster;
        const links = [link];
        // console.log("Constructing chain for " + initialCluster);
        // 0x00 can be EoC as well.
        while(!([this.endOfChain, 0x00].includes(link = this.readFATClusterEntry!(link)))) {
            // console.log("... " + link);
            links.push(link);
        }
        // console.log("Chain complete. There are " + links.length + " links");
        return links;
    }

    public constructClusterChain(initialCluster: number, enableAllocator = true, limitLength: number = Number.MAX_SAFE_INTEGER){
        // TODO: For writing - allocator
        const defaultLength = this.bootsectorInfo!.logicalSectorsPerCluster * this.driver.sectorSize;
        const clusterChain = this.getClusterChainFromFAT(initialCluster);
        const links = [];
        for(let link of clusterChain) {
            let length = Math.min(limitLength, defaultLength);
            limitLength -= length;
            links.push(new ClusterChainLink(this, link, length));
            if(limitLength <= 0) break;
        }
        return new Chain(links, enableAllocator ? this.allocator.allocate.bind(this.allocator) : undefined);
    }

    public async readAndConsumeAllDirectoryEntries(initialCluster: number) {
        return this.consumeAllDirectoryEntries(await this.constructClusterChain(initialCluster).readAll());
    }

    public async readClusters(clusterNumber: number, count: number){
        if(clusterNumber + count > this.driver.numSectors){
            throw new FatError("Corrupted FAT - reading outside of volume!");
        }
        return this.driver.readSectors(this.clusterToSector(clusterNumber), count * this.bootsectorInfo!.logicalSectorsPerCluster);
    }

    public async writeClusters(clusterNumber: number, data: Uint8Array){
        if(!this.isWritable) throw new FatError("Cannot write to a read-only volume!");
        if(clusterNumber + (data.length / this.clusterSizeInBytes) > this.driver.numSectors){
            throw new FatError("Corrupted FAT - writing outside of volume!");
        }
        await this.driver.writeSectors!(this.clusterToSector(clusterNumber), data);
    }

    public async redefineClusterChain(newChain: number[]){
        // Free the previous chain, then rewrite it.
        // ( Get initial cluster from the new chain )
        const previousChain = this.getClusterChainFromFAT(newChain[0]);
        for(let link of previousChain){
            this.writeFATClusterEntry!(link, 0x00);
        }
        let previous = newChain[0];
        for(let link of newChain.slice(1)){
            this.writeFATClusterEntry!(previous, link);
            previous = link;
        }
        // Write End-of-Chain
        this.writeFATClusterEntry!(previous, this.endOfChain);
    }

    public async flush() {
        // Since we're not altering any format-related infortmation
        // only the FAT and all changed directory entries will need to be flushed.
        if(!this.isWritable) {
            throw new FatError("Cannot flush a read-only volume.");
        }
        // Reserialize the FAT tables, and write all the copies.
        const fatContents = new Uint8Array(this.fatContents!.buffer);
        for(let i = 0; i<this.bootsectorInfo!.fatCount; i++) {
            await this.driver.writeSectors!(this.bootsectorInfo!.reservedLogicalSectors + i * this.fatContents!.byteLength, fatContents);
        }

        // Rebuild all the altered directory entries.
        for(let entry of this.alteredDirectoryEntries){
            let writingChain;
            if(entry.initialCluster === -1) {
                // Root cluster on FAT16. Do not use an allocator. Instead fake this chain.
                let rootSectorLength = (this.bootsectorInfo!.deprecatedMaxRootDirEntries * 32) / this.driver.sectorSize;
                const that = this;
                writingChain = new Chain([ {
                    length: rootSectorLength,
                    async read(){
                        // This will be the structure on which the new data will be overlayed
                        // By returning zeros here, we make sure there's no outdated data in the root directory
                        return new Uint8Array(rootSectorLength).fill(0);
                    },
                    async write(data: Uint8Array){
                        await that.driver.writeSectors!(that.dataSectorOffset, data);
                    }
                } ]);
            }else{
                writingChain = this.constructClusterChain(entry.initialCluster);
            }
            
            for(let subentry of await entry.getEntries()){
                let raw = subentry instanceof CachedDirectory ? subentry.underlying! : subentry;
                writingChain.write(serializeFatFSDirectoryEntry(raw));
            }
            await writingChain.flushWritingBuffer();
        }
        this.alteredDirectoryEntries = [];
    }

    public static async _create(driver: Driver){
        const fs = new LowLevelFatFilesystem(driver);
        await fs.load();
        return fs;
    }
}

// Normal API:
// await fs.open() => FileHandle (number)
// await fs.read(handle, 0x100) => Uint8Array
// fs.getUnderlying() => FATAllocation
