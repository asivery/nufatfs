import { ChainLink } from "./chained-structures";
import { LowLevelFatFilesystem } from "./low-level";

export class ClusterChainLink implements ChainLink {
    constructor(private fat: LowLevelFatFilesystem, public index: number, public length: number){}
    async read(){
        return this.fat.readClusters(this.index, 1);
    }
    
    async write(data: Uint8Array){
        const actualClusterSize = this.fat.clusterSizeInBytes;
        if(data.length !== actualClusterSize){
            const oldData = data;
            data = new Uint8Array(actualClusterSize);
            data.fill(0, oldData.length);
            data.set(oldData, 0);
        }
        await this.fat.writeClusters(this.index, data);
    }
}
