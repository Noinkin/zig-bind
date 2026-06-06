#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { cac } from 'cac';

const cli = cac('zig-bind');

cli.command('build <inputFile>', 'Compiles a user Zig file with the zero-copy framework')
   .option('--out <dir>', 'Output directory', { default: './dist' })
   .option('--shared', 'Enable shared memory and atomics for multi-threaded worker pools')
   .action((inputFile, options) => {
       const absoluteInputPath = path.resolve(inputFile);
       const outputDir = path.resolve(options.out || './dist');
       const isShared = !!options.shared;
       
       if (!fs.existsSync(absoluteInputPath)) {
           console.error(`❌ Error: Input file not found at ${absoluteInputPath}`);
           process.exit(1);
       }

       fs.mkdirSync(outputDir, { recursive: true });

       const inputDir = path.dirname(absoluteInputPath);
       const buildZigPath = path.join(inputDir, 'build.zig');
       const coreEnginePath = path.resolve(import.meta.dirname, '../zig/zig_bind.zig').replace(/\\/g, '/');
       const outputName = path.basename(inputFile, '.zig');
       const finalWasmOutput = path.join(outputDir, `${outputName}.wasm`);

       const libDir = path.join(inputDir, '../lib');
        let cFiles: string[] = [];
        if (fs.existsSync(libDir)) {
            cFiles = fs.readdirSync(libDir).filter(file => file.endsWith('.c'));
        }

        const noLibcPath = path.join(inputDir, 'no_libc.h');
       const noLibcContent = `
#ifndef NO_LIBC_H
#define NO_LIBC_H

#define XXH_NO_LIBC 1
#define XXH_NO_STDLIB 1

#define XXH_memcpy(d, s, n) __builtin_memcpy(d, s, n)
#define XXH_memset(d, c, n) __builtin_memset(d, c, n)
#define XXH_memcmp(s1, s2, n) __builtin_memcmp(s1, s2, n)

#define _STRING_H
#define _MATH_H

void* memcpy(void* dest, const void* src, unsigned long n) { return __builtin_memcpy(dest, src, n); }
void* memset(void* s, int c, unsigned long n) { return __builtin_memset(s, c, n); }
float sqrtf(float x) { return __builtin_sqrtf(x); }
float cosf(float x) { return __builtin_cosf(x); }
float sinf(float x) { return __builtin_sinf(x); }
float tanf(float x) { return __builtin_tanf(x); }
float floorf(float x) { return __builtin_floorf(x); }
float ceilf(float x) { return __builtin_ceilf(x); }
float atan2f(float y, float x) { return __builtin_atan2f(y, x); }

#endif
`;
       fs.writeFileSync(noLibcPath, noLibcContent);
       const safeNoLibcPath = noLibcPath.replace(/\\/g, '/');

       const baseCFlags = ["-O3", "-msimd128", "-mbulk-memory", "-include", safeNoLibcPath];
       if (isShared) {
           baseCFlags.push("-matomics");
       }
       const formattedCFlags = baseCFlags.map(f => `"${f}"`).join(', ');

        const cSourceInclusion = cFiles.map(file => `
            exe.root_module.addCSourceFile(.{
                .file = b.path("${file}"),
                .flags = &.{${formattedCFlags}},
            });
        `).join('');
        
        const includePath = fs.existsSync(libDir) ? `exe.root_module.addIncludePath(b.path("lib"));` : '';

        const buildZigContent = `const std = @import("std");

pub fn build(b: *std.Build) void {
    var features = std.Target.Cpu.Feature.Set.empty;
    ${isShared ? `
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.atomics));
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.bulk_memory));
    ` : ''}

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = features,
    });

    const root_mod = b.createModule(.{
        .root_source_file = b.path("${path.basename(inputFile)}"),
        .target = target,
        .optimize = .ReleaseFast,
    });

    const exe = b.addExecutable(.{
        .name = "${outputName}",
        .root_module = root_mod,
    });

    exe.entry = .disabled;
    exe.rdynamic = true;
    ${isShared ? `
    exe.import_memory = true;
    exe.shared_memory = true;

    exe.max_memory = 8192 * 65536;
    ` : ''}
    
    ${includePath}
    ${cSourceInclusion}

    const zb_mod = b.addModule("zig_bind", .{
        .root_source_file = .{ .cwd_relative = "${coreEnginePath}" },
    });
    exe.root_module.addImport("zig_bind", zb_mod);

    const install = b.addInstallArtifact(exe, .{});
    b.getInstallStep().dependOn(&install.step);
}
`;

       fs.writeFileSync(buildZigPath, buildZigContent);

       console.log(`⚡ Compiling: ${inputFile} ${isShared ? '(Shared Threads Enabled)' : ''}...`);

       try {
           const localCacheDir = path.join(inputDir, '.zig-global-cache');
           
           execSync(`zig build --global-cache-dir "${localCacheDir}"`, { 
               cwd: inputDir,
               stdio: 'inherit',
               env: {
                   ...process.env,
                   LOCALAPPDATA: path.join(inputDir, '.zig-appdata'),
                   USERPROFILE: inputDir,
                   HOME: inputDir
               }
           });

           const buildOutputPath = path.join(inputDir, 'zig-out', 'bin', `${outputName}.wasm`);
           if (fs.existsSync(buildOutputPath)) {
               fs.copyFileSync(buildOutputPath, finalWasmOutput);
               console.log(`🎉 Done! Generated at: ${finalWasmOutput}`);
           }
       } catch (err) {
           console.error('❌ Zig Compilation Failed.');
       } finally {
           if (fs.existsSync(buildZigPath)) fs.unlinkSync(buildZigPath);
           if (fs.existsSync(noLibcPath)) fs.unlinkSync(noLibcPath);

           const dirs = ['zig-out', '.zig-cache', '.zig-global-cache', '.zig-appdata'];
           for (const dir of dirs) {
               const p = path.join(inputDir, dir);
               if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
           }
       }
   });

cli.help();
cli.parse();