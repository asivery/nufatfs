import { FatError } from "./low-level";

export type StructFormatResult = string | number | Uint8Array;

enum Endianness {
    BIG, LITTLE
};

const TypeSizeMap: { [key: string]: number } = {
    b: 1,
    c: 1,
    h: 2,
    i: 4,
    l: 4,
    q: 8,
}

export function structFormatUnpack(format: string, data: Uint8Array, offset = 0): StructFormatResult[] {
    let output: StructFormatResult[] = [];
    let endianness = Endianness.BIG;
    let _format = format.split('');
    const next = () => _format.splice(0, 1)[0];
    const peek = () => _format[0];

    if(['<', '>', '@'].includes(peek())){
        let modifier = next();
        if(modifier === '<') endianness = Endianness.LITTLE;
    }

    let repeat = 0;
    let dataIndex = offset;
    while(_format.length){
        let char = next();
        if("1234567890".includes(char)){
            // Is a repeat value.
            repeat *= 10;
            repeat += parseInt(char);
            continue;
        }
        if(char === 'x'){
            // Padding
            dataIndex += Math.max(1, repeat);
            repeat = 0;
            continue;
        }else if(char.toLowerCase() in TypeSizeMap){
            // A simple integer
            let byteCount = TypeSizeMap[char.toLowerCase()];
            for(let i = 0; i<Math.max(1, repeat); i++){
                let resultingInteger = 0;
                let bytes = data.slice(dataIndex, dataIndex + byteCount);
                dataIndex += byteCount;
                // Form an integer
                for(let j = 0; j < byteCount; j++){
                    let index = endianness === Endianness.LITTLE ? (byteCount - 1 - j) : j;
                    let byte = bytes[index];
                    resultingInteger = (resultingInteger << 8) | byte;
                }
                // Apply two's compliment if needed.
                if(char.toLowerCase() !== char){
                    // Is upper-case, so unsigned
                    let signBitMask = (1 << (byteCount * 8 - 1));
                    if(resultingInteger & signBitMask){
                        // It's a negative number.
                        resultingInteger = (resultingInteger & (signBitMask - 1)) - signBitMask;
                    }
                }
                output.push(resultingInteger);
            }
            repeat = 0;
        }else if(char == 's'){
            // String.
            output.push(data.slice(dataIndex, dataIndex += repeat));
            repeat = 0;
        }else{
            console.log(`Unknown format char: ${char}`);
        }
    }
    return output;
}

export function arraysEq<T>(a: ArrayLike<T>, b: ArrayLike<T>){
    if(a.length !== b.length) return false;
    for(let i = 0; i<a.length; i++){
        if(a[i] !== b[i]) return false;
    }
    return true;
}

export function splitExt(name: string): [string, string]{
    const index = name.lastIndexOf('.');
    return index === -1 ? [name, ''] : [name.slice(0, index), name.slice(index + 1)];
}

export function splitExt83(name: string): [string, string]{
    if(name.length !== 8+3){
        throw new FatError("Invalid 8.3 file name");
    }
    return [name.slice(0, 8).trim(), name.slice(8).trim()];
}

export function name83toNormal(_name: string){
    const [name, ext] = splitExt83(_name);
    return ext === '' ? name : (name + '.' + ext);
}

export function namesEqual(normalName: string, name83: string){
    const [name1, ext1] = splitExt(normalName);
    const [name2, ext2] = splitExt83(name83);
    return name1.toLowerCase() === name2.toLowerCase() && ext1.toLowerCase() === ext2.toLowerCase();
}

export function nameNormalTo83(normalName: string): string {
    let [name, ext] = splitExt(normalName);
    if(name.length > 8) name = name.substring(0, 8);
    if(ext.length > 3) ext = ext.substring(0, 3);
    for(let i = name.length; i<8; i++) name += ' ';
    for(let i = ext.length; i<3; i++) ext += ' ';
    name += ext;
    return name;
}
