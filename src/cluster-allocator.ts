import { ChainLink } from "./chained-structures";
import { ClusterChainLink } from "./cluster-chain";

class FreeClusterChain {

}

export class ClusterAllocator {
    public async allocate(lastLink: ChainLink): Promise<ClusterChainLink>{
        throw new Error("TODO");
    }
}