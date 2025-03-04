export interface ChainLink {
    length: number;
    write?(data: Uint8Array): Promise<void>;
    read(): Promise<Uint8Array>;
}

export class ChainError extends Error{}
export type LinkAllocator<T> = (lastChainLink: T | null, bytes: number) => Promise<T[]>;

export class Chain<T extends ChainLink> {
    private currentLink?: T;
    private linkSubCursor?: number;
    private _cursor: number = 0;
    private linkIndex: number = 0;
    private writable: boolean;
    private totalLength: number;

    private set cursor(n: number){
        this._cursor = n;
        this.currentLink = undefined;
        this.linkSubCursor = undefined;
        
        let currentLength = 0;
        let idx = 0;
        for(let link of this._links){
            if ((link.length + currentLength) > n) {
                this.currentLink = link;
                this.linkSubCursor = n - currentLength;
                this.linkIndex = idx;
                break;
            }
            currentLength += link.length;
            ++idx;
        }
    }

    private get cursor() { return this._cursor; }
    public tell(){ return this.cursor; }
    public getTotalLength(){ return this.totalLength; }

    public get links() { return this._links; }

    constructor(protected _links: T[], protected allocateLink?: LinkAllocator<T>, protected readLimitSize?: number){
        this.writable = _links.every(e => !!e.write);
        this.cursor = 0;
        this.totalLength = readLimitSize ?? this.length();
    }

    length(): number {
        return this._links.reduce((a, b) => a + b.length, 0);
    }

    async seek(to: number, whence?: 'start' | 'cur' | 'end'): Promise<void> {
        // Regardless of the writing state, flush the buffer on-seek
        await this.flushChanges();
        if(whence === 'start' || !whence) this.cursor = to;
        else if(whence === 'cur') this.cursor += to;
        else if(whence === 'end') this.cursor = this.length() - to;
    }

    async read(count: number): Promise<Uint8Array> {
        count = Math.min(this.totalLength, count + this.cursor) - this.cursor;

        const ret = new Uint8Array(count);
        let currentLength = 0;

        while(currentLength < count){
            if(!this.currentLink || this.linkSubCursor === undefined) {
                break;
            }
            const thisLinkContents = await this.currentLink.read();
            const limited = thisLinkContents.slice(this.linkSubCursor, count - currentLength + this.linkSubCursor);
            ret.set(limited, currentLength);
            currentLength += limited.length;
            this._cursor += limited.length;
            this.linkSubCursor += limited.length;

            if(this.linkSubCursor >= this.currentLink.length){
                // Advance link.
                this.linkIndex++;
                this.linkSubCursor -= this.currentLink.length;
                this.currentLink = this._links[this.linkIndex];
            }
        }
        return ret.slice(0, currentLength);
    }

    async readAll(){
        return this.read(this.length() - this.cursor);
    }

    public async flushChanges(){
        return this.flushWritingBuffer();
    }

    private writingBuffer: Uint8Array | null = null;
    private isNewByteArray: boolean[] | null = null;
    private async flushWritingBuffer(){
        // Rewrite the current link with writingBuffer
        if(!this.writingBuffer) return;
        if(!this.currentLink) throw new ChainError("Invalid chain state (Assertion 1)");
        if(this.writingBuffer.length !== this.currentLink!.length) throw new ChainError("Invalid chain state (Assertion 2)");
        // Rewrite.
        // Depending on if we have any old bytes remaining, overlay the two buffers on one another. Otherwise just use the new one
        const isUsingAnyOldBytes = this.isNewByteArray!.some(e => e === false);
        let bufferToWrite;
        if(isUsingAnyOldBytes) {
            // Overlay
            const originalData = await this.currentLink!.read();
            for(let i = 0; i<originalData.length; i++){
                if(this.isNewByteArray![i]) {
                    originalData[i] = this.writingBuffer[i];
                }
            }
            bufferToWrite = originalData;
        } else {
            // The new buffer is the absolute authority
            bufferToWrite = this.writingBuffer;
        }
        await this.currentLink!.write!(bufferToWrite);
        this.writingBuffer = null;
        this.isNewByteArray = null;
    }

    async write(data: Uint8Array){
        if(!this.writable) throw new ChainError("Cannot write to a read-only chain!");
        let wholeChainLength = this.length();
        // Allocate all the required space first.
        while((this.cursor + data.length) > wholeChainLength){
            if(!this.allocateLink){
                throw new ChainError("No space!");
            }

            let newLinks = await this.allocateLink(this._links[this._links.length - 1] ?? null, (this.cursor + data.length) - wholeChainLength);
            if(!newLinks.length) throw new ChainError("Allocator can't allocate more links!");

            wholeChainLength += newLinks.reduce((a, b) => a + b.length, 0);
            this._links.push.apply(this._links, newLinks);
            // Update cursor
            this.cursor = this.cursor;
        }

        let incomingDataCursor = 0;
        while(incomingDataCursor < data.length){
            await this.cacheCurrentLinkForWriting();
            // Find the largest possible chunk of data to merge onto the writing buffer.
            const remainingSpaceInLinkDerivedFromCursor = this.currentLink!.length - this.linkSubCursor!;
            const dataLengthForThisLink = Math.min(remainingSpaceInLinkDerivedFromCursor, data.length - incomingDataCursor);
            // Get the slice.
            const slice = data.slice(incomingDataCursor, incomingDataCursor + dataLengthForThisLink);
            // Rewrite the slice to the new buffer, then advance
            this.writingBuffer!.set(slice, this.linkSubCursor!);
            this.isNewByteArray!.fill(true, this.linkSubCursor!, this.linkSubCursor! + slice.byteLength);
            // Would setting this new cursor advance to next link?
            if((this.linkSubCursor! + dataLengthForThisLink) >= this.currentLink!.length){
                // Flush it.
                await this.flushWritingBuffer();
            }
            this.cursor += dataLengthForThisLink;
            if(this.cursor > this.totalLength) this.totalLength = this.cursor;
            incomingDataCursor += dataLengthForThisLink;
        }
    }

    private async cacheCurrentLinkForWriting(){
        if(!this.writingBuffer){
            this.writingBuffer = new Uint8Array(this.currentLink!.length).fill(0);
            this.isNewByteArray = Array<boolean>(this.writingBuffer.length).fill(false);
        }
    }
}
