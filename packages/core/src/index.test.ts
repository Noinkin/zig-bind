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
})

describe('User Custom Extension Pipeline Verification', () => {
    const testCustomZigFile = path.join(__dirname, 'custom_math_fixtures.zig');
    const testWasmOutputDir = path.join(__dirname, 'dist_test');
    const expectedWasmFile = path.join(testWasmOutputDir, 'custom_math_fixtures.wasm');

    const cliBinaryPath = path.resolve(__dirname, '../dist/cli.js');

    beforeAll(() => {
        const customZigContent = `
            const std = @import("std");
            const zb = @import("zig_bind");

            export fn zig_bind_alloc(bytes: usize) ?[*]u8 { return zb.alloc(bytes); }
            export fn zig_bind_reset() void { zb.reset(); }

            export fn add_vectors(a_ptr: [*]f32, b_ptr: [*]f32, c_ptr: [*]f32, len: usize) void {
                var i: usize = 0;
                while (i < len) : (i += 1) {
                    c_ptr[i] = a_ptr[i] + b_ptr[i];
                }
            }

            export fn process_string(ptr: [*]u8, len: usize) u32 {
                _ = ptr; 
                return @as(u32, @intCast(len));
            }

            export fn process_json(ptr: [*]u8, len: usize) i32 {
                const json_slice = ptr[0..len];
                const allocator = std.heap.page_allocator;
                const parsed = std.json.parseFromSlice(struct { val: i32 }, allocator, json_slice, .{}) catch return -1;
                defer parsed.deinit();
                return parsed.value.val + 5;
            }
        `;
        fs.writeFileSync(testCustomZigFile, customZigContent);

        execSync(`node "${cliBinaryPath}" build "${testCustomZigFile}" --out "${testWasmOutputDir}" --mode fast --standalone`);
    }, 50000);

    afterAll(() => {
        if (fs.existsSync(testCustomZigFile)) fs.unlinkSync(testCustomZigFile);
        if (fs.existsSync(expectedWasmFile)) fs.unlinkSync(expectedWasmFile);
        if (fs.existsSync(testWasmOutputDir)) fs.rmdirSync(testWasmOutputDir);
    });

    test('should load the user-extendable compiled binary and compute correct zero-copy structures', async () => {
        const wasmBuffer = fs.readFileSync(expectedWasmFile);
        const wasmModule = await WebAssembly.instantiate(wasmBuffer, {
            wasi_snapshot_preview1: wasi.wasiImport
        });
        
        const registry = new ZigBindRegistry(wasmModule.instance);
        
        const vecA = registry.alloc('f32', [10.0, 20.0, 30.0, 40.0]);
        const vecB = registry.alloc('f32', [1.5, 2.5, 3.5, 4.5]);
        const vecC = registry.alloc('f32', 4);

        const add = registry.bind('add_vectors');
        add(vecA, vecB, vecC, 4);

        expect(Array.from(vecC)).toEqual([11.5, 22.5, 33.5, 44.5]);
    });

    test('should pass strings and JSON objects to Zig', async () => {
        const wasmBuffer = fs.readFileSync(expectedWasmFile);
        const wasmModule = await WebAssembly.instantiate(wasmBuffer, {
            wasi_snapshot_preview1: wasi.wasiImport
        });
        
        const registry = new ZigBindRegistry(wasmModule.instance);

        const str = "Hello Zig";
        const { ptr: sPtr, len: sLen } = registry.writeString(str);
        const processString = registry.bind('process_string');
        const strLenResult = processString(sPtr, sLen);
        
        expect(strLenResult).toBe(str.length);

        const obj = { val: 10 };
        const { ptr: jPtr, len: jLen } = registry.writeObject(obj);
        const processJson = registry.bind('process_json');
        const jsonResult = processJson(jPtr, jLen);
        
        expect(jsonResult).toBe(15);
    });
});