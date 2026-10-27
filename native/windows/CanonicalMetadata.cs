// 私有运行时的只读兼容服务；不打开客体传入的路径，也不转经 Host JS。
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static partial class GuardSandbox
{
    private const uint CanonicalMagic = 0x314d4347;
    private const uint CanonicalBootstrapMagic = 0x31424d43;
    private const int CanonicalRequestBytes = 88;
    private const int CanonicalReplyHeaderBytes = 64;
    private const int CanonicalMaximumPathUnits = 32767;
    private const int CanonicalBudgetMs = 2000;
    private static CanonicalSession Canonical;
    private sealed class CanonicalPendingOperation
    {
        internal readonly IntPtr file, status, output;
        internal CanonicalPendingOperation(IntPtr file, IntPtr status, IntPtr output)
        { this.file = file; this.status = status; this.output = output; }
    }
    // 根处理器最多保留一个未完成查询；仅进程退出能证明 I/O 结束，不由终结器释放。
    private static CanonicalPendingOperation CanonicalPending;

    [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CanonicalCreatePipe(string name, uint access, uint mode, uint instances, uint outputBytes, uint inputBytes, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", EntryPoint = "GetCurrentProcess")]
    private static extern IntPtr CanonicalCurrentProcess();
    [DllImport("kernel32.dll", EntryPoint = "GetCurrentThread")]
    private static extern IntPtr CanonicalCurrentThread();
    [DllImport("kernel32.dll", EntryPoint = "GetProcessId", SetLastError = true)]
    private static extern uint CanonicalProcessId(IntPtr process);
    [DllImport("kernel32.dll", EntryPoint = "GetProcessTimes", SetLastError = true)]
    private static extern bool CanonicalProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", EntryPoint = "DuplicateHandle", SetLastError = true)]
    private static extern bool CanonicalDuplicate(IntPtr source, IntPtr value, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", EntryPoint = "GetFileType", SetLastError = true)]
    private static extern uint CanonicalFileType(IntPtr file);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    private static extern bool CanonicalFileInformation(IntPtr file, int kind, IntPtr output, uint size);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint CanonicalFinalLength(IntPtr file, IntPtr output, uint size, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "CancelSynchronousIo", SetLastError = true)]
    private static extern bool CanonicalCancelIo(IntPtr thread);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
    private static extern bool CanonicalTokenInformation(IntPtr token, int kind, IntPtr output, int size, out int required);
    [DllImport("ntdll.dll", EntryPoint = "NtQueryVolumeInformationFile")]
    private static extern int CanonicalVolume(IntPtr file, IntPtr status, IntPtr output, uint size, int kind);
    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationFile")]
    private static extern int CanonicalFileMode(IntPtr file, IntPtr status, IntPtr mode, uint size, int kind);

    private static long CanonicalNow()
    {
        long ticks = Stopwatch.GetTimestamp(), frequency = Stopwatch.Frequency;
        return ticks / frequency * 1000 + ticks % frequency * 1000 / frequency;
    }
    private static long CanonicalBirth(IntPtr process)
    {
        long birth, exit, kernel, user;
        Check(CanonicalProcessTimes(process, out birth, out exit, out kernel, out user), "canonical native process birth");
        return birth;
    }
    private static bool CanonicalEqual(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        int difference = 0;
        for (int i = 0; i < a.Length; i++) difference |= a[i] ^ b[i];
        return difference == 0;
    }
    private static byte[] CanonicalIdentity(IntPtr file)
    {
        IntPtr output = Marshal.AllocHGlobal(24);
        try
        {
            Check(CanonicalFileInformation(file, 18, output, 24), "canonical file identity");
            var bytes = new byte[24];
            Marshal.Copy(output, bytes, 0, bytes.Length);
            return bytes;
        }
        finally { Marshal.FreeHGlobal(output); }
    }
    private static byte[] CanonicalNativeInformation(IntPtr file, bool volume, int kind, int size, CanonicalSession owner)
    {
        IntPtr status = Marshal.AllocHGlobal(IntPtr.Size * 2), output = IntPtr.Zero, queryFile = IntPtr.Zero;
        bool neverFree = false;
        try
        {
            output = Marshal.AllocHGlobal(size);
            Check(CanonicalDuplicate(CanonicalCurrentProcess(), file, CanonicalCurrentProcess(), out queryFile, 0, false, 2), "canonical owned native query file");
            var retained = new CanonicalPendingOperation(queryFile, status, output);
            Marshal.WriteIntPtr(status, new IntPtr(0x103)); Marshal.WriteIntPtr(status, IntPtr.Size, IntPtr.Zero);
            int result = volume ? CanonicalVolume(queryFile, status, output, (uint)size, kind) : CanonicalFileMode(queryFile, status, output, (uint)size, kind);
            if (result == 0x103)
            {
                // API 没有独立完成事件，IOSB 或文件事件不足以证明本次查询结束。
                // 保留处理器、缓冲区和文件至进程退出；超时报 unknown，客户端永久回退。
                neverFree = true; CanonicalPending = retained; owner.UnresolvedNative();
                for (;;) Thread.Sleep(1000);
            }
            if (result != 0 || Marshal.ReadInt32(status) != 0) return null;
            ulong count = unchecked((ulong)Marshal.ReadIntPtr(status, IntPtr.Size).ToInt64());
            if (count > (ulong)size) return null;
            var bytes = new byte[(int)count]; Marshal.Copy(output, bytes, 0, bytes.Length); return bytes;
        }
        finally
        {
            if (!neverFree)
            {
                if (queryFile != IntPtr.Zero) CloseHandle(queryFile);
                if (output != IntPtr.Zero) Marshal.FreeHGlobal(output);
                Marshal.FreeHGlobal(status);
            }
        }
    }
    private static bool CanonicalLocalNtfs(IntPtr file, CanonicalSession owner)
    {
        byte[] mode = CanonicalNativeInformation(file, false, 16, 4, owner);
        if (mode == null || mode.Length != 4 || (BitConverter.ToUInt32(mode, 0) & 0x30) == 0) return false;
        byte[] device = CanonicalNativeInformation(file, true, 4, 8, owner);
        if (device == null || device.Length != 8 || BitConverter.ToUInt32(device, 0) != 7 || (BitConverter.ToUInt32(device, 4) & 0x10) != 0) return false;
        byte[] volume = CanonicalNativeInformation(file, true, 5, 140, owner);
        return CanonicalLocalNtfsData(mode, device, volume);
    }
    private static bool CanonicalLocalNtfsData(byte[] mode, byte[] device, byte[] volume)
    {
        return mode != null && mode.Length == 4 && (BitConverter.ToUInt32(mode, 0) & 0x30) != 0 &&
            device != null && device.Length == 8 && BitConverter.ToUInt32(device, 0) == 7 && (BitConverter.ToUInt32(device, 4) & 0x10) == 0 &&
            volume != null && volume.Length >= 20 && BitConverter.ToUInt32(volume, 8) == 8 &&
            volume[12] == 'N' && volume[13] == 0 && volume[14] == 'T' && volume[15] == 0 &&
            volume[16] == 'F' && volume[17] == 0 && volume[18] == 'S' && volume[19] == 0;
    }
    private static void CanonicalFinishPending(IAsyncResult pending, bool ended, Action finish, Action cancel, object retained)
    {
        if (!ended)
        {
            try { cancel(); } catch { }
            // 取消未确认时保留线程、结果和缓冲区；停止仅在固定期限内等待。
            pending.AsyncWaitHandle.WaitOne();
            try { finish(); } catch { }
        }
        GC.KeepAlive(retained);
        pending.AsyncWaitHandle.Close();
    }
    private static string CanonicalAppSid(IntPtr process)
    {
        IntPtr token;
        Check(OpenProcessToken(process, 8, out token), "canonical root token");
        try
        {
            int required;
            CanonicalTokenInformation(token, 31, IntPtr.Zero, 0, out required);
            if (required < IntPtr.Size || required > 4096) throw new IOException("Invalid canonical AppContainer token size");
            IntPtr output = Marshal.AllocHGlobal(required);
            try
            {
                Check(CanonicalTokenInformation(token, 31, output, required, out required), "canonical root AppSID");
                IntPtr sid = Marshal.ReadIntPtr(output);
                return sid == IntPtr.Zero ? null : new SecurityIdentifier(sid).Value;
            }
            finally { Marshal.FreeHGlobal(output); }
        }
        finally { CloseHandle(token); }
    }
    private static string CanonicalDosName(IntPtr file)
    {
        uint size = CanonicalFinalLength(file, IntPtr.Zero, 0, 0);
        if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "canonical DOS length");
        if (size > CanonicalMaximumPathUnits + 1) throw new IOException("Canonical DOS path exceeds limit");
        var text = new System.Text.StringBuilder((int)size + 1);
        uint units = GetFinalPathNameByHandleW(file, text, size, 0);
        if (units == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "canonical DOS path");
        if (units >= size || units > CanonicalMaximumPathUnits) throw new IOException("Canonical DOS path changed size");
        string path = text.ToString();
        if (path.Length != units || path.Length < 7 || !path.StartsWith("\\\\?\\", StringComparison.Ordinal) ||
            !((path[4] >= 'A' && path[4] <= 'Z') || (path[4] >= 'a' && path[4] <= 'z')) || path[5] != ':' || path[6] != '\\' ||
            path.IndexOf('\0') >= 0 || path.IndexOf(':', 6) >= 0)
            throw new IOException("Unsupported canonical DOS namespace");
        return path;
    }

    private sealed class CanonicalSession
    {
        private readonly object gate = new object();
        private readonly string name, appSid;
        private readonly byte[] nonce = new byte[24];
        private NamedPipeServerStream listener;
        private CanonicalConnection connection;
        private Thread acceptThread;
        private IntPtr root;
        private uint rootPid;
        private long rootBirth;
        private bool reserved, closed;
        private int disabled;
        private long offered, accepted, completed, rejected, unsupported, timedOut, unknown;

        internal CanonicalSession(string executable, string journal, SecurityIdentifier package)
        {
            appSid = package.Value;
            name = "yunzai-guard-canonical-" + Guid.NewGuid().ToString("N");
            string runtime = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(journal), "runtime"));
            if (!Path.GetDirectoryName(Path.GetFullPath(executable)).Equals(runtime, StringComparison.OrdinalIgnoreCase) ||
                !Path.GetFileName(executable).Equals("node.exe", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Canonical metadata requires the private session runtime");
            string cursor = runtime;
            while (cursor != null)
            {
                if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("Canonical runtime traverses a reparse point");
                cursor = Path.GetDirectoryName(cursor);
            }
            using (var random = System.Security.Cryptography.RandomNumberGenerator.Create()) random.GetBytes(nonce);
            try
            {
                listener = NewListener(true);
                string path = Path.Combine(runtime, "canonical-metadata-v1.bin");
                byte[] endpoint = RawUtf16("\\\\.\\pipe\\" + name);
                using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (var writer = new BinaryWriter(output))
                {
                    writer.Write(CanonicalBootstrapMagic); writer.Write((ushort)1); writer.Write((ushort)64);
                    writer.Write(CanonicalProcessId(CanonicalCurrentProcess())); writer.Write((ushort)(endpoint.Length / 2)); writer.Write((ushort)0);
                    writer.Write(CanonicalBirth(CanonicalCurrentProcess())); writer.Write(nonce); writer.Write(new byte[16]); writer.Write(endpoint);
                }
                acceptThread = new Thread(Accept);
                acceptThread.IsBackground = true;
                acceptThread.Start();
            }
            catch { Stop(); throw; }
        }
        private NamedPipeServerStream NewListener(bool first)
        {
            string owner = WindowsIdentity.GetCurrent().User.Value;
            // ReadWrite|Synchronize 不包含创建管道实例权限（bit4）。
            string sddl = "D:P(A;;GA;;;" + owner + ")(A;;0x12019b;;;" + appSid + ")S:(ML;;NW;;;LW)";
            IntPtr descriptor = IntPtr.Zero;
            uint size;
            try
            {
                Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out size), "canonical pipe descriptor");
                var security = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor, inherit = 0 };
                IntPtr raw = CanonicalCreatePipe("\\\\.\\pipe\\" + name, 3u | 0x40000000u | (first ? 0x80000u : 0), 8, 3, 65600, 4096, CanonicalBudgetMs, ref security);
                if (raw == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "canonical pipe create");
                var handle = new SafePipeHandle(raw, true);
                try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
                catch { handle.Dispose(); throw; }
            }
            finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        }
        internal void Bind(IntPtr original, uint pid)
        {
            IntPtr proof;
            Check(CanonicalDuplicate(CanonicalCurrentProcess(), original, CanonicalCurrentProcess(), out proof, 0x101040, false, 0), "canonical original root proof");
            try
            {
                bool member;
                if (CanonicalProcessId(proof) != pid || WaitForSingleObject(proof, 0) != 258 || !IsProcessInJob(proof, Job, out member) || !member || CanonicalAppSid(proof) != appSid)
                    throw new IOException("Canonical root proof is not the original AppContainer root");
                long birth = CanonicalBirth(proof);
                lock (gate)
                {
                    if (closed || root != IntPtr.Zero) throw new IOException("Canonical root was already bound or stopped");
                    root = proof; rootPid = pid; rootBirth = birth; proof = IntPtr.Zero;
                }
            }
            finally { if (proof != IntPtr.Zero) CloseHandle(proof); }
        }
        private void Accept()
        {
            try
            {
                while (Thread.VolatileRead(ref disabled) == 0)
                {
                    NamedPipeServerStream current;
                    lock (gate) { if (closed) return; current = listener; }
                    var pending = current.BeginWaitForConnection(null, null);
                    bool ended = false;
                    try
                    {
                        while (!pending.AsyncWaitHandle.WaitOne(100)) if (Thread.VolatileRead(ref disabled) != 0) return;
                        ended = true; current.EndWaitForConnection(pending);
                    }
                    finally { CanonicalFinishPending(pending, ended, delegate { current.EndWaitForConnection(pending); }, delegate { current.Dispose(); }, current); }
                    Interlocked.Increment(ref offered);
                    uint peer;
                    Check(GetNamedPipeClientProcessId(current.SafePipeHandle.DangerousGetHandle(), out peer), "canonical actual client");
                    IntPtr proof = IntPtr.Zero;
                    try
                    {
                        lock (gate)
                        {
                            if (closed) return;
                            listener = NewListener(false);
                            if (!reserved && root != IntPtr.Zero && peer == rootPid && WaitForSingleObject(root, 0) == 258)
                            {
                                Check(CanonicalDuplicate(CanonicalCurrentProcess(), root, CanonicalCurrentProcess(), out proof, 0x101040, false, 0), "canonical held root channel");
                                reserved = true;
                                connection = new CanonicalConnection(this, current, proof, rootPid, rootBirth);
                                proof = IntPtr.Zero;
                                connection.Start();
                                current = null;
                            }
                            else Interlocked.Increment(ref unsupported);
                        }
                    }
                    finally { if (proof != IntPtr.Zero) CloseHandle(proof); if (current != null) current.Dispose(); }
                }
            }
            catch { if (Thread.VolatileRead(ref disabled) == 0) { Interlocked.Increment(ref unknown); Disable(); } }
        }
        internal void Disable() { Interlocked.Exchange(ref disabled, 1); }
        internal void UnresolvedNative() { Interlocked.Increment(ref unknown); Disable(); }
        internal void BeginStop() { Disable(); }
        internal bool Stop()
        {
            Disable();
            NamedPipeServerStream listening;
            CanonicalConnection active;
            IntPtr proof;
            lock (gate)
            {
                closed = true; listening = listener; listener = null; active = connection; proof = root; root = IntPtr.Zero;
            }
            if (listening != null) try { listening.Dispose(); } catch { Interlocked.Increment(ref unknown); }
            if (active != null) active.Cancel();
            if (proof != IntPtr.Zero) CloseHandle(proof);
            long deadline = CanonicalNow() + 250;
            bool acceptDone = acceptThread == null || (acceptThread.ThreadState & System.Threading.ThreadState.Unstarted) != 0 || acceptThread.Join((int)Math.Max(0, deadline - CanonicalNow()));
            bool workDone = active == null || active.Wait((int)Math.Max(0, deadline - CanonicalNow()));
            if (!acceptDone || !workDone) Interlocked.Increment(ref unknown);
            return acceptDone && workDone;
        }
        internal object Snapshot()
        {
            return new { protocol = 1, enabled = true, disabled = Thread.VolatileRead(ref disabled) != 0,
                offered = Interlocked.Read(ref offered), acceptedRoot = Interlocked.Read(ref accepted), completed = Interlocked.Read(ref completed),
                rejected = Interlocked.Read(ref rejected), unsupported = Interlocked.Read(ref unsupported), timedOut = Interlocked.Read(ref timedOut), unknown = Interlocked.Read(ref unknown) };
        }
        private static byte[] RawUtf16(string value)
        {
            char[] chars = value.ToCharArray(); var bytes = new byte[chars.Length * 2];
            Buffer.BlockCopy(chars, 0, bytes, 0, bytes.Length); return bytes;
        }
        private sealed class CanonicalConnection
        {
            private readonly CanonicalSession owner;
            private readonly NamedPipeServerStream pipe;
            private readonly IntPtr source;
            private readonly uint pid;
            private readonly long birth;
            private readonly object threadGate = new object();
            private readonly ManualResetEvent done = new ManualResetEvent(false);
            private IntPtr threadHandle;
            private Thread thread;
            internal CanonicalConnection(CanonicalSession owner, NamedPipeServerStream pipe, IntPtr source, uint pid, long birth)
            { this.owner = owner; this.pipe = pipe; this.source = source; this.pid = pid; this.birth = birth; }
            internal void Start()
            {
                thread = new Thread(Run); thread.IsBackground = true;
                try { thread.Start(); } catch { CloseHandle(source); done.Set(); throw; }
            }
            internal bool Wait(int budget) { return done.WaitOne(budget); }
            internal void Cancel()
            {
                IntPtr proof = IntPtr.Zero;
                lock (threadGate)
                    if (threadHandle != IntPtr.Zero) CanonicalDuplicate(CanonicalCurrentProcess(), threadHandle, CanonicalCurrentProcess(), out proof, 0, false, 2);
                try { if (proof != IntPtr.Zero) CanonicalCancelIo(proof); }
                finally { if (proof != IntPtr.Zero) CloseHandle(proof); }
                try { pipe.Dispose(); } catch { }
            }
            private bool Live()
            {
                uint actual;
                return Thread.VolatileRead(ref owner.disabled) == 0 && WaitForSingleObject(source, 0) == 258 && CanonicalBirth(source) == birth &&
                    GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out actual) && actual == pid;
            }
            private byte[] ReadFrame(bool idle, out long deadline)
            {
                var bytes = new byte[CanonicalRequestBytes];
                deadline = CanonicalNow() + CanonicalBudgetMs;
                int at = 0;
                while (at < bytes.Length)
                {
                    var pending = pipe.BeginRead(bytes, at, at == 0 ? 1 : bytes.Length - at, null, null);
                    bool ended = false;
                    try
                    {
                        while (!pending.AsyncWaitHandle.WaitOne(idle && at == 0 ? 100 : Math.Max(1, (int)Math.Min(100, deadline - CanonicalNow()))))
                        {
                            if (!Live()) throw new EndOfStreamException();
                            if (!(idle && at == 0) && CanonicalNow() >= deadline) throw new TimeoutException();
                        }
                        ended = true; int count = pipe.EndRead(pending);
                        if (count == 0) throw new EndOfStreamException();
                        if (at == 0 && idle) deadline = CanonicalNow() + CanonicalBudgetMs;
                        at += count;
                    }
                    finally { CanonicalFinishPending(pending, ended, delegate { pipe.EndRead(pending); }, delegate { pipe.Dispose(); }, bytes); }
                }
                return bytes;
            }
            private void Reply(ulong sequence, uint status, uint nativeError, byte[] identity, string path, long deadline)
            {
                if (CanonicalNow() >= deadline) throw new TimeoutException();
                byte[] text = path == null ? new byte[0] : RawUtf16(path);
                byte[] output;
                using (var memory = new MemoryStream())
                using (var writer = new BinaryWriter(memory))
                {
                    writer.Write(CanonicalMagic); writer.Write((ushort)1); writer.Write((ushort)CanonicalReplyHeaderBytes);
                    writer.Write(sequence); writer.Write(status); writer.Write(nativeError); writer.Write((uint)(text.Length / 2)); writer.Write((uint)0);
                    writer.Write(identity ?? new byte[24]); writer.Write((ulong)0); writer.Write(text); output = memory.ToArray();
                }
                if (output.Length > 65600) throw new IOException("Canonical reply exceeds its bound");
                var pending = pipe.BeginWrite(output, 0, output.Length, null, null);
                bool ended = false;
                try
                {
                    if (!pending.AsyncWaitHandle.WaitOne((int)Math.Max(0, deadline - CanonicalNow()))) throw new TimeoutException();
                    ended = true; pipe.EndWrite(pending);
                    if (CanonicalNow() >= deadline) throw new TimeoutException();
                }
                finally { CanonicalFinishPending(pending, ended, delegate { pipe.EndWrite(pending); }, delegate { pipe.Dispose(); }, output); }
            }
            private void Run()
            {
                IntPtr own;
                try
                {
                    Check(CanonicalDuplicate(CanonicalCurrentProcess(), CanonicalCurrentThread(), CanonicalCurrentProcess(), out own, 0, false, 2), "canonical owned handler thread");
                    lock (threadGate) threadHandle = own;
                    ulong last = 0; bool hello = false;
                    while (Live())
                    {
                        long deadline;
                        byte[] request = ReadFrame(hello, out deadline);
                        if (CanonicalNow() >= deadline) throw new TimeoutException();
                        ulong sequence, value; byte[] nonce, expected; long callerBirth; uint kind;
                        using (var reader = new BinaryReader(new MemoryStream(request)))
                        {
                            if (reader.ReadUInt32() != CanonicalMagic || reader.ReadUInt16() != 1 || reader.ReadUInt16() != CanonicalRequestBytes) throw new IOException("Invalid canonical request header");
                            sequence = reader.ReadUInt64(); value = reader.ReadUInt64(); nonce = reader.ReadBytes(24); expected = reader.ReadBytes(24);
                            callerBirth = reader.ReadInt64(); kind = reader.ReadUInt32(); if (reader.ReadUInt32() != 0) throw new IOException("Invalid canonical reserved bytes");
                        }
                        if (!CanonicalEqual(nonce, owner.nonce) || callerBirth != birth) throw new IOException("Invalid canonical session binding");
                        if (!hello)
                        {
                            if (sequence != 0 || kind != 1 || value != 0 || !CanonicalEqual(expected, new byte[24])) throw new IOException("Canonical first frame must be HELLO");
                            Reply(0, 0, 0, null, null, deadline); hello = true; Interlocked.Increment(ref owner.accepted); continue;
                        }
                        if (kind != 2 || sequence == 0 || last == ulong.MaxValue || sequence != last + 1) throw new IOException("Invalid canonical query sequence");
                        last = sequence;
                        IntPtr file = IntPtr.Zero;
                        uint status = 0, error = 0; byte[] identity = null; string path = null;
                        try
                        {
                            try
                            {
                                if (value == 0 || value >= long.MaxValue || !Live()) status = 2;
                                else if (!CanonicalDuplicate(source, new IntPtr((long)value), CanonicalCurrentProcess(), out file, 0, false, 2)) { status = 7; error = (uint)Marshal.GetLastWin32Error(); }
                                else if (CanonicalFileType(file) != 1) status = 4;
                                else
                                {
                                    identity = CanonicalIdentity(file);
                                    if (!CanonicalEqual(identity, expected)) status = 5;
                                    else if (!CanonicalLocalNtfs(file, owner)) status = 6;
                                    else { path = CanonicalDosName(file); if (!CanonicalEqual(identity, CanonicalIdentity(file)) || !Live()) { status = 5; path = null; } }
                                }
                            }
                            catch (Win32Exception failure) { status = 7; error = (uint)failure.NativeErrorCode; path = null; }
                            catch (IOException) { status = 6; path = null; }
                            // 原生查询可能超时完成，禁止迟到确认。
                            if (CanonicalNow() >= deadline) throw new TimeoutException();
                            if (status != 0) { identity = null; path = null; Interlocked.Increment(ref owner.rejected); }
                            Reply(sequence, status, error, identity, path, deadline);
                            if (status == 0) Interlocked.Increment(ref owner.completed);
                        }
                        finally { if (file != IntPtr.Zero) CloseHandle(file); }
                    }
                }
                catch (TimeoutException) { Interlocked.Increment(ref owner.timedOut); }
                catch (EndOfStreamException) { }
                catch { Interlocked.Increment(ref owner.rejected); }
                finally
                {
                    owner.Disable();
                    try { pipe.Dispose(); } catch { }
                    CloseHandle(source);
                    lock (threadGate) { if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle); threadHandle = IntPtr.Zero; }
                    done.Set();
                }
            }
        }
    }

    private static void InitializeCanonicalMetadata(bool enabled, string executable, string journal, SecurityIdentifier package, IDictionary<string, string> env)
    {
        var remove = new List<string>();
        foreach (string key in env.Keys) if (key.StartsWith("YUNZAI_GUARD_CANONICAL_", StringComparison.OrdinalIgnoreCase)) remove.Add(key);
        foreach (string key in remove) env.Remove(key);
        if (!enabled) return;
        if (Canonical != null) throw new IOException("Canonical metadata was initialized twice");
        Canonical = new CanonicalSession(executable, journal, package);
        env["YUNZAI_GUARD_CANONICAL_METADATA"] = "1";
    }
    private static void BindCanonicalRoot(IntPtr originalRootProcess, uint originalRootPid) { if (Canonical != null) Canonical.Bind(originalRootProcess, originalRootPid); }
    private static void BeginCanonicalStop() { if (Canonical != null) Canonical.BeginStop(); }
    private static bool StopCanonicalMetadata() { return Canonical == null || Canonical.Stop(); }
    private static object CanonicalMetadataSnapshot()
    {
        return Canonical == null ? (object)new { protocol = 1, enabled = false, disabled = true,
            offered = 0L, acceptedRoot = 0L, completed = 0L, rejected = 0L, unsupported = 0L,
            timedOut = 0L, unknown = 0L } : Canonical.Snapshot();
    }
}
