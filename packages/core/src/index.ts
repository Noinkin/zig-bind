export type ZigBindType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';

export type ZigVector<T extends ZigBindType> = (
    T extends 'u8' ? Uint8Array : T extends 'i8' ? Int8Array :
    T extends 'u16' ? Uint16Array : T extends 'i16' ? Int16Array :
    T extends 'u32' ? Uint32Array : T extends 'i32' ? Int32Array :
    T extends 'f32' ? Float32Array : Float64Array
) & { ptr: number };

const TYPE_METADATA: Record<ZigBindType, { Ctor: any, size: number }> = {
    'u8': { Ctor: Uint8Array, size: 1 }, 'i8': { Ctor: Int8Array, size: 1 },
    'u16': { Ctor: Uint16Array, size: 2 }, 'i16': { Ctor: Int16Array, size: 2 },
    'u32': { Ctor: Uint32Array, size: 4 }, 'i32': { Ctor: Int32Array, size: 4 },
    'f32': { Ctor: Float32Array, size: 4 }, 'f64': { Ctor: Float64Array, size: 8 }
};

/**
 * Zig/WASM binding registry
 */
export class ZigBindRegistry {
    private readonly exports: any;
    public memory: WebAssembly.Memory;
    private readonly encoder = new TextEncoder();
    private readonly decoder = new TextDecoder();

    constructor(wasmInstance: WebAssembly.Instance, memoryOverride?: WebAssembly.Memory) {
        this.exports = wasmInstance.exports;
        this.memory = memoryOverride || this.exports.memory;
    }

    /**
     * Allocates a slice of memory
     */
    alloc<T extends ZigBindType>(type: T, source: number | number[] | Float32Array | Uint32Array | Uint8Array): ZigVector<T> {
        const meta = TYPE_METADATA[type];
        const isArray = Array.isArray(source) || ArrayBuffer.isView(source);
        const size = isArray ? (source as any).length : (source as number);
        
        const ptr = this.exports.zig_bind_alloc(size * meta.size);
        if (ptr === 0 || ptr === null) throw new Error(`Out of Memory! Failed to allocate ${size} bytes.`);
        const view = new meta.Ctor(this.memory.buffer, ptr, size) as any;
        view.ptr = ptr;

        if (isArray) view.set(source as any);
        return view;
    }

    writeString(str: string): { ptr: number, len: number } {
        const bytes = this.encoder.encode(str);
        const vec = this.alloc('u8', bytes);
        return { ptr: vec.ptr, len: bytes.length };
    }

    writeObject(obj: any): { ptr: number, len: number } {
        return this.writeString(JSON.stringify(obj));
    }

    readString(ptr: number, len: number): string {
        const bytes = new Uint8Array(this.memory.buffer, ptr, len);
        return this.decoder.decode(bytes);
    }

    /**
     * Binds a WASM function by string name to a JavaScript function.
     */
    bind(functionName: string): (...args: any[]) => any {
        const fn = this.exports[functionName];
        if (!fn) throw new Error(`Function '${functionName}' not found.`);
        
        const expectedArgsCount = fn.length;

        return (...args: any[]) => {
            const len = args.length;

            if (len < expectedArgsCount && args[0] && args[0].ptr !== undefined) {
                const autoLen = args[0].length;
                if (len === 1) return fn(args[0].ptr, autoLen);
                if (len === 2) return fn(args[0].ptr, args[1].ptr !== undefined ? args[1].ptr : args[1], autoLen);
                if (len === 3) return fn(args[0].ptr, args[1].ptr, args[2].ptr, autoLen);
                if (len === 4) return fn(args[0].ptr, args[1].ptr, args[2].ptr, args[3].ptr, autoLen);
            }

            if (len === 1) return fn(args[0].ptr !== undefined ? args[0].ptr : args[0]);
            if (len === 2) return fn(args[0].ptr !== undefined ? args[0].ptr : args[0], args[1].ptr !== undefined ? args[1].ptr : args[1]);
            if (len === 3) return fn(args[0].ptr !== undefined ? args[0].ptr : args[0], args[1].ptr !== undefined ? args[1].ptr : args[1], args[2].ptr !== undefined ? args[2].ptr : args[2]);
            if (len === 4) return fn(args[0].ptr !== undefined ? args[0].ptr : args[0], args[1].ptr !== undefined ? args[1].ptr : args[1], args[2].ptr !== undefined ? args[2].ptr : args[2], args[3].ptr !== undefined ? args[3].ptr : args[3]);

            const mapped = args.map(a => (a && a.ptr !== undefined ? a.ptr : a));
            if (mapped.length < expectedArgsCount && args[0] && args[0].length !== undefined) {
                mapped.push(args[0].length);
            }
            return fn(...mapped);
        };
    }

    reset(): void { 
        this.exports.zig_bind_reset(); 
    }
}