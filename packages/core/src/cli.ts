#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { cac } from 'cac';

const getRecursiveFiles = (dir: any) => {
    let files: any[] = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            files = files.concat(getRecursiveFiles(fullPath));
        } else if (item.name.endsWith('.c')) {
            files.push(fullPath);
        }
    }
    return files;
};

const cli = cac('zig-bind');

cli.command('build <inputFile>', 'Compiles a user Zig file with the zero-copy framework')
   .option('--out <dir>', 'Output directory', { default: './dist' })
   .option('--shared', 'Enable shared memory and atomics for multi-threaded worker pools')
   .option('--mode <mode>', 'Build mode: debug, fast, small', { default: 'fast' })
   .option('--clean', 'Force a clean build by clearing caches')
   .action((inputFile, options) => {
       const absoluteInputPath = path.resolve(inputFile);
       const outputDir = path.resolve(options.out || './dist');
       const isShared = !!options.shared;
       const mode: string = options.mode;
       
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
       let cFiles: any[] = [];

       if (fs.existsSync(libDir)) {
           cFiles = getRecursiveFiles(libDir);
       }

       const baseCFlags = ["-O3", "-msimd128", "-mbulk-memory", "-Ilib"];
       if (isShared) baseCFlags.push("-matomics");
       const formattedCFlags = baseCFlags.map(f => `"${f}"`).join(', ');

       const cSourceInclusion = cFiles.map(file => {
        const relativePath = path.relative(inputDir, file).replace(/\\/g, '/');
        return `
           exe.root_module.addCSourceFile(.{
               .file = b.path("${relativePath}"),
               .flags = &.{${formattedCFlags}},
           });
       `}).join('');
       
       const includePath = fs.existsSync(libDir) ? `exe.root_module.addIncludePath(b.path("lib"));` : '';

       const injectPath = path.join(inputDir, 'build_inject.zig');
       let injectedCode = '';
       if (fs.existsSync(injectPath)) injectedCode = fs.readFileSync(injectPath, 'utf-8');

       const optimizeMap: Record<string, string> = {
           'debug': '.Debug',
           'fast': '.ReleaseFast',
           'small': '.ReleaseSmall'
       };

       const optimize: string = optimizeMap[mode] || '.ReleaseFast';

       const buildZigContent = `const std = @import("std");

// THIS FILE IS AUTO GENERATED, TO INJECT LINES MAKE A 'build_inject.zig' FILE IN THE INPUT DIRECTORY

pub fn build(b: *std.Build) void {
    var features = std.Target.Cpu.Feature.Set.empty;
    ${isShared ? `
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.atomics));
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.bulk_memory));
    ` : ''}

    features.addFeature(@intFromEnum(std.Target.wasm.Feature.simd128));

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
        .cpu_features_add = features,
    });

    const root_mod = b.createModule(.{
        .root_source_file = b.path("${path.basename(inputFile)}"),
        .target = target,
        .optimize = ${optimize},
    });

    const exe = b.addExecutable(.{
        .name = "${outputName}",
        .root_module = root_mod,
    });

    exe.root_module.link_libc = true;

    exe.entry = .disabled;
    exe.rdynamic = true;
    ${isShared ? `
    exe.import_memory = true;
    exe.shared_memory = true;
    exe.max_memory = 8192 * 65536;
    ` : ''}
    
    ${includePath}
    ${cSourceInclusion}

    ${injectedCode}

    const zb_mod = b.addModule("zig_bind", .{
        .root_source_file = .{ .cwd_relative = "${coreEnginePath}" },
    });
    exe.root_module.addImport("zig_bind", zb_mod);

    const install = b.addInstallArtifact(exe, .{});
    b.getInstallStep().dependOn(&install.step);
}
`;

       fs.writeFileSync(buildZigPath, buildZigContent);

       console.log(`⚡ Compiling: ${inputFile}...`);

       try {
           const localCacheDir = path.join(inputDir, '.zig-global-cache');
           const cleanArg = options.clean ? "--cache-clean" : "";
           
           execSync(`zig build --global-cache-dir "${localCacheDir} ${cleanArg}`, { 
               cwd: inputDir,
               stdio: 'inherit',
               env: { ...process.env } // Remove the forced directory overriding, let Zig handle defaults
           });

           const buildOutputPath = path.join(inputDir, 'zig-out', 'bin', `${outputName}.wasm`);
           if (fs.existsSync(buildOutputPath)) {
               fs.copyFileSync(buildOutputPath, finalWasmOutput);
               console.log(`🎉 Done! Generated at: ${finalWasmOutput}`);
           }
       } catch (err) {
           console.error('❌ Zig Compilation Failed.');
       } finally {
           const dirs = ['zig-out', '.zig-cache', '.zig-global-cache', '.zig-appdata'];
           for (const dir of dirs) {
               const p = path.join(inputDir, dir);
               if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
           }
       }
   });

cli.help();
cli.parse();