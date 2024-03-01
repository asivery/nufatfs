import { CachedDirectory, CachedFatDirectoryEntry, FatError, LowLevelFatFilesystem } from "./low-level";
import { Chain } from "./chained-structures";
import { Driver, FatFSDirectoryEntry } from "./types";

export class FatFilesystem {
    private constructor(private fat: LowLevelFatFilesystem){}
    public static async create(driver: Driver){
        const fat = await LowLevelFatFilesystem._create(driver);
        return new FatFilesystem(fat);
    }

    // TODO: LFN support!
    private async traverse(path: string): Promise<CachedFatDirectoryEntry | null> {
        while(path.startsWith("/")) path = path.substring(1);
        const pathEntries = path.split("/").filter(e => e);
        let currentRoot: CachedFatDirectoryEntry = this.fat.root!;
        for(let i = 0; i<pathEntries.length; i++){
            const next: CachedFatDirectoryEntry | null = await (currentRoot as CachedDirectory).findEntry(pathEntries[i]);
            if(!next) return null;
            if(i !== pathEntries.length - 1 && !(next instanceof CachedDirectory)){
                return null;
            }
            currentRoot = next;
        }
        return currentRoot;
    }

    public async open(path: string, writable: boolean = false): Promise<FatFSFileHandle | null>{
        if(writable && !this.fat.isWritable){
            throw new FatError("Cannot open a file for writing on a read-only volume!");
        }
        const entry = await this.traverse(path);
        if(!entry || entry instanceof CachedDirectory) return null;
        const chain = this.fat.constructClusterChain(entry.firstClusterAddressLow | entry.firstClusterAddressHigh << 16, entry.fileSize);
        return new FatFSFileHandle(chain, writable, entry);
    }

    public async listDir(path: string): Promise<string[] | null>{
        const entry = await this.traverse(path);
        if(!entry || !(entry instanceof CachedDirectory)) return null;
        return entry.listDir();
    }

    public async getSizeOf(path: string): Promise<null | number>{
        const entry = await this.traverse(path);
        if(!entry || (entry instanceof CachedDirectory)) return null;
        return entry.fileSize;
    }

    public async rename(path: string, newPath: string) {
        const entry = await this.traverse(path);
        let lastSlash = newPath.lastIndexOf("/");
        const parentOfNew = newPath.slice(0, lastSlash);
        const newName = newPath.slice(lastSlash + 1);
        const parent = await this.traverse(parentOfNew);

        
    }

    public async flushMetadataChanges(){
        return this.fat.flush();
    }

    public getUnderlying(){
        return this.fat;
    }
}

export class FatFSFileHandle {
    public length: number;
    constructor(private chain: Chain, private writable: boolean, private underlying: FatFSDirectoryEntry){
        this.length = underlying.fileSize;
    }

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
        // TODO
    }

    async write(data: Uint8Array){
        // TODO
    }
}
