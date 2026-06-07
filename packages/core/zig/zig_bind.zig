const std = @import("std");

const pool_size = 64 * 1024 * 1024;
var memory_pool: [pool_size]u8 align(64) = [_]u8{0} ** pool_size;
var pool_offset: usize = 0;

pub fn alloc(bytes: usize) ?[*]u8 {
    const aligned_bytes = (bytes + 7) & ~@as(usize, 7);

    if (pool_offset + aligned_bytes > pool_size) {
        return null;
    }

    const current_offset = pool_offset;

    pool_offset += aligned_bytes;

    const slice = memory_pool[current_offset..];
    return slice.ptr;
}

pub fn reset() void {
    pool_offset = 0;
}