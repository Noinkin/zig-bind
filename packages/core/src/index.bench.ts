import { Bench } from 'tinybench';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ZigBindRegistry } from './index.js';
import { WASI } from 'wasi';

const wasi = new WASI({
    version: 'preview1',
    args: process.argv,
    env: process.env
});

const __dirname = import.meta.dirname;

async function runBenchmarkSuite() {
    const testCustomZigFile = path.join(__dirname, 'custom_math_bench.zig');
    const testWasmOutputDir = path.join(__dirname, 'dist_bench');
    const expectedWasmFile = path.join(__dirname, 'dist_bench.wasm');
    const expectedDTSFile = path.join(__dirname, 'dist_bench.d.ts');
    const expectedJSFile = path.join(__dirname, 'dist_bench.js');
    const cliBinaryPath = path.resolve(__dirname, '../dist/cli.js');

    console.log('⚡ Compiling Zig binaries for benchmark profiles...');

    const customZigContent = `
        const std = @import("std");
        const zb = @import("zig_bind");

        pub export fn add_vectors(a_ptr: [*]f32, b_ptr: [*]f32, c_ptr: [*]f32, len: usize) void {
            var i: usize = 0;
            while (i < len) : (i += 1) { c_ptr[i] = a_ptr[i] + b_ptr[i]; }
        }

        pub export fn scale_vector(input_ptr: [*]f32, output_ptr: [*]f32, len: usize) void {
            var i: usize = 0;
            while (i < len) : (i += 1) { output_ptr[i] = input_ptr[i] * 2.5; }
        }

        pub export fn matrix_multiply_serial(matrix_a: [*]f32, matrix_b: [*]f32, result: [*]f32, size: usize) void {
            for (0..size) |row| {
                for (0..size) |col| {
                    var sum: f32 = 0;
                    for (0..size) |k| { sum += matrix_a[row * size + k] * matrix_b[k * size + col]; }
                    result[row * size + col] = sum;
                }
            }
        }

        pub export fn matrix_multiply_parallel(matrix_a: [*]f32, matrix_b: [*]f32, result: [*]f32, size: usize, thread_count: usize) void {
            const Closure = struct {
                a: [*]f32, b: [*]f32, r: [*]f32, s: usize,
                fn chunk(ctx: ?*anyopaque, start_row: usize, end_row: usize) void {
                    const self = @as(*@This(), @ptrCast(@alignCast(ctx.?)));
                    const s = self.s;
                    
                    for (start_row..end_row) |i| {
                        // Zero out row safely before accumulation
                        @memset(self.r[i * s .. (i + 1) * s], 0);
                        for (0..s) |k| {
                            const val_a = self.a[i * s + k];
                            for (0..s) |j| {
                                self.r[i * s + j] += val_a * self.b[k * s + j];
                            }
                        }
                    }
                }
            };
            var context = Closure{ .a = matrix_a, .b = matrix_b, .r = result, .s = size };

            const grain_size = (size + thread_count - 1) / thread_count;
            zb.parallelFor(&context, size, grain_size, Closure.chunk);
        }
    `;

    fs.writeFileSync(testCustomZigFile, customZigContent);
    execSync(`node "${cliBinaryPath}" build "${testCustomZigFile}" --out "${testWasmOutputDir}" --shared`);

    const wasmBuffer = fs.readFileSync(expectedWasmFile);
    
    const sharedMemory = ZigBindRegistry.createSharedMemory(1281, 4096);
    const wasmModule = await WebAssembly.compile(wasmBuffer);

    await ZigBindRegistry.initNativeThreads(wasmModule, sharedMemory);

    const mainInstance = await ZigBindRegistry.instantiateModule(wasmModule, sharedMemory);
    
    const exports = mainInstance.exports as any;
    const registry = new ZigBindRegistry(mainInstance, sharedMemory);

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

    const MAP_SIZE = 100000;
    const nativeSourceArray = Array.from({ length: MAP_SIZE }, () => Math.random());
    const mapInputVector = registry.alloc('f32', nativeSourceArray);
    const mapOutputVector = registry.alloc('f32', MAP_SIZE);
    const scaleVectorAction = registry.bind('scale_vector');

    const mapInPtr = exports.zig_bind_alloc(MAP_SIZE * 4);
    const mapOutPtr = exports.zig_bind_alloc(MAP_SIZE * 4);
    const mapInViewIdx = mapInPtr / 4;
    const mapOutViewIdx = mapOutPtr / 4;

    const MATRIX_SIZE = 128;
    const matrixCells = MATRIX_SIZE * MATRIX_SIZE;
    const initMatA = Array.from({ length: matrixCells }, () => Math.random());
    const initMatB = Array.from({ length: matrixCells }, () => Math.random());

    const matA = registry.alloc('f32', initMatA);
    const matB = registry.alloc('f32', initMatB);
    const matResultSerial = registry.alloc('f32', matrixCells);
    const matResultParallel = registry.alloc('f32', matrixCells);

    const matMultiplySerial = registry.bind('matrix_multiply_serial');
    const matMultiplyParallel = registry.bind('matrix_multiply_parallel');

    const vectorBench = new Bench({ time: 500 });
    vectorBench
        .add('Zig-Bind: Zero-Copy', () => {
            vecA.set(mockDataA); vecB.set(mockDataB);
            addVectorsAction(vecA, vecB, vecC, VECTOR_SIZE);
            const _res = vecC[0];
        })
        .add('Traditional: WASM Copying', () => {
            const heapF32 = new Float32Array(sharedMemory.buffer);
            heapF32.set(mockDataA, aViewIdx); heapF32.set(mockDataB, bViewIdx);
            exports.add_vectors(aPtr, bPtr, cPtr, VECTOR_SIZE);
            const _resultArray = heapF32.slice(cViewIdx, cViewIdx + VECTOR_SIZE);
        })
        .add('Default JS: TypedArray Loop', () => {
            for (let i = 0; i < VECTOR_SIZE; i++) { jsAddResult[i] = mockDataA[i]! + mockDataB[i]!; }
            const _res = jsAddResult[0];
        });

    const mapBench = new Bench({ time: 500 });
    mapBench
        .add('Zig-Bind: Zero-Copy View', () => {
            scaleVectorAction(mapInputVector, mapOutputVector, MAP_SIZE);
            const _res = mapOutputVector[0];
        })
        .add('Traditional: WASM Copying', () => {
            const heapF32 = new Float32Array(sharedMemory.buffer);
            heapF32.set(nativeSourceArray, mapInViewIdx);
            exports.scale_vector(mapInPtr, mapOutPtr, MAP_SIZE);
            const _resultArray = heapF32.slice(mapOutViewIdx, mapOutViewIdx + MAP_SIZE);
        })
        .add('Native JS: Array.prototype.map()', () => {
            const _result = nativeSourceArray.map(x => x * 2.5);
        });

    const matrixBench = new Bench({ time: 800 });
    matrixBench
        .add('Zig Serial Compute Loop', () => {
            matMultiplySerial(matA, matB, matResultSerial, MATRIX_SIZE);
            const _res = matResultSerial[0];
        })
        .add('Zig-Bind Native Atomics ParallelFor', () => {
            matMultiplyParallel(matA, matB, matResultParallel, MATRIX_SIZE, ZigBindRegistry.threadCount);
            const _res = matResultParallel[0];
        });

    console.log('\n🚀 Running Suite 1: Vector Addition (50k elements)...');
    await vectorBench.run();
    console.table(vectorBench.table());

    console.log('\n🔥 Running Suite 2: Crazy Map Transformation (100k elements)...');
    await mapBench.run();
    console.table(mapBench.table());

    console.log('\n⚡ Running Suite 3: High-Density Matrix Multiplication Performance Comparison (256x256)...');
    await matrixBench.run();
    console.table(matrixBench.table());

    if (fs.existsSync(testCustomZigFile)) fs.unlinkSync(testCustomZigFile);
    if (fs.existsSync(expectedWasmFile)) fs.unlinkSync(expectedWasmFile);
    if (fs.existsSync(expectedDTSFile)) fs.unlinkSync(expectedDTSFile);
    if (fs.existsSync(expectedJSFile)) fs.unlinkSync(expectedJSFile);
}

runBenchmarkSuite().catch(console.error);