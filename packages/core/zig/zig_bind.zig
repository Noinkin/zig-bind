const std = @import("std");

const pool_size = 64 * 1024 * 1024;
var memory_pool: [pool_size]u8 align(64) = [_]u8{0} ** pool_size;
var pool_offset: usize = 0;

pub fn alloc(bytes: usize) ?[*]u8 {
    const aligned_bytes = (bytes + 7) & ~@as(usize, 7);

    var current = @atomicLoad(usize, &pool_offset, .seq_cst);
    while (true) {
        if (current + aligned_bytes > pool_size) return null;

        if (@cmpxchgWeak(usize, &pool_offset, current, current + aligned_bytes, .seq_cst, .seq_cst)) |actual| {
            current = actual;
        } else break;
    }

    const slice = memory_pool[current..];
    return slice.ptr;
}

pub fn reset() void {
    pool_offset = 0;
}

const MAX_TASKS = 4096;
const Task = struct {
    func: *const fn (?*anyopaque) void,
    arg: ?*anyopaque,
};

var task_queue: [MAX_TASKS]Task = undefined;
var queue_head: usize = 0;
var queue_tail: usize = 0;
var queue_lock: u8 = 0;

fn lockQueue() void {
    while (@cmpxchgWeak(u8, &queue_lock, 0, 1, .seq_cst, .seq_cst)) |_| {
        std.atomic.spinLoopHint();
    }
}

fn unlockQueue() void {
    @atomicStore(u8, &queue_lock, 0, .seq_cst);
}

fn popAndExecuteTask() bool {
    lockQueue();
    if (queue_head == queue_tail) {
        unlockQueue();
        return false;
    }

    const task = task_queue[queue_head];
    queue_head = (queue_head + 1) % MAX_TASKS;
    unlockQueue();

    task.func(task.arg);
    return true;
}

pub fn spawn(func: *const fn (?*anyopaque) void, arg: ?*anyopaque) void {
    lockQueue();
    defer unlockQueue();

    if ((queue_tail + 1) % MAX_TASKS == queue_head) {
        unlockQueue();
        func(arg);
        return;
    }

    task_queue[queue_tail] = .{ .func = func, .arg = arg };
    queue_tail = (queue_tail + 1) % MAX_TASKS;
}

pub const WaitGroup = struct {
    counter: usize = 0,

    pub fn add(self: *WaitGroup, count: usize) void {
        _ = @atomicRmw(usize, &self.counter, .Add, count, .seq_cst);
    }

    pub fn done(self: *WaitGroup) void {
        _ = @atomicRmw(usize, &self.counter, .Sub, 1, .seq_cst);
    }

    pub fn wait(self: *WaitGroup) void {
        while (@atomicLoad(usize, &self.counter, .seq_cst) > 0) {
            if (!popAndExecuteTask()) {
                std.atomic.spinLoopHint();
            }
        }
    }
};

pub fn parallelFor(
    ctx: ?*anyopaque,
    total: usize,
    num_chunks: usize,
    exec: *const fn (ctx: ?*anyopaque, start: usize, end: usize) void,
) void {
    if (total == 0) return;
    const actual_chunks = @min(@min(num_chunks, total), 128);
    const base_chunk_size = total / actual_chunks;
    const remainder = total % actual_chunks;

    const ContextWrapper = struct {
        ctx: ?*anyopaque,
        start: usize,
        end: usize,
        exec: *const fn (?*anyopaque, usize, usize) void,
        wg: *WaitGroup,
    };

    var chunk_contexts: [128]ContextWrapper = undefined;
    var wg = WaitGroup{};
    var current_index: usize = 0;

    for (0..actual_chunks) |i| {
        const start = current_index;
        const extra = if (i < remainder) @as(usize, 1) else 0;
        const end = start + base_chunk_size + extra;
        current_index = end;

        chunk_contexts[i] = .{
            .ctx = ctx,
            .start = start,
            .end = end,
            .exec = exec,
            .wg = &wg,
        };

        wg.add(1);

        const task_runner = struct {
            fn run(arg: ?*anyopaque) void {
                const c = @as(*ContextWrapper, @ptrCast(@alignCast(arg.?)));
                c.exec(c.ctx, c.start, c.end);
                c.wg.done();
            }
        }.run;

        spawn(task_runner, &chunk_contexts[i]);
    }

    wg.wait();
}

pub fn workerLoop() void {
    while (true) {
        if (!popAndExecuteTask()) {
            std.atomic.spinLoopHint();
        }
    }
}