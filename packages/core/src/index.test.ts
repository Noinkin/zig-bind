import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ZigBindRegistry } from './index.js';
const __dirname = import.meta.dirname;
import { WASI } from 'wasi';

const wasi = new WASI({
    version: 'preview1',
    args: process.argv,
    env: process.env
});

describe('User Custom Extension Pipeline Verification', () => {
    const testCustomZigFile = path.join(__dirname, 'custom_math_fixtures.zig');
    const testWasmOutputDir = path.join(__dirname, 'dist_test');
    const testTSOutputDir = path.join(__dirname);
    const expectedTSFile = path.join(testTSOutputDir, 'custom_math_fixtures.ts');
    const expectedWasmFile = path.join(testWasmOutputDir, 'custom_math_fixtures.wasm');

    const cliBinaryPath = path.resolve(__dirname, '../dist/cli.js');

    beforeAll(() => {
        const customZigContent = `
const std = @import("std");
const zb = @import("zig_bind");

/// Adds vector a to vector b
/// @param a - Pointer to the first vector
/// @param b - Pointer to the second vector
pub export fn add_vectors(a_ptr: [*]f32, b_ptr: [*]f32, c_ptr: [*]f32, len: usize) void {
    var i: usize = 0;
    while (i < len) : (i += 1) { c_ptr[i] = a_ptr[i] + b_ptr[i]; }
}

pub export fn process_string(ptr: [*]u8, len: usize) u32 {
    _ = ptr; return @as(u32, @intCast(len));
}

pub export fn process_json(ptr: [*]u8, len: usize) i32 {
    const json_slice = ptr[0..len];
    const allocator = std.heap.page_allocator;
    const parsed = std.json.parseFromSlice(struct { val: i32 }, allocator, json_slice, .{}) catch return -1;
    defer parsed.deinit();
    return parsed.value.val + 5;
}

pub export fn parallel_matrix_multiply(matrix_a: [*]f32, matrix_b: [*]f32, result: [*]f32, size: usize) void {
    const Closure = struct {
        a: [*]f32, b: [*]f32, r: [*]f32, s: usize,
        fn chunk(ctx: ?*anyopaque, start: usize, end: usize) void {
            const self = @as(*@This(), @ptrCast(@alignCast(ctx.?)));
            for (start..end) |i| {
                const row = i / self.s;
                const col = i % self.s;
                var sum: f32 = 0;
                for (0..self.s) |k| { sum += self.a[row * self.s + k] * self.b[k * self.s + col]; }
                self.r[i] = sum;
            }
        }
    };
    var context = Closure{ .a = matrix_a, .b = matrix_b, .r = result, .s = size };
    zb.parallelFor(&context, size * size, 8, Closure.chunk);
}
`;
        fs.writeFileSync(testCustomZigFile, customZigContent);
        execSync(`node "${cliBinaryPath}" build "${testCustomZigFile}" --out "${testWasmOutputDir}" --mode fast --standalone --shared --ts "${testTSOutputDir}"`);
    }, 50000);

    afterAll(() => {
        if (fs.existsSync(testCustomZigFile)) fs.unlinkSync(testCustomZigFile);
        if (fs.existsSync(expectedWasmFile)) fs.unlinkSync(expectedWasmFile);
        if (fs.existsSync(expectedTSFile)) fs.unlinkSync(expectedTSFile);
        if (fs.existsSync(testWasmOutputDir)) fs.rmSync(testWasmOutputDir, { recursive: true, force: true });
    });

    test('should load the user-extendable compiled binary and compute correct zero-copy structures', async () => {
        const wasmBuffer = fs.readFileSync(expectedWasmFile);
        const wasmModule = await WebAssembly.compile(wasmBuffer);
        
        const sharedMemory = ZigBindRegistry.createSharedMemory(1041, 4096);
        const instance = await ZigBindRegistry.instantiateModule(wasmModule, sharedMemory);

        const registry = new ZigBindRegistry(instance, sharedMemory);
        
        const vecA = registry.alloc('f32', [10.0, 20.0, 30.0, 40.0]);
        const vecB = registry.alloc('f32', [1.5, 2.5, 3.5, 4.5]);
        const vecC = registry.alloc('f32', 4);
        registry.bind('add_vectors')(vecA, vecB, vecC, 4);
        
        expect(Array.from(vecC)).toEqual([11.5, 22.5, 33.5, 44.5]);
    });

    test('should pass strings and JSON objects to Zig', async () => {
        const wasmBuffer = fs.readFileSync(expectedWasmFile);
        const wasmModule = await WebAssembly.compile(wasmBuffer);
        
        const sharedMemory = ZigBindRegistry.createSharedMemory(1041, 4096);
        const instance = await ZigBindRegistry.instantiateModule(wasmModule, sharedMemory);
        
        const registry = new ZigBindRegistry(instance, sharedMemory);

        const { ptr: sPtr, len: sLen } = registry.writeString("Hello Zig");
        expect(registry.bind('process_string')(sPtr, sLen)).toBe(9);

        const { ptr: jPtr, len: jLen } = registry.writeObject({ val: 10 });
        expect(registry.bind('process_json')(jPtr, jLen)).toBe(15);
    });

    test('should allow for threading', async () => {
        const wasmBuffer = fs.readFileSync(expectedWasmFile);
        
        const sharedMemory = ZigBindRegistry.createSharedMemory(1041, 4096);
        const wasmModule = await WebAssembly.compile(wasmBuffer);

        await ZigBindRegistry.initNativeThreads(wasmModule, sharedMemory);

        const mainInstance = await ZigBindRegistry.instantiateModule(wasmModule, sharedMemory);

        const registry = new ZigBindRegistry(mainInstance, sharedMemory);
        const MATRIX_SIZE = 64; 
        const cellCount = MATRIX_SIZE * MATRIX_SIZE;

        const srcA = new Float32Array(cellCount).fill(2.0);
        const srcB = new Float32Array(cellCount).fill(3.0);

        const matrixA = registry.alloc('f32', srcA);
        const matrixB = registry.alloc('f32', srcB);
        const resultMatrix = registry.alloc('f32', cellCount);

        const parallelMultiply = registry.bind('parallel_matrix_multiply');
        parallelMultiply(matrixA, matrixB, resultMatrix, MATRIX_SIZE);

        expect(resultMatrix[0]).toBe(6.0 * MATRIX_SIZE);
        expect(resultMatrix[cellCount - 1]).toBe(6.0 * MATRIX_SIZE);
    });
});