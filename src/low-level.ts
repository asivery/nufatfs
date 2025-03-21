import { Chain, ChainLink } from "./chained-structures";
import { ClusterAllocator } from "./cluster-allocator";
import { ClusterChainLink } from "./cluster-chain";
import { createBootSectorInfo, createFat32ExtendedInfo, createFatBootInfo, createFatFSDirectoryEntry, createFatFsInformation, serializeFatFSDirectoryEntry } from "./constructors";
import { BaseBootSectorInfo, Driver, Fat32Extension, FatBootInfo, FatFSDirectoryEntry, FatFSDirectoryEntryAttributes, FatFSInformation } from "./types";
import { arraysEq, name83toNormal, nameNormalTo83, namesEqual, structFormatUnpack } from "./utils";

export class FatError extends Error {}

const textEncoder = new TextEncoder();

// The idea of this filesystem implementation is serializing the whole
// file allocation table, along with the directory entries in memory upon initial reading.
// The cached entries have an 'altered' flag. If the flag is set, upon cache flushing these
// entries will be written to disk, and the flags will be cleared.
// Writing data to files / disk is never cached. Only FS structures are. (At least by the core driver)
// ( External drivers might provide caching of their own )

export type CachedFatDirectoryEntry = CachedDirectory | FatFSDirectoryEntry;
export const FAT_MARKER_DELETED = 0xe5;

export const FORBIDDEN_ATTRIBUTES_FOR_FILE =
    FatFSDirectoryEntryAttributes.Directory |
    FatFSDirectoryEntryAttributes.VolumeLabel;


