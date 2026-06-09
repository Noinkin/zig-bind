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
    public static threadCount: number = 4;
    private readonly exports: any;
    public memory: WebAssembly.Memory;
    private readonly encoder = new TextEncoder();
    private readonly decoder = new TextDecoder();

    constructor(wasmInstance: WebAssembly.Instance, memoryOverride?: WebAssembly.Memory) {
        this.exports = wasmInstance.exports;
        this.memory = memoryOverride || this.exports.memory;
    }

    static createSharedMemory(initialPages = 256, maxPages = 2048): WebAssembly.Memory {
        return new WebAssembly.Memory({
            initial: initialPages,
            maximum: maxPages,
            shared: true
        });
    }

    static async createImportObject(wasmModule: WebAssembly.Module, sharedMemory: WebAssembly.Memory): Promise<any> {
        const imports = WebAssembly.Module.imports(wasmModule);
        const usesWasi = imports.some(imp => imp.module === 'wasi_snapshot_preview1');
        
        const importObject: any = {
            env: { memory: sharedMemory }
        };

        if (usesWasi) {
            const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
            if (isNode) {
                const { WASI } = await import('wasi');
                const wasi = new WASI({ version: 'preview1', args: [], env: process.env });
                importObject.wasi_snapshot_preview1 = wasi.wasiImport;
                importObject.__wasi_instance__ = wasi; 
            } else {
                if (typeof (globalThis as any).WASI !== 'undefined') {
                    const wasi = new (globalThis as any).WASI();
                    importObject.wasi_snapshot_preview1 = wasi.wasiImport;
                    importObject.__wasi_instance__ = wasi;
                } else {
                    importObject.wasi_snapshot_preview1 = new Proxy({}, {
                        get: () => () => 0
                    });
                }
            }
        }

        return importObject;
    }

    static async instantiateModule(wasmModule: WebAssembly.Module, sharedMemory: WebAssembly.Memory): Promise<WebAssembly.Instance> {
        const importObject = await ZigBindRegistry.createImportObject(wasmModule, sharedMemory);
        const instance = await WebAssembly.instantiate(wasmModule, importObject);
        
        if (importObject.__wasi_instance__) {
            const wasi = importObject.__wasi_instance__;
            
            if (typeof wasi.finalizeBindings === 'function') {
                wasi.finalizeBindings(instance, { memory: sharedMemory });
            } else if (typeof wasi.initialize === 'function') {
                if (instance.exports._start === undefined) {
                    wasi.initialize(instance);
                }
            }
        }
        return instance;
    }

    static async initNativeThreads(wasmModule: WebAssembly.Module, sharedMemory: WebAssembly.Memory, threadCount?: number): Promise<void> {
        const imports = WebAssembly.Module.imports(wasmModule);
        const usesWasi = imports.some(imp => imp.module === 'wasi_snapshot_preview1');

        const count = threadCount || (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : require('os').cpus().length || 4);
        ZigBindRegistry.threadCount = count;

        const STACK_SIZE = 65536;
        const WORKER_STACK_BASE = 1024 * 1024 * 16;

        const workerCode = `
            const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
            const channel = isNode ? require('worker_threads').parentPort : self;
            
            const onMessage = async (msg) => {
                const data = msg.data !== undefined ? msg.data : msg;
                if (data.type === 'start') {
                    const importObject = {
                        env: { memory: data.memory }
                    };

                    let wasiInstance = null;
                    if (data.usesWasi) {
                        if (isNode) {
                            const { WASI } = require('wasi');
                            wasiInstance = new WASI({ version: 'preview1', args: [], env: process.env });
                            importObject.wasi_snapshot_preview1 = wasiInstance.wasiImport;
                        } else {
                            if (typeof self.WASI !== 'undefined') {
                                wasiInstance = new self.WASI();
                                importObject.wasi_snapshot_preview1 = wasiInstance.wasiImport;
                            } else {
                                importObject.wasi_snapshot_preview1 = new Proxy({}, {
                                    get: () => () => 0
                                });
                            }
                        }
                    }

                    const instance = await WebAssembly.instantiate(data.module, importObject);

                    if (wasiInstance) {
                        if (typeof wasiInstance.finalizeBindings === 'function') {
                            wasiInstance.finalizeBindings(instance, { memory: data.memory });
                        } else if (typeof wasiInstance.initialize === 'function') {
                            const wrappedInstance = new Proxy(instance, {
                                get(target, prop) {
                                    if (prop === 'exports') {
                                        return new Proxy(target.exports, {
                                            get(expTarget, expProp) {
                                                if (expProp === 'memory') return data.memory;
                                                return expTarget[expProp];
                                            }
                                        });
                                    }
                                    return target[prop];
                                }
                            });
                            wasiInstance.initialize(wrappedInstance);
                        }
                    }

                    if (instance.exports.__stack_pointer) {
                        const uniqueStackPtr = data.stackBase + (data.threadId * data.stackSize);
                        instance.exports.__stack_pointer.value = uniqueStackPtr;
                    }

                    instance.exports.zig_bind_worker_loop();
                }
            };
            
            if (isNode) { channel.on('message', onMessage); } else { channel.onmessage = onMessage; }
        `;

        const createWorker = async (code: string) => {
            if (typeof window === 'undefined' && typeof process !== 'undefined') {
                const { Worker } = await import('worker_threads');
                return new Worker(code, { eval: true });
            } else {
                const blob = new Blob([code], { type: 'application/javascript' });
                return new Worker(URL.createObjectURL(blob));
            }
        };

        for (let i = 0; i < count; i++) {
            const worker = await createWorker(workerCode);
            worker.postMessage({ 
                type: 'start', 
                module: wasmModule, 
                memory: sharedMemory,
                threadId: i,
                stackBase: WORKER_STACK_BASE,
                stackSize: STACK_SIZE,
                usesWasi: usesWasi
            });
        }
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