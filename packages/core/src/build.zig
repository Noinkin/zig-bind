
// THIS FILE IS AUTO GENERATED, TO INJECT LINES MAKE A 'build_inject.zig' FILE IN THE INPUT DIRECTORY       
const std = @import("std");
pub fn build(b: *std.Build) void {
    var features = std.Target.Cpu.Feature.Set.empty;
    
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.atomics));
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.bulk_memory));
    
    features.addFeature(@intFromEnum(std.Target.wasm.Feature.simd128));

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
        .cpu_features_add = features,
    });

    const root_mod = b.createModule(.{
        .root_source_file = b.path("_bundle_entry.zig"),
        .target = target,
        .optimize = .ReleaseFast,
    });

    const exe = b.addExecutable(.{
        .name = "dist_bench",
        .root_module = root_mod,
    });

    exe.root_module.link_libc = true;
    exe.entry = .disabled;
    exe.rdynamic = true;
    
    exe.import_memory = true;
    exe.shared_memory = true;
    exe.max_memory = 8192 * 65536;
    
    
    
    
    

    const zb_mod = b.addModule("zig_bind", .{
        .root_source_file = .{ .cwd_relative = "C:/Users/jamie/Documents/zig-bind/packages/core/zig/zig_bind.zig" },
    });
    exe.root_module.addImport("zig_bind", zb_mod);

    const install = b.addInstallArtifact(exe, .{});
    b.getInstallStep().dependOn(&install.step);
}