export class CachedDirectory {
    public rawDirectoryEntries?: CachedFatDirectoryEntry[];
    constructor(private fat: LowLevelFatFilesystem, public initialCluster: number, public underlying: FatFSDirectoryEntry | null){}
    public async getEntries(): Promise<CachedFatDirectoryEntry[]>{
        if(!this.rawDirectoryEntries){
            // Load it all first
            const initialCluster = this.underlying!._firstCluster;
            const rawEntries = await this.fat.readAndConsumeAllDirectoryEntries(initialCluster);
            this.rawDirectoryEntries = rawEntries.map((e: FatFSDirectoryEntry) => {
                if(e.attribs & FatFSDirectoryEntryAttributes.Directory){
                    let entryInitialCluster = e._firstCluster;
                    return new CachedDirectory(this.fat, entryInitialCluster, e);
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
            return !(e.attribs & FORBIDDEN_ATTRIBUTES_FOR_FILE) && namesEqual(name, e._filenameStr) && e.attribs !== FatFSDirectoryEntryAttributes.EqLFN;
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
            if(e.attribs & FORBIDDEN_ATTRIBUTES_FOR_FILE) return null;
            return name83toNormal(e._filenameStr);
        }).filter(e => typeof e === 'string') as string[];
    }

    static readyMade(fat: LowLevelFatFilesystem, entries: FatFSDirectoryEntry[], initialCluster: number, underlying: FatFSDirectoryEntry | null){
        const entry = new CachedDirectory(fat, initialCluster, underlying ?? null);
        entry.rawDirectoryEntries = entries.map((e: FatFSDirectoryEntry) => {
            if(e.attribs & FatFSDirectoryEntryAttributes.Directory){
                let entryInitialCluster = e._firstCluster;
                if(entryInitialCluster === 0) {
                    // Root.
                    return CachedDirectory.readyMade(fat, fat.root!.rawDirectoryEntries!.map(e => (e instanceof CachedDirectory) ? e.underlying! : e), 0, e);
                }
                return new CachedDirectory(fat, entryInitialCluster, e);
            }
            return e;
        });
        return entry;
    }
}

export enum FatType {
    Fat12, Fat16, Fat32
}

export class LowLevelFatFilesystem {
    bootsectorInfo?: BaseBootSectorInfo;
    fatBootInfo?: FatBootInfo;
    fat32Extension?: Fat32Extension;
    fsInfo?: FatFSInformation;
    maxCluster: number = 0;
    maxDataCluster: number = 0;
    fatType: FatType = FatType.Fat16;
    get isFat16Or12() {
        return this.fatType === FatType.Fat16 || this.fatType === FatType.Fat12;
    }
    fat16ClusterAreaOffset = 0;
    root?: CachedDirectory;
    isWritable: boolean;
    endOfChain: number[] = [];
    alteredFATSectors: Set<number> = new Set();
    private fatAltered = false;

    private fatContents?: DataView;

    private alteredDirectoryEntries: CachedDirectory[] = [];
    public allocator?: ClusterAllocator;

    private clusterToSector(cluster: number){
        // cluster - 2:
        // FAT16 and FAT32 reserve two first clusters - cluster 0 means "No data", and 1 is reserved for the FAT itself.
        // Therefore, we need to decrease the value by two.
        return this.bootsectorInfo!.logicalSectorsPerCluster * (cluster - 2) + this.dataSectorOffset + this.fat16ClusterAreaOffset;
    }
    readFATClusterEntry(number: number) {
        if(this.fatType === FatType.Fat12) {
            const base = Math.floor(number / 2) * 3;
            const baseContents = (this.fatContents!.getUint16(base, true) | (this.fatContents!.getUint8(base + 2) << 16)) >>> 0;

            if (number & 1) {
                return (baseContents & 0xFFF000) >>> 12;
            } else {
                return (baseContents & 0xFFF) >>> 0;
            }
        } else if(this.fatType === FatType.Fat16) {
            return this.fatContents!.getUint16(number * 2, true);
        } else {
            return this.fatContents!.getUint32(number * 4, true);
        }
    }

    writeFATClusterEntry(number: number, next: number) {
        let sector;
        if(this.fatType === FatType.Fat12) {
            const base = Math.floor(number / 2) * 3;
            let baseContents = (this.fatContents!.getUint16(base, true) | (this.fatContents!.getUint8(base + 2) << 16)) >>> 0;

            if (number & 1) {
                baseContents = baseContents & 0x000FFF | (next << 12);
            } else {
                baseContents = baseContents & 0xFFF000 | next;
            }
            this.fatContents!.setUint16(base, baseContents & 0xFFFF, true);
            this.fatContents!.setUint8(base + 2, baseContents >>> 16);

            this.alteredFATSectors.add(Math.floor(base / this.bootsectorInfo!.bytesPerLogicalSector));
            this.alteredFATSectors.add(Math.floor((base + 2) / this.bootsectorInfo!.bytesPerLogicalSector));
            this.fatAltered = true;
            return;
        } else if(this.fatType === FatType.Fat16) {
            sector = Math.floor((number * 2) / this.bootsectorInfo!.bytesPerLogicalSector);
            this.fatContents!.setUint16(number * 2, next, true);
        } else {
            sector = Math.floor((number * 4) / this.bootsectorInfo!.bytesPerLogicalSector);
            this.fatContents!.setUint32(number * 4, next, true);
        }
        this.alteredFATSectors.add(sector);
        this.fatAltered = true;
    }

    private get dataSectorOffset() { return this.bootsectorInfo!.reservedLogicalSectors + this.bootsectorInfo!.fatCount * this.logicalSectorsPerFat };
    public get logicalSectorsPerFat(){ return this.isFat16Or12 ? this.bootsectorInfo!.deprecatedLogicalSectorsPerFat : this.fat32Extension!.logicalSectorsPerFat }
    public get clusterSizeInBytes() { return this.bootsectorInfo!.logicalSectorsPerCluster * this.bootsectorInfo!.bytesPerLogicalSector; }

    private constructor(public driver: Driver){
        this.isWritable = !!driver.writeSectors;
    };
    private async load(bypassCoherencyCheck: boolean = false, forceFSType?: FatType) {
        const firstSector = await this.driver.readSectors(0, 1);
        this.bootsectorInfo = createBootSectorInfo(firstSector);
        let offset = 0x24;
        // Fat 12 has to be forced on.
        if(this.bootsectorInfo.deprecatedLogicalSectorsPerFat === 0){
            this.fat32Extension = createFat32ExtendedInfo(firstSector, offset);
            offset += 28;
            this.fatType = FatType.Fat32;
        } else {
            this.fatType = FatType.Fat16;
        }
        if(forceFSType !== undefined) {
            this.fatType = forceFSType;
        }
        switch(this.fatType) {
            case FatType.Fat12:
                this.endOfChain = Array(8).fill(0).map((e, i) => 0xFF8 + i);
                break;
            case FatType.Fat16:
                this.endOfChain = Array(8).fill(0).map((e, i) => 0xFFF8 + i);
                break;
            case FatType.Fat32:
                this.endOfChain = Array(8).fill(0).map((e, i) => 0x0FFFFFF8 + i);
                break;
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
            console.log(`[NUFATFS]: Warning: Found invalid extended boot signature: 0x${this.fatBootInfo.extendedBootSignature.toString(16)}`);
        }

        if(this.fatType === FatType.Fat32){
            const fsInfoSector = await this.driver.readSectors(this.fat32Extension!.fsInformationSectorNum, 1);
            this.fsInfo = createFatFsInformation(fsInfoSector);
            if(!(
                arraysEq(this.fsInfo.signature1, textEncoder.encode("RRaA")) &&
                arraysEq(this.fsInfo.signature2, textEncoder.encode("rrAa")) &&
                arraysEq(this.fsInfo.signature3, new Uint8Array([0x00, 0x00, 0x55, 0xaa]))
            )){
                console.log(`[NUFATFS]: Warning: Found invalid values in fat32 signatures. Ignoring values.`)
                this.fsInfo.lastKnownFreeDataClusters = 0xFFFFFFFF
                this.fsInfo.lastKnownAllocatedDataCluster = 0xFFFFFFFF
            }
        }

        const totalLogicalSectors = this.bootsectorInfo.deprecatedTotalLogicalSectors || this.bootsectorInfo.totalLogicalSectors;
        this.maxCluster = Math.floor((totalLogicalSectors - this.dataSectorOffset) / this.bootsectorInfo.logicalSectorsPerCluster);
        if(this.maxCluster > 0x0FFF_FFF7){
            console.log("[NUFATFS]: Warning: FAT Device is too big. Some data will be inaccessible.");
            this.maxCluster = 0x0FFF_FFF7;
        }

        // Carve out space for reserved data. (see clusterToSector for explanation)
        this.maxDataCluster = this.maxCluster - Math.ceil((this.dataSectorOffset + this.fat16ClusterAreaOffset) / this.bootsectorInfo.logicalSectorsPerCluster) - 2;
        if(this.isFat16Or12){
            this.fat16ClusterAreaOffset = (this.bootsectorInfo.deprecatedMaxRootDirEntries * 32) / this.bootsectorInfo.bytesPerLogicalSector;
        }
        let rawFat = await this.driver.readSectors(this.bootsectorInfo.reservedLogicalSectors, this.logicalSectorsPerFat);
        this.fatContents = new DataView(rawFat.buffer);
        if(!bypassCoherencyCheck) {
            for(let alternativeFat = 1; alternativeFat < this.bootsectorInfo.fatCount; alternativeFat++){
                let altFatContents = await this.driver.readSectors(this.bootsectorInfo.reservedLogicalSectors + this.logicalSectorsPerFat*alternativeFat, this.logicalSectorsPerFat);
                if(!arraysEq(altFatContents, rawFat)){
                    throw new FatError("Fat backup invalid - filesystem damaged. Run CHKDSK or fsck!");
                }
            }
        }

        this.root = CachedDirectory.readyMade(this, await this.getRootDirectoryData(), this.isFat16Or12 ? -1 : this.fat32Extension!.rootDirCluster, null);
        this.allocator = await ClusterAllocator.create(this);
    }

    public async getRootDirectoryData(): Promise<FatFSDirectoryEntry[]>{
        // If we're dealing with FAT16, this.dataSectorOffset points to the root directory.
        // Else, read the directory table from 32extension
        if(this.isFat16Or12){
            let rootSectorLength = (this.bootsectorInfo!.deprecatedMaxRootDirEntries * 32) / this.driver.sectorSize;
            return this.consumeAllDirectoryEntries(await this.driver.readSectors(this.dataSectorOffset, rootSectorLength));
        }else{
            return await this.readAndConsumeAllDirectoryEntries(this.fat32Extension!.rootDirCluster)
        }
    }

    public markAsAltered(entry: CachedDirectory){
        if(!this.alteredDirectoryEntries.includes(entry)) {
            this.alteredDirectoryEntries.push(entry);
        }
    }

    public markFatAsAltered(){
        this.fatAltered = true;
    }

    public consumeAllDirectoryEntries(data: Uint8Array, includeDeleted = false): FatFSDirectoryEntry[] {
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
            if(entry.filename[0] == FAT_MARKER_DELETED && !includeDeleted) continue;
            if(entry.filename[0] == 0x00) break;
            output.push(entry);
        }
        if(lfnCounter){
            console.log(`[NUFATFS]: Warning! Encountered unused LFNs while traversing directory trees.`);
        }
        return output;
    }

    public getClusterChainFromFAT(initialCluster: number): number[]{
        let link = initialCluster;
        const links = [link];
        // console.log("Constructing chain for " + initialCluster);
        // 0x00 can be EoC as well.
        while(!([...this.endOfChain, 0x00].includes(link = this.readFATClusterEntry!(link)))) {
            // console.log("... " + link);
            if(links.includes(link)) throw new Error("Infinite allocation loop!");
            links.push(link);
        }
        // console.log("Chain complete. There are " + links.length + " links");
        return links;
    }

    public constructClusterChain(initialCluster: number, enableAllocator = true, limitLength?: number){
        if(!this.allocator && enableAllocator) {
            throw new FatError("Cannot use the allocator when mid-initialization!");
        }
        const defaultLength = this.bootsectorInfo!.logicalSectorsPerCluster * this.driver.sectorSize;
        const links = [];

        // InitialCluster === 0 denotes file created, but space unallocated. It is zero bytes long.
        if(initialCluster !== 0) {
            const clusterChain = this.getClusterChainFromFAT(initialCluster);
            for(let link of clusterChain) {
                links.push(new ClusterChainLink(this, link, defaultLength));
            }
        }
        return new Chain(links, enableAllocator ? (link, size) => Promise.resolve(this.allocator!.allocate(link, size)) : undefined, limitLength);
    }

    public async readAndConsumeAllDirectoryEntries(initialCluster: number) {
        return this.consumeAllDirectoryEntries(await this.constructClusterChain(initialCluster, false).readAll());
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

    public async redefineClusterChain(oldInitialCluster: number, newChain: number[]){
        // Free the previous chain, then rewrite it.
        // ( Get initial cluster from the new chain )
        const previousChain = this.getClusterChainFromFAT(oldInitialCluster);

        for(let link of previousChain) {
            if(newChain.indexOf(link) === -1) {
                // Give it to the allocator (mark as free)
                this.allocator!.freemap[link] = true;
            }
        }

        for(let link of newChain) {
            if(previousChain.indexOf(link) === -1){
                // Take it from the allocator (mark as nonfree)
                this.allocator!.freemap[link] = false;
            }
        }

        // Make the allocator recompute the freelist
        this.allocator!.convertFreemapToFreelist();

        for(let link of previousChain){
            this.writeFATClusterEntry!(link, 0x00);
        }
        let previous = newChain[0];
        for(let link of newChain.slice(1)){
            this.writeFATClusterEntry!(previous, link);
            previous = link;
        }
        // Write End-of-Chain
        this.writeFATClusterEntry!(previous, this.endOfChain[this.endOfChain.length - 1]);
    }

    public async flush() {
        // Since we're not altering any format-related infortmation
        // only the FAT and all changed directory entries will need to be flushed.
        if(!this.isWritable) {
            throw new FatError("Cannot flush a read-only volume.");
        }
        // Reserialize the FAT tables, and write all the copies.
        if(this.fatAltered){
            const fatContents = new Uint8Array(this.fatContents!.buffer);
            for(let fat = 0; fat < this.bootsectorInfo!.fatCount; fat++) {
                for(const usedFATSector of this.alteredFATSectors) {
                    const sectorSlice = fatContents.subarray(
                        usedFATSector * this.bootsectorInfo!.bytesPerLogicalSector,
                        (usedFATSector + 1) * this.bootsectorInfo!.bytesPerLogicalSector,
                    );
                    await this.driver.writeSectors!(this.bootsectorInfo!.reservedLogicalSectors + fat * this.logicalSectorsPerFat + usedFATSector, sectorSlice);
                }
            }
            this.alteredFATSectors = new Set();
            this.fatAltered = false;
        }

        // Rebuild all the altered directory entries.
        const toFree: number[] = [];
        for(let entry of this.alteredDirectoryEntries){
            let writingChain;
            if(entry.initialCluster === -1) {
                // Root cluster on FAT16. Do not use an allocator. Instead fake this chain.
                let rootSectorLength = (this.bootsectorInfo!.deprecatedMaxRootDirEntries * 32);
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

            let remaining = writingChain.length();
            for(let subentry of await entry.getEntries()){
                const raw = subentry instanceof CachedDirectory ? subentry.underlying! : subentry;
                const data = serializeFatFSDirectoryEntry(raw);
                remaining -= data.length;
                await writingChain.write(data);
            }
            if(remaining > 0) {
                while(remaining > writingChain.links[writingChain.links.length - 1].length && entry.initialCluster !== -1) {
                    // Remove the last chain.
                    const lastLink = writingChain.links.splice(writingChain.links.length - 1, 1)[0] as ClusterChainLink;
                    toFree.push(lastLink.index);
                    this.writeFATClusterEntry!(lastLink.index, 0);
                    if(writingChain.links.length) this.writeFATClusterEntry!((writingChain.links[writingChain.links.length - 1] as ClusterChainLink).index, this.endOfChain[this.endOfChain.length - 1]);
                    remaining -= lastLink.length;
                }
                // Zero out the rest.
                await writingChain.write(new Uint8Array(remaining).fill(0));
            }
            await writingChain.flushChanges();
        }
        this.allocator?.addClusterListToFreelist(toFree);
        this.alteredDirectoryEntries = [];
    }

    // TODO: LFN support!
    public async traverseEntries(path: string): Promise<CachedFatDirectoryEntry[] | null> {
        while(path.startsWith("/")) path = path.substring(1);
        const pathEntries = path.split("/").filter(e => e);
        let currentRoot: CachedFatDirectoryEntry = this.root!;
        let roots: CachedFatDirectoryEntry[] = [currentRoot];
        for(let i = 0; i<pathEntries.length; i++){
            const next: CachedFatDirectoryEntry | null = await (currentRoot as CachedDirectory).findEntry(name83toNormal(nameNormalTo83(pathEntries[i])));
            if(!next) return null;
            if(i !== pathEntries.length - 1 && !(next instanceof CachedDirectory)){
                return null;
            }
            currentRoot = next;
            roots.push(currentRoot);
        }
        return roots;
    }

    public async traverse(path: string): Promise<CachedFatDirectoryEntry | null> {
        const entries = await this.traverseEntries(path);
        return entries ? entries[entries.length - 1] : null;
    }

    public static async _create(driver: Driver, bypassCoherencyCheck: boolean = false, forceFSType?: FatType){
        const fs = new LowLevelFatFilesystem(driver);
        await fs.load(bypassCoherencyCheck, forceFSType);
        return fs;
    }
}

// Normal API:
// await fs.open() => FileHandle (number)
// await fs.read(handle, 0x100) => Uint8Array
// fs.getUnderlying() => FATAllocation
