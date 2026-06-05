export type ZigBindType = 'f32' | 'u32' | 'u8';

export type ZigVector<T extends ZigBindType> = (
    T extends 'f32' ? Float32Array : 
    T extends 'u32' ? Uint32Array : 
    Uint8Array
) & { ptr: number };

const TYPE_SIZES: Record<ZigBindType, number> = { 'f32': 4, 'u32': 4, 'u8': 1 };
const VIEW_TYPES: Record<ZigBindType, any> = { 'f32': Float32Array, 'u32': Uint32Array, 'u8': Uint8Array };

/**
 * Zig/WASM binding registry
 */
export class ZigBindRegistry {
    private exports: any;
    public memory: WebAssembly.Memory;
    
    private viewCache = new Map<number, any>();
    private lastBufferRef: ArrayBuffer | null = null;

    constructor(wasmInstance: WebAssembly.Instance) {
        this.exports = wasmInstance.exports;
        this.memory = this.exports.memory;
    }

    /**
     * Allocates a slice of memory
     */
    alloc<T extends ZigBindType>(type: T, source: number | number[] | Float32Array | Uint32Array | Uint8Array): ZigVector<T> {
        const isArray = Array.isArray(source) || ArrayBuffer.isView(source);
        const size = isArray ? (source as any).length : (source as number);
        
        const byteLength = size * TYPE_SIZES[type];
        const ptr = this.exports.zig_bind_alloc(byteLength);
        
        if (this.memory.buffer !== this.lastBufferRef) {
            this.viewCache.clear();
            this.lastBufferRef = this.memory.buffer;
        }

        let view = this.viewCache.get(ptr);
        
        if (!view || view.length !== size || view.constructor !== VIEW_TYPES[type]) {
            view = new VIEW_TYPES[type](this.memory.buffer, ptr, size) as any;
            view.ptr = ptr;
            this.viewCache.set(ptr, view);
        }
        
        if (isArray) {
            view.set(source as any);
        }
        
        return view;
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