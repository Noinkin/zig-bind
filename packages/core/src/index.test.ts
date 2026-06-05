import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ZigBindRegistry } from './index.js';
const __dirname = import.meta.dirname;

describe('User Custom Extension Pipeline Verification', () => {
    const testCustomZigFile = path.join(__dirname, 'custom_math_fixtures.zig');
    const testWasmOutputDir = path.join(__dirname, 'dist_test');
    const expectedWasmFile = path.join(testWasmOutputDir, 'custom_math_fixtures.wasm');

    const cliBinaryPath = path.resolve(__dirname, '../dist/cli.cjs');

    beforeAll(() => {
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
        `;
        fs.writeFileSync(testCustomZigFile, customZigContent);

        execSync(`node "${cliBinaryPath}" build "${testCustomZigFile}" --out "${testWasmOutputDir}"`);
    }, 30000);

    afterAll(() => {
        if (fs.existsSync(testCustomZigFile)) fs.unlinkSync(testCustomZigFile);
        if (fs.existsSync(expectedWasmFile)) fs.unlinkSync(expectedWasmFile);
        if (fs.existsSync(testWasmOutputDir)) fs.rmdirSync(testWasmOutputDir);
    });

    test('should load the user-extendable compiled binary and compute correct zero-copy structures', async () => {
        const wasmBuffer = fs.readFileSync(expectedWasmFile);
        const wasmModule = await WebAssembly.instantiate(wasmBuffer, {});
        
        const registry = new ZigBindRegistry(wasmModule.instance);
        
        const vecA = registry.alloc('f32', [10.0, 20.0, 30.0, 40.0]);
        const vecB = registry.alloc('f32', [1.5, 2.5, 3.5, 4.5]);
        const vecC = registry.alloc('f32', 4);

        const add = registry.bind('add_vectors');
        add(vecA, vecB, vecC, 4);

        expect(Array.from(vecC)).toEqual([11.5, 22.5, 33.5, 44.5]);
    });
});