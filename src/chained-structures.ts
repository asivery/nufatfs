export interface ChainLink {
    length: number;
    write?(data: Uint8Array): Promise<void>;
    read(): Promise<Uint8Array>;
}

export class ChainError extends Error{}

export class Chain {
    private currentLink?: ChainLink;
    private linkSubCursor?: number;
    private _cursor: number = 0;
    private linkIndex: number = 0;
    private writable: boolean;

    private set cursor(n: number){
        this._cursor = n;
        this.currentLink = undefined;
        this.linkSubCursor = undefined;
        
        let currentLength = 0;
        let idx = 0;
        for(let link of this.links){
            if (currentLength >= n) {
                this.currentLink = link;
                this.linkSubCursor = currentLength - n;
                this.linkIndex = idx;
                break;
            }
            currentLength += link.length;
            ++idx;
        }
    }

    private get cursor() { return this._cursor; }

    constructor(protected links: ChainLink[], protected allocateLink?: (lastLink: ChainLink) => Promise<ChainLink>){
        this.writable = links.every(e => !!e.write);
        this.cursor = 0;
    }

    length(): number {
        return this.links.reduce((a, b) => a + b.length, 0);
    }

    seek(to: number, whence?: 'start' | 'cur' | 'end'): void {
        if(whence === 'start' || !whence) this.cursor = to;
        else if(whence === 'cur') this.cursor += to;
        else if(whence === 'end') this.cursor = this.length() - to;
    }

    async read(count: number): Promise<Uint8Array> {
        const ret = new Uint8Array(count);
        let currentLength = 0;

        while(currentLength < count){
            if(!this.currentLink || this.linkSubCursor === undefined) {
                return ret.slice(0, currentLength);
            }
            const thisLinkContents = await this.currentLink.read();
            const limited = thisLinkContents.slice(this.linkSubCursor, Math.min(count - currentLength + this.linkSubCursor, this.currentLink.length));
            ret.set(limited, currentLength);
            currentLength += limited.length;
            this.linkSubCursor += limited.length;

            if(this.linkSubCursor >= this.currentLink.length){
                // Advance link.
                this.linkIndex++;
                this.linkSubCursor -= this.currentLink.length;
                this.currentLink = this.links[this.linkIndex];
                this._cursor += limited.length;
            }
        }
        return ret.slice(0, currentLength);
    }

    async readAll(){
        return this.read(this.length() - this.cursor);
    }

    async write(data: Uint8Array){
        if(!this.writable) throw new ChainError("Cannot write to a read-only chain!");
        let wholeChainLength = this.length();
        // Allocate all the required space first.
        if((this.cursor + data.length) > wholeChainLength){
            if(!this.allocateLink){
                throw new ChainError("No space!");
            }
            
            let newLink = await this.allocateLink(this.links[this.links.length - 1]);
            wholeChainLength += newLink.length;
            this.links.push(newLink);
        }

        let incomingCursor = 0;

        while(incomingCursor > data.length){
            if(!this.currentLink || this.linkSubCursor === undefined) {
                // Suddenly the chain got broken
                throw new ChainError("Chain state changed within write()!");
            }
            const thisLinkCount = Math.min(data.length - incomingCursor + this.linkSubCursor, this.currentLink.length);
            const thisLinkNewContents = data.slice(incomingCursor, incomingCursor + thisLinkCount);
            this.currentLink.write!(thisLinkNewContents);
            incomingCursor += thisLinkCount;
            this.linkSubCursor += thisLinkCount;

            if(this.linkSubCursor >= this.currentLink.length){
                // Advance link.
                this.linkIndex++;
                this.linkSubCursor -= this.currentLink.length;
                this.currentLink = this.links[this.linkIndex];
                this._cursor += thisLinkCount;
            }
        }
    }

    async flushWritingBuffer(){
        // TODO
    }
}
