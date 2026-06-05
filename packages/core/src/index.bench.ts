import { Bench } from 'tinybench';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ZigBindRegistry } from './index.js';

const __dirname = import.meta.dirname;

async function runBenchmarkSuite() {
    const testCustomZigFile = path.join(__dirname, 'custom_math_bench.zig');
    const testWasmOutputDir = path.join(__dirname, 'dist_bench');
    const expectedWasmFile = path.join(testWasmOutputDir, 'custom_math_bench.wasm');
    const cliBinaryPath = path.resolve(__dirname, '../dist/cli.cjs');

    console.log('⚡ Compiling Zig binaries for benchmark profiles...');

    const customZigContent = `
        const std = @import("std");
        const zb = @import("zig_bind");

        export fn zig_bind_alloc(bytes: usize) [*]u8 { return zb.alloc(bytes); }
        export fn zig_bind_reset() void { zb.reset(); }

        export fn add_vectors(a_ptr: [*]f32, b_ptr: [*]f32, c_ptr: [*]f32, len: usize) void {
            var i: usize = 0;
            while (i < len) : (i += 1) {
                c_ptr[i] = a_ptr[i] + b_ptr[i];
            }
        }

        export fn scale_vector(input_ptr: [*]f32, output_ptr: [*]f32, len: usize) void {
            var i: usize = 0;
            while (i < len) : (i += 1) {
                output_ptr[i] = input_ptr[i] * 2.5;
            }
        }
    `;

    fs.writeFileSync(testCustomZigFile, customZigContent);
    execSync(`node "${cliBinaryPath}" build "${testCustomZigFile}" --out "${testWasmOutputDir}"`);

    const wasmBuffer = fs.readFileSync(expectedWasmFile);
    const wasmModule = new WebAssembly.Module(wasmBuffer);
    const wasmInstance = new WebAssembly.Instance(wasmModule, {});
    const exports = wasmInstance.exports as any;
    const memory = exports.memory as WebAssembly.Memory;
    const registry = new ZigBindRegistry(wasmInstance);

    // SUITE 1
    const VECTOR_SIZE = 50000;
    const mockDataA = new Float32Array(VECTOR_SIZE).fill(10.5);
    const mockDataB = new Float32Array(VECTOR_SIZE).fill(2.5);

    const vecA = registry.alloc('f32', VECTOR_SIZE);
    const vecB = registry.alloc('f32', VECTOR_SIZE);
    const vecC = registry.alloc('f32', VECTOR_SIZE);
    const addVectorsAction = registry.bind('add_vectors');

    const aPtr = exports.zig_bind_alloc(VECTOR_SIZE * 4);
    const bPtr = exports.zig_bind_alloc(VECTOR_SIZE * 4);
    const cPtr = exports.zig_bind_alloc(VECTOR_SIZE * 4);
    const aViewIdx = aPtr / 4;
    const bViewIdx = bPtr / 4;
    const cViewIdx = cPtr / 4;

    const jsAddResult = new Float32Array(VECTOR_SIZE);

    // SUITE 2
    const MAP_SIZE = 100000;

    const nativeSourceArray = Array.from({ length: MAP_SIZE }, () => Math.random());

    const mapInputVector = registry.alloc('f32', nativeSourceArray);
    const mapOutputVector = registry.alloc('f32', MAP_SIZE);
    const scaleVectorAction = registry.bind('scale_vector');

    const mapInPtr = exports.zig_bind_alloc(MAP_SIZE * 4);
    const mapOutPtr = exports.zig_bind_alloc(MAP_SIZE * 4);
    const mapInViewIdx = mapInPtr / 4;
    const mapOutViewIdx = mapOutPtr / 4;


    // BENCHMARK 1: VECTOR ADDITION (50K)
    const vectorBench = new Bench({ time: 500 });
    
    vectorBench
        .add('Zig-Bind: Zero-Copy', () => {
            vecA.set(mockDataA);
            vecB.set(mockDataB);
            addVectorsAction(vecA, vecB, vecC, VECTOR_SIZE);
            const _res = vecC[0];
        })
        .add('Traditional: WASM Copying', () => {
            const heapF32 = new Float32Array(memory.buffer);
            heapF32.set(mockDataA, aViewIdx);
            heapF32.set(mockDataB, bViewIdx);
            exports.add_vectors(aPtr, bPtr, cPtr, VECTOR_SIZE);
            const _resultArray = heapF32.slice(cViewIdx, cViewIdx + VECTOR_SIZE);
        })
        .add('Default JS: TypedArray Loop', () => {
            for (let i = 0; i < VECTOR_SIZE; i++) {
                jsAddResult[i] = mockDataA[i]! + mockDataB[i]!;
            }
            const _res = jsAddResult[0];
        });


    // BENCHMARK 2: LARGE MAP TRANSFORMATION (100K)
    const mapBench = new Bench({ time: 500 });

    mapBench
        .add('Zig-Bind: Zero-Copy View', () => {
            scaleVectorAction(mapInputVector, mapOutputVector, MAP_SIZE);
            const _res = mapOutputVector[0];
        })
        .add('Traditional: WASM Copying', () => {
            const heapF32 = new Float32Array(memory.buffer);
            heapF32.set(nativeSourceArray, mapInViewIdx);
            exports.scale_vector(mapInPtr, mapOutPtr, MAP_SIZE);
            const _resultArray = heapF32.slice(mapOutViewIdx, mapOutViewIdx + MAP_SIZE);
        })
        .add('Native JS: Array.prototype.map()', () => {
            const _result = nativeSourceArray.map(x => x * 2.5);
        });


    // DISPLAY
    console.log('\n🚀 Running Suite 1: Vector Addition (50k elements)...');
    await vectorBench.run();
    console.table(vectorBench.table());

    console.log('\n🔥 Running Suite 2: Crazy Map Transformation (100k elements)...');
    await mapBench.run();
    console.table(mapBench.table());

    if (fs.existsSync(testCustomZigFile)) fs.unlinkSync(testCustomZigFile);
    if (fs.existsSync(expectedWasmFile)) fs.unlinkSync(expectedWasmFile);
    if (fs.existsSync(testWasmOutputDir)) fs.rmdirSync(testWasmOutputDir);
}

runBenchmarkSuite().catch(console.error);