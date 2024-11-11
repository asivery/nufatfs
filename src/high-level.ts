import { CachedDirectory, FatError, FAT_MARKER_DELETED, LowLevelFatFilesystem, CachedFatDirectoryEntry } from "./low-level";
import { Chain } from "./chained-structures";
import { Driver, FatFSDirectoryEntry, FatFSDirectoryEntryAttributes } from "./types";
import { nameNormalTo83 } from "./utils";
import { ClusterChainLink } from "./cluster-chain";
import { newFatFSDirectoryEntry } from "./constructors";

// This class aims to contain the demons stored in LowLevelFatFilesystem.
export class FatFilesystem {
    private constructor(private fat: LowLevelFatFilesystem){}
    public static async create(driver: Driver, bypassCoherencyCheck: boolean = false){
        const fat = await LowLevelFatFilesystem._create(driver, bypassCoherencyCheck);
        return new FatFilesystem(fat);
    }

    public async open(path: string, writable: boolean = false): Promise<FatFSFileHandle | null>{
        if(writable && !this.fat.isWritable){
            throw new FatError("Cannot open a file for writing on a read-only volume!");
        }
        const tree = await this.fat.traverseEntries(path);
        if(!tree) return null;
        const [parent, entry] = tree.slice(-2);
        if(!parent || !entry || entry instanceof CachedDirectory) return null;
        const chain = this.fat.constructClusterChain(entry.firstClusterAddressLow | entry.firstClusterAddressHigh << 16, true, entry.fileSize);
        return new FatFSFileHandle(this.fat, chain, writable, entry, parent as CachedDirectory);
    }

    public async create(path: string): Promise<FatFSFileHandle | null>{
        // Make sure the file we're about to create doesn't already exist.
        const existingEntry = await this.fat.traverse(path);
        if(existingEntry) {
            return null;
        }

        let lastSlash = path.lastIndexOf("/");
        let parent: CachedFatDirectoryEntry | null;
        if(lastSlash === -1) {
            parent = this.fat.root!;
        } else {
            const parentPath = path.slice(0, lastSlash);
            parent = await this.fat.traverse(parentPath);
            if(!parent || !(parent instanceof CachedDirectory)) {
                return null;
            }
        }

        const name = path.slice(lastSlash + 1);
        const encName = nameNormalTo83(name);
        const entry: FatFSDirectoryEntry = newFatFSDirectoryEntry(encName, FatFSDirectoryEntryAttributes.None, 0, 0);
        await parent.getEntries(); // Load entry from driver
        parent.rawDirectoryEntries!.push(entry);
        this.fat.markAsAltered(parent);
        return new FatFSFileHandle(this.fat, this.fat.constructClusterChain(0, true), true, entry, parent);
    }

    public async listDir(path: string): Promise<string[] | null>{
        const entry = await this.fat.traverse(path);
        if(!entry || !(entry instanceof CachedDirectory)) return null;
        return entry.listDir();
    }

    public async getSizeOf(path: string): Promise<null | number>{
        const entry = await this.fat.traverse(path);
        if(!entry || (entry instanceof CachedDirectory)) return null;
        return entry.fileSize;
    }

    public getStats(): {totalClusters: number, totalBytes: number, freeClusters: number, freeBytes: number} {
        const totalClusters = this.fat.allocator!.freemap.length;
        const freeClusters = this.fat.allocator!.freemap.filter(e => e).length;
        return {
            totalClusters,
            freeClusters,
            totalBytes: totalClusters * this.fat.clusterSizeInBytes,
            freeBytes: freeClusters * this.fat.clusterSizeInBytes,
        };
    }

    public async delete(path: string) {
        const tree = await this.fat.traverseEntries(path);
        if(!tree) return null;
        const [parent, entry] = tree.slice(-2);
        if(entry instanceof CachedDirectory){
            if((await entry.getEntries()).length > 2) { // 2 entries - '.' and '..'
                throw new FatError("Cannot delete a non-empty directory.");
            } 
        }
        if(!entry || !parent || !(parent instanceof CachedDirectory)) {
            throw new FatError("File not found!");
        }
        let rawEntry = entry instanceof CachedDirectory ? entry.underlying! : entry;

        // Mark as deleted
        rawEntry.filename[0] = FAT_MARKER_DELETED;
        rawEntry._filenameStr = '';
        // Ask the main driver to update this entry's parent
        this.fat.markAsAltered(parent);
        // Remove the file from parent's cache
        parent.rawDirectoryEntries!.splice(parent.rawDirectoryEntries!.indexOf(entry), 1);
        // Construct a chain, then free it
        const cluster = rawEntry.firstClusterAddressLow | (rawEntry.firstClusterAddressHigh << 16);
        const chain = this.fat.getClusterChainFromFAT(cluster);
        this.fat.allocator!.addClusterListToFreelist(chain);
        // Zero out the chain in FAT
        for(let e of chain) {
            this.fat.writeFATClusterEntry!(e, 0);
        }
    }

    public async rename(path: string, newPath: string) {
        const existingNewTree = await this.fat.traverseEntries(newPath);
        if(existingNewTree) {
            throw new FatError("File already exists!");
        }
        let lastSlash = newPath.lastIndexOf("/");
        const newParentPath = newPath.includes("/") ? newPath.slice(0, lastSlash) : null;
        const newName = newPath.slice(lastSlash + 1);
        const newParent = newParentPath ? (await this.fat.traverse(newParentPath) as CachedDirectory) : this.fat.root!;

        const entry = await this.fat.traverse(path);
        lastSlash = newPath.lastIndexOf("/");
        let oldParentPath = path.slice(0, lastSlash);
        const oldParent = await this.fat.traverse(oldParentPath) as CachedDirectory;

        if(!(newParent instanceof CachedDirectory) || !(newParent instanceof CachedDirectory)){
            throw new FatError("Cannot move an entry into a file, not a directory!");
        }
        if(!entry) throw new FatError("File doens't exist!");
        let rawEntry = entry instanceof CachedDirectory ? entry.underlying! : entry;
        // Update name
        rawEntry._filenameStr = nameNormalTo83(newName);
        // Renaming will strip LFNs, since we can't encode them yet.
        // Cache
        await oldParent.getEntries();
        let thisEntryIndex = oldParent.rawDirectoryEntries!.indexOf(entry);
        // Remove both the actual entry reference, and the LFNs that point to it
        oldParent.rawDirectoryEntries!.splice(thisEntryIndex - rawEntry._lfns, 1 + rawEntry._lfns);
        rawEntry._lfns = 0;
        // Mark oldParent as in need of a flush
        this.fat.markAsAltered(oldParent);
        // Cache
        await newParent.getEntries();
        newParent.rawDirectoryEntries!.push(entry);
        // Mark newParent as in need of a flush
        this.fat.markAsAltered(newParent);
    }

    public async mkdir(path: string) {
        let lastSlash = path.lastIndexOf("/");
        const parentPath = path.includes("/") ? path.slice(0, lastSlash) : null;
        const name = nameNormalTo83(path.slice(lastSlash + 1));
        const parent = parentPath ? (await this.fat.traverse(parentPath) as CachedDirectory) : this.fat.root!;
        if(await parent.findEntry(name)) return;

        const rootCluster = this.fat.allocator!.allocate(null, 1)[0];
        if(!rootCluster || (this.fat.isFat16 && rootCluster.index > 0xFFFF)) {
            throw new Error("Cannot allocate next cluster!");
        }
        // Create the directory entry
        const dirEntry = newFatFSDirectoryEntry(name, FatFSDirectoryEntryAttributes.Directory, rootCluster.index, 0);
        // Create the underlying low-level structures.
        const ownDirEntry = newFatFSDirectoryEntry(".          ", FatFSDirectoryEntryAttributes.Directory, rootCluster.index, 0);
        const ownParentEntry = newFatFSDirectoryEntry("..         ", FatFSDirectoryEntryAttributes.Directory, parent.initialCluster === -1 ? 0 : parent.initialCluster, 0);
        // 'format' the cluster
        await rootCluster.write(new Uint8Array(rootCluster.length).fill(0));
        // Create the cached entry
        const cachedEntry = CachedDirectory.readyMade(this.fat!, [ownDirEntry, ownParentEntry], rootCluster.index, dirEntry);

        // Cache
        await parent.getEntries();
        parent.rawDirectoryEntries!.push(cachedEntry);
        this.fat.markAsAltered(parent);
        this.fat.markAsAltered(cachedEntry);
    }

    public async flushMetadataChanges(){
        return this.fat.flush();
    }

    public getUnderlying(){
        return this.fat;
    }
}

export class FatFSFileHandle {
    public get length(){
        return this.chain.getTotalLength();
    }

    constructor(private fat: LowLevelFatFilesystem, private chain: Chain<ClusterChainLink>, private writable: boolean, private underlying: FatFSDirectoryEntry, private parent: CachedDirectory){}

    seek(to: number){
        this.chain.seek(to);
    }

    async read(bytes: number) {
        return this.chain.read(bytes);
    }

    async readAll() {
        return this.chain.readAll();
    }

    async close(){
        if(!this.writable) return;
        await this.chain.flushChanges();
        this.underlying.fileSize = this.chain.getTotalLength();
        if(this.underlying.firstClusterAddressHigh === 0 && this.underlying.firstClusterAddressLow === 0 && this.underlying.fileSize) {
            // This was an empty file before, but is not anymore
            const rootCluster = this.chain.links[0].index!;
            this.underlying.firstClusterAddressLow = rootCluster & 0xFFFF;
            this.underlying.firstClusterAddressHigh = (rootCluster & 0xFFFF0000) >> 16;
        }
        this.fat.markAsAltered(this.parent);
    }

    async write(data: Uint8Array){
        return this.chain.write(data);
    }
}
