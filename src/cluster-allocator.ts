import { Chain } from "./chained-structures";
import { ClusterChainLink } from "./cluster-chain";
import { FAT_MARKER_DELETED, FORBIDDEN_ATTRIBUTES_FOR_FILE, LowLevelFatFilesystem } from "./low-level";
import { FatFSDirectoryEntry, FatFSDirectoryEntryAttributes } from "./types";

export interface FreeClusterChain {
    startCluster: number,
    length: number,
}

export class ClusterAllocator {
    public freelist: FreeClusterChain[] = [];
    // Freemap: true if free, false if taken
    public freemap: boolean[] = [];

    private constructor(private fat: LowLevelFatFilesystem) {}
    public static async create(fat: LowLevelFatFilesystem) {
        const c = new ClusterAllocator(fat);
        await c.init();
        return c;
    }
    
    private async init(){
        const fatEntriesCount = (this.fat.logicalSectorsPerFat * this.fat.driver.sectorSize) / (this.fat.isFat16 ? 2 : 4);
        this.freemap = Array<boolean>(fatEntriesCount).fill(true);
        // Clusters 0 and 1 are always taken.
        this.freemap[0] = false;
        this.freemap[1] = false;

        // COMMENTED OUT: It appears I might have entirely misunderstood FAT's idea of file deletion.

        // Iterate over the files, mark free when iterating over the files
        // const consumeChain = (chain: Chain<ClusterChainLink>) => chain.links.forEach(e => this.freemap[e.index] = false);
        // const consumeDirectory = async (cluster: number, isRoot = false) => {
        //     let thisEntry: FatFSDirectoryEntry[];
        //     if(isRoot) {
        //         thisEntry = await this.fat.getRootDirectoryData();
        //     }else {
        //         const chain = this.fat.constructClusterChain(cluster, false);
        //         // Add the whole raw entry as a non-free region
        //         consumeChain(chain);
        //         thisEntry = this.fat.consumeAllDirectoryEntries(await chain.readAll());
        //     }
            

        //     for(let subentry of thisEntry) {
        //         const initialCluster = subentry.firstClusterAddressLow | (subentry.firstClusterAddressHigh << 16);
        //         if(initialCluster === 0) {
        //             // Empty file
        //             continue;
        //         }
        //         const isDirectory = subentry.attribs & FatFSDirectoryEntryAttributes.Directory;
        //         if(isDirectory && !(["..", "."].includes(subentry._filenameStr.trim()))) {
        //             await consumeDirectory(initialCluster);
        //         } else if (!(subentry.attribs & FORBIDDEN_ATTRIBUTES_FOR_FILE)) {
        //             // Is a file.
        //             // Construct a chain, then mark it as taken if it's not deleted
        //             if(subentry.filename[0] !== FAT_MARKER_DELETED){
        //                 const chain = this.fat.getClusterChainFromFAT(initialCluster);
        //                 chain.forEach(e => this.freemap[e] = false);
        //             }
        //         }
        //     }
        // };

        // await consumeDirectory(-1, true)

        for(let i = 2; i < (this.fat.fatContents!.byteLength / (this.fat.isFat16 ? 2 : 4)); i++) {
            this.freemap[i] = this.fat.readFATClusterEntry!(i) == 0;
        }

        this.convertFreemapToFreelist();
    }

    public convertFreemapToFreelist() {
        this.freelist = [];

        let nextFree = 0;
        while((nextFree = this.freemap.indexOf(true, nextFree)) !== -1){
            let length = 0;
            const startCluster = nextFree;
            while(this.freemap[nextFree++]) ++length;
            this.freelist.push({ length, startCluster })
        }
    }

    public addChainToFreelist(chain: Chain<ClusterChainLink>) {
        chain.links.forEach(e => this.freemap[e.index] = true); // Mark as free
        this.convertFreemapToFreelist();
    }

    public addClusterListToFreelist(list: number[]) {
        list.forEach(e => this.freemap[e] = true);
        this.convertFreemapToFreelist();
    }

    public allocate(lastLink: ClusterChainLink | null, size: number): ClusterChainLink[] {
        console.log(`[NUFATFS]: Trying to allocate ${size} bytes after ${lastLink?.index || '<unspecified>'}`);
        if(!this.freelist) return [];
        // Try to find an area that's big enough to house the whole `size`
        const sizeAsClusters = Math.ceil(size / this.fat.clusterSizeInBytes);
        const allFitting = this.freelist.filter(e => e.length >= sizeAsClusters);
        const findClosest = (list: FreeClusterChain[]) => {
            if(lastLink) {
                list.sort((a, b) => Math.abs(a.startCluster - lastLink.index) - Math.abs(b.startCluster - lastLink.index));
            }
        };
        findClosest(allFitting);
        let chainToModify: FreeClusterChain;

        if(allFitting) {
            // There exists such a chain
            chainToModify = allFitting[0];
        } else {
            let clone = this.freelist.slice();
            findClosest(clone);
            chainToModify = clone[0];
        }
        chainToModify.length -= sizeAsClusters;
        const startIndex = chainToModify.startCluster;
        chainToModify.startCluster += sizeAsClusters;
        if(chainToModify.length === 0){
            // Delete from freelist
            this.freelist.splice(this.freelist.indexOf(chainToModify), 1);
        }
        let links: ClusterChainLink[] = [];
        let remainingSize = size;
        for(let i = startIndex; i<startIndex+sizeAsClusters; i++) {
            const link = new ClusterChainLink(this.fat, i, this.fat.clusterSizeInBytes);
            links.push(link);
            this.freemap[i] = false;
            remainingSize -= link.length;
        }
        console.log(`[NUFATFS]: Allocated chain: ${links.map(e => e.index).join(', ')}`);
        for(let i = 1; i<links.length; i++){
            // Update the main FAT
            this.fat.writeFATClusterEntry!(links[i - 1].index, links[i].index);
        }
        this.fat.writeFATClusterEntry!(links[links.length - 1].index, this.fat.endOfChain);
        if(lastLink){
            // Merge chains if possible.
            this.fat.writeFATClusterEntry!(lastLink.index, links[0].index);
        }
        return links;
    }
}
