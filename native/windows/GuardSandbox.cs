// 使用系统 .NET Framework 编译器；可信 broker 将 Node 及其后代限制在 AppContainer 和 Job 中。
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static partial class GuardSandbox
{
    private static readonly object OutputLock = new object();
    private static readonly object PipeLock = new object();
    private static JavaScriptSerializer Json
    {
        get
        {
            return new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 32 };
        }
    }
    private sealed class Client
    {
        public int id; public uint pid; public NamedPipeServerStream stream;
        public readonly object gate = new object();
        public readonly Queue<ClientWrite> writes = new Queue<ClientWrite>();
        public readonly AutoResetEvent wake = new AutoResetEvent(false);
        public bool closed;
        public int retainedBytes, retainedRecords;
        public long offered, completed, rejected, unknown;
    }
    private sealed class ClientWrite { public byte[] bytes; public long expiresAt; }
    private sealed class Restore
    {
        public string path; public FileSystemSecurity dacl; public IntPtr descriptor, sacl;
    }
    public sealed class JournalRecord
    {
        public string path; public string dacl; public string label;
        public bool isFile; public string fileIdentity;
        public string sharedLeaseToken;
        public string deniedLeaseToken;
        public List<JournalAce> aces = new List<JournalAce>(); public bool restoreLabel;
    }
    public sealed class JournalAce { public int rights; public int type; public int? inheritance; }
    public sealed class ReadonlyLink { public string from; public string to; }
    public sealed class ReadonlyLinkManifest { public int version; public string root; public List<ReadonlyLink> links; public List<ReadonlyLink> coreBacklinks; }
    public sealed class JournalData
    {
        public int version = 2; public string profile; public string sid; public string jobName; public string projectRoot; public string[] readRoots; public List<JournalRecord> records; public int brokerPid; public string brokerCreated;
    }
    private static readonly List<Restore> Restores = new List<Restore>();
    private static readonly Dictionary<string, string> ReadonlyLinks = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, IntPtr> WritableFiles = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
    private static readonly List<Mutex> WritableFileLocks = new List<Mutex>();
    private static readonly Dictionary<int, Client> Clients = new Dictionary<int, Client>();
    private static NamedPipeServerStream Listener;
    private static int NextClient;
    private static uint RootPid;
    private static int RootClient;
    private static IntPtr Job;
    private static bool Stopping;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb; public IntPtr reserved, desktop, title; public int x, y, xsize, ysize, xchars, ychars, fill, flags;
        public short show, reserved2; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo info; public IntPtr attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo
    {
        public IntPtr process, thread; public uint pid, tid;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityCapabilities
    {
        public IntPtr sid, capabilities; public uint count, reserved;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public int length; public IntPtr descriptor; public int inherit;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation
    {
        public uint attributes, creationLow, creationHigh, accessLow, accessHigh, writeLow, writeHigh, serial, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcessLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSidW(string text, out IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, uint inputSize, [Out] byte[] output, uint outputSize, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint capacity, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr buffer, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int info, out int value, int size, out int returned);

    private static void Check(bool result, string stage)
    {
        if (!result)
            throw new Win32Exception(Marshal.GetLastWin32Error(), stage);
    }
    private static void Emit(object value)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(Json.Serialize(value));
            Console.Out.Flush();
        }
    }
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                slashes++;
                continue;
            }
            if (c == '\"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append(c);
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(c);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }
    private static bool Inside(string value, string root)
    {
        return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
    private static void Snapshot(string path)
    {
        foreach (var item in Restores)
            if (item.path.Equals(path, StringComparison.OrdinalIgnoreCase))
                return;
        var restore = new Restore();
        restore.path = path;
        restore.dacl = Directory.Exists(path) ? (FileSystemSecurity)Directory.GetAccessControl(path) : (FileSystemSecurity)File.GetAccessControl(path);
        uint error = GetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out restore.sacl, out restore.descriptor);
        if (error != 0)
            throw new Win32Exception((int)error, "snapshot integrity label");
        Restores.Add(restore);
    }
    private static void CheckWritableTree(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Writable tree contains a reparse point");
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                if (ApprovedReadonlyLink(entry)) continue;
                throw new IOException("Writable tree contains an unapproved reparse point");
            }
            if ((attributes & FileAttributes.Directory) != 0)
            {
                CheckWritableTree(entry);
                continue;
            }
            var security = new SecurityAttributes();
            security.length = Marshal.SizeOf(typeof(SecurityAttributes));
            IntPtr file = CreateFileW(entry, 0x80, 7, ref security, 3, 0x00200000, IntPtr.Zero);
            Check(file != new IntPtr(-1), "inspect writable file identity");
            try
            {
                FileInformation information;
                Check(GetFileInformationByHandle(file, out information), "inspect writable hard links");
                if (information.links != 1)
                    throw new IOException("Writable tree contains a hard-linked file");
            }
            finally { CloseHandle(file); }
        }
    }
    private static bool RelativeLinkPath(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 4096 || value.IndexOfAny(new[] { '\\', ':', '\0' }) >= 0 || Path.IsPathRooted(value)) return false;
        foreach (char character in value) if (character < 32) return false;
        foreach (string part in value.Split('/')) if (part.Length == 0 || part == "." || part == "..") return false;
        return true;
    }
    private static bool Overlaps(string a, string b) { return Inside(a, b) || Inside(b, a); }
    private static bool SelectedDependencyLink(string filename, string root, List<string> writes)
    {
        string plugins = Path.Combine(root, "plugins");
        foreach (string write in writes)
            if (String.Equals(Path.GetDirectoryName(write), plugins, StringComparison.OrdinalIgnoreCase) && Inside(filename, Path.Combine(write, "node_modules"))) return true;
        return false;
    }
    private static bool ReadonlyLinkTarget(string target, string root, List<string> writes, List<string> files, List<string> denies)
    {
        if (!Inside(target, root) || target.Equals(root, StringComparison.OrdinalIgnoreCase)) return false;
        foreach (string write in writes) if (Overlaps(target, write)) return false;
        foreach (string file in files) if (Overlaps(target, file)) return false;
        foreach (string deny in denies) if (Overlaps(target, deny)) return false;
        foreach (string relative in new[] { "data", "temp", "logs", "config/config", ".git", ".cache" })
            if (Overlaps(target, Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)))) return false;
        foreach (string part in target.Substring(root.Length).Split(Path.DirectorySeparatorChar))
            if (part.Equals(".git", StringComparison.OrdinalIgnoreCase) || part.Equals(".cache", StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }
    private static bool JiuliRootPackage(string root)
    {
        string filename = Path.Combine(root, "package.json");
        CheckNoReparseParents(filename);
        var security = new SecurityAttributes(); security.length = Marshal.SizeOf(typeof(SecurityAttributes));
        IntPtr handle = CreateFileW(filename, 0x80000000, 1, ref security, 3, 0x00200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "open core package metadata");
        string text;
        using (var safe = new SafeFileHandle(handle, true))
        {
            var info = InspectExactFile(handle);
            if (info.sizeHigh != 0 || info.sizeLow > 256 * 1024) throw new IOException("Core package metadata exceeds 256 KiB");
            using (var stream = new FileStream(safe, FileAccess.Read))
            using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false)) text = reader.ReadToEnd();
        }
        var metadata = new JavaScriptSerializer { MaxJsonLength = 256 * 1024, RecursionLimit = 16 }.Deserialize<Dictionary<string, object>>(text);
        object name;
        return metadata != null && metadata.TryGetValue("name", out name) && String.Equals(name as string, "jiuli", StringComparison.Ordinal);
    }
    private static bool SelectedCoreBacklink(string source, string root, List<string> writes)
    {
        if (!String.Equals(Path.GetFileName(source), "jiuli", StringComparison.OrdinalIgnoreCase)) return false;
        string modules = Path.GetDirectoryName(source), plugin = Path.GetDirectoryName(modules);
        return String.Equals(Path.GetFileName(modules), "node_modules", StringComparison.OrdinalIgnoreCase) &&
            String.Equals(Path.GetDirectoryName(plugin), Path.Combine(root, "plugins"), StringComparison.OrdinalIgnoreCase) &&
            !String.Equals(Path.GetFileName(plugin), "yunzai-guard", StringComparison.OrdinalIgnoreCase) && ContainsPath(writes, plugin);
    }
    private static void LoadReadonlyLinks(string filename, string journal, string root, List<string> reads, List<string> writes, List<string> files, List<string> denies)
    {
        if (filename == null) return;
        string directory = Path.GetDirectoryName(filename);
        if (!String.Equals(Path.GetFileName(filename), "readonly-links.json", StringComparison.Ordinal) ||
            journal == null || !String.Equals(Path.GetDirectoryName(directory), Path.GetDirectoryName(journal), StringComparison.OrdinalIgnoreCase) ||
            Inside(filename, root) || !ContainsPath(reads, directory))
            throw new IOException("Readonly link manifest must be in the private session runtime directory");
        CheckNoReparseParents(filename);
        var security = new SecurityAttributes(); security.length = Marshal.SizeOf(typeof(SecurityAttributes));
        IntPtr handle = CreateFileW(filename, 0x80000000, 1, ref security, 3, 0x00200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "open readonly link manifest");
        string text;
        using (var safe = new SafeFileHandle(handle, true))
        {
            var info = InspectExactFile(handle);
            if (info.sizeHigh != 0 || info.sizeLow > 6 * 1024 * 1024) throw new IOException("Readonly link manifest exceeds 6 MiB");
            using (var stream = new FileStream(safe, FileAccess.Read))
            using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false)) text = reader.ReadToEnd();
        }
        var manifest = new JavaScriptSerializer { MaxJsonLength = 6 * 1024 * 1024, RecursionLimit = 8 }.Deserialize<ReadonlyLinkManifest>(text);
        if (manifest == null || manifest.version != 1 || !String.Equals(manifest.root, root, StringComparison.OrdinalIgnoreCase) || manifest.links == null || manifest.links.Count + (manifest.coreBacklinks == null ? 0 : manifest.coreBacklinks.Count) > 8192)
            throw new IOException("Invalid readonly link manifest");
        foreach (var link in manifest.links)
        {
            if (link == null || !RelativeLinkPath(link.from) || !RelativeLinkPath(link.to)) throw new IOException("Invalid readonly dependency link path");
            string source = Path.GetFullPath(Path.Combine(root, link.from.Replace('/', Path.DirectorySeparatorChar)));
            string target = Path.GetFullPath(Path.Combine(root, link.to.Replace('/', Path.DirectorySeparatorChar)));
            if (!SelectedDependencyLink(source, root, writes) || !ReadonlyLinkTarget(target, root, writes, files, denies) || ReadonlyLinks.ContainsKey(source))
                throw new IOException("Readonly dependency link overlaps writable, protected, or external paths");
            ReadonlyLinks.Add(source, target);
        }
        if (manifest.coreBacklinks != null && manifest.coreBacklinks.Count != 0)
        {
            if (!JiuliRootPackage(root)) throw new IOException("Core dependency backlinks require the JiuLi root package");
            foreach (var link in manifest.coreBacklinks)
            {
                if (link == null || !RelativeLinkPath(link.from) || link.to != ".") throw new IOException("Invalid core dependency backlink");
                string source = Path.GetFullPath(Path.Combine(root, link.from.Replace('/', Path.DirectorySeparatorChar)));
                if (!SelectedCoreBacklink(source, root, writes) || ReadonlyLinks.ContainsKey(source)) throw new IOException("Core dependency backlink must be a selected plugin's own jiuli dependency");
                // 只核验 junction 后跳过可写树遍历；不沿链接授予目标 ACL。
                ReadonlyLinks.Add(source, root);
            }
        }
        // 复核全部已声明对象，包含收集后消失的对象。
        foreach (var link in ReadonlyLinks) ApprovedReadonlyLink(link.Key);
    }
    private static bool ApprovedReadonlyLink(string filename)
    {
        string expected;
        if (!ReadonlyLinks.TryGetValue(filename, out expected)) return false;
        var security = new SecurityAttributes(); security.length = Marshal.SizeOf(typeof(SecurityAttributes));
        IntPtr link = CreateFileW(filename, 0x80, 7, ref security, 3, 0x02200000, IntPtr.Zero);
        Check(link != new IntPtr(-1), "inspect readonly dependency junction");
        try
        {
            FileInformation info; Check(GetFileInformationByHandle(link, out info), "inspect dependency reparse attributes");
            byte[] buffer = new byte[16384]; uint returned;
            if ((info.attributes & 0x410) != 0x410 || !DeviceIoControl(link, 0x900a8, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero) || returned < 8 || BitConverter.ToUInt32(buffer, 0) != 0xa0000003)
                throw new IOException("Only approved directory junctions are supported in writable dependencies");
        }
        finally { CloseHandle(link); }
        IntPtr target = CreateFileW(filename, 0x80, 7, ref security, 3, 0x02000000, IntPtr.Zero);
        Check(target != new IntPtr(-1), "resolve readonly dependency junction");
        try
        {
            FileInformation info; Check(GetFileInformationByHandle(target, out info), "inspect dependency target");
            var name = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(target, name, (uint)name.Capacity, 0);
            if (length == 0 || length >= name.Capacity || (info.attributes & (uint)FileAttributes.Directory) == 0) throw new IOException("Cannot resolve readonly dependency directory");
            string canonical = name.ToString();
            if (!canonical.StartsWith("\\\\?\\", StringComparison.Ordinal) || canonical.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) throw new IOException("Unsupported readonly dependency volume");
            canonical = Path.GetFullPath(canonical.Substring(4));
            if (!canonical.Equals(expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("Readonly dependency junction target changed after collection");
        }
        finally { CloseHandle(target); }
        return true;
    }
    private static void CheckNoReparseParents(string value)
    {
        for (string current = Path.GetFullPath(value); current != null; current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Exact writable file traverses a reparse point");
    }
    private static FileInformation InspectExactFile(IntPtr file, bool requireSingleLink = true)
    {
        FileInformation info;
        Check(GetFileInformationByHandle(file, out info), "inspect exact writable file");
        if ((requireSingleLink && info.links != 1) || (info.attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != 0)
            throw new IOException("Exact writable file must be ordinary and have one hard link");
        return info;
    }
    private static string FileIdentity(FileInformation info)
    {
        return info.serial.ToString("x8") + ":" + info.indexHigh.ToString("x8") + info.indexLow.ToString("x8");
    }
    private static IntPtr OpenExactFile(string path, bool requireSingleLink = true)
    {
        CheckNoReparseParents(path);
        var security = new SecurityAttributes();
        security.length = Marshal.SizeOf(typeof(SecurityAttributes));
        // 允许共享读写；授权有效期间禁止替换或删除对象。
        IntPtr file = CreateFileW(path, 0x80, 3, ref security, 3, 0x00200000, IntPtr.Zero);
        Check(file != new IntPtr(-1), "open exact writable file");
        try { InspectExactFile(file, requireSingleLink); return file; }
        catch { CloseHandle(file); throw; }
    }
    private static void HoldExactFile(string path)
    {
        if (WritableFiles.ContainsKey(path)) throw new IOException("Duplicate exact writable file");
        string key;
        using (var sha = SHA256.Create())
            key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()))).Replace("-", "");
        var mutex = new Mutex(false, "Local\\YunzaiGuard.WriteFile." + key);
        bool acquired = false;
        try
        {
            try { acquired = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new IOException("Exact writable file already belongs to an active sandbox");
            foreach (FileSystemAccessRule rule in File.GetAccessControl(path).GetAccessRules(true, false, typeof(SecurityIdentifier)))
                if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value.StartsWith("S-1-15-2-", StringComparison.Ordinal) && (rule.FileSystemRights & FileSystemRights.Write) != 0)
                    throw new IOException("Exact writable file retains another AppContainer write grant; recover its journal first");
            WritableFiles.Add(path, OpenExactFile(path));
            WritableFileLocks.Add(mutex);
        }
        catch { if (acquired) mutex.ReleaseMutex(); mutex.Dispose(); throw; }
    }
    private static string LabelString(IntPtr descriptor)
    {
        IntPtr text;
        uint length;
        Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 0x10, out text, out length), "serialize integrity label");
        try
        {
            return Marshal.PtrToStringUni(text);
        }
        finally { LocalFree(text); }
    }
    private static string ProfileSid(string profile)
    {
        IntPtr sid;
        int hr = DeriveAppContainerSidFromAppContainerName(profile, out sid);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        try { return new SecurityIdentifier(sid).Value; }
        finally { FreeSid(sid); }
    }
    private static Mutex AclMutex(string path)
    {
        string key;
        using (var sha = SHA256.Create())
            key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()))).Replace("-", "");
        var mutex = new Mutex(false, "Local\\YunzaiGuard.Acl." + key);
        try
        {
            try { if (!mutex.WaitOne(30000)) throw new IOException("Sandbox ACL update lock timed out"); }
            catch (AbandonedMutexException) { }
            return mutex;
        }
        catch { mutex.Dispose(); throw; }
    }
    private static void PlanAce(JournalRecord record, SecurityIdentifier sid, FileSystemRights rights, AccessControlType type)
    {
        var inheritance = record.isFile ? InheritanceFlags.None : InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        var rule = new FileSystemAccessRule(sid, rights, inheritance, PropagationFlags.None, type);
        foreach (var ace in record.aces)
            if (ace.type == (int)type) { ace.rights |= (int)rule.FileSystemRights; return; }
        record.aces.Add(new JournalAce { rights = (int)rule.FileSystemRights, type = (int)type, inheritance = (int)inheritance });
    }
    private static bool ContainsPath(List<string> values, string target)
    {
        foreach (string value in values)
            if (value.Equals(target, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
    private static void WriteJournal(string file, string profile, string root, List<string> reads, List<string> writes, List<string> writeFiles, List<string> denies)
    {
        if (file == null)
            throw new ArgumentException("An external cleanup journal is required");
        if (Inside(file, root))
            throw new ArgumentException("Cleanup journal must be outside the sandbox project");
        foreach (string read in reads)
            if (Inside(file, read))
                throw new ArgumentException("Cleanup journal must not be in a readable sandbox root");
        var records = new List<JournalRecord>();
        string sidText = ProfileSid(profile);
        var sid = new SecurityIdentifier(sidText);
        foreach (var restore in Restores)
        {
            foreach (FileSystemAccessRule existing in restore.dacl.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                if (existing.IdentityReference.Equals(sid)) throw new IOException("New sandbox SID already has project permissions");
            var record = new JournalRecord { path = restore.path, dacl = restore.dacl.GetSecurityDescriptorSddlForm(AccessControlSections.Access), label = LabelString(restore.descriptor), isFile = ContainsPath(writeFiles, restore.path) };
            if (record.isFile) record.fileIdentity = FileIdentity(InspectExactFile(WritableFiles[restore.path]));
            if (restore.path.Equals(root, StringComparison.OrdinalIgnoreCase) || ContainsPath(reads, restore.path))
                PlanAce(record, sid, FileSystemRights.ReadAndExecute, AccessControlType.Allow);
            if (ContainsPath(writes, restore.path))
            {
                PlanAce(record, sid, FileSystemRights.Modify, AccessControlType.Allow);
                record.restoreLabel = true;
                SharedDirectoryPlan shared;
                if (SharedDirectories.TryGetValue(restore.path, out shared))
                {
                    record.sharedLeaseToken = shared.token;
                    record.fileIdentity = shared.identity;
                    record.restoreLabel = false;
                    // 其他会话的 Low 快照不能作为原始共享标签基线。
                    record.label = null;
                }
            }
            if (record.isFile)
            {
                PlanAce(record, sid, FileSystemRights.Write, AccessControlType.Allow);
                record.restoreLabel = true;
            }
            if (ContainsPath(denies, restore.path)) PlanAce(record, sid, FileSystemRights.FullControl, AccessControlType.Deny);
            SharedDirectoryPlan denied;
            if (DeniedDirectories.TryGetValue(restore.path, out denied))
            {
                record.deniedLeaseToken = denied.token;
                record.fileIdentity = denied.identity;
            }
            records.Add(record);
        }
        var self = System.Diagnostics.Process.GetCurrentProcess();
        var data = new JournalData { profile = profile, sid = sidText, jobName = "Local\\YunzaiGuard.Job." + profile.Substring("YunzaiGuard.".Length), projectRoot = root, readRoots = reads.ToArray(), records = records, brokerPid = self.Id, brokerCreated = self.StartTime.ToUniversalTime().Ticks.ToString() };
        if (SharedDirectories.Count != 0) data.version = 3;
        if (DeniedDirectories.Count != 0) data.version = 4;
        byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(data));
        using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
    }
    private static void RestoreLabel(string path, string label)
    {
        IntPtr descriptor = IntPtr.Zero, sacl = IntPtr.Zero;
        uint size;
        bool present, defaulted;
        try
        {
            if (!String.IsNullOrEmpty(label))
            {
                Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(label, 1, out descriptor, out size), "restore label descriptor");
                Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted), "restore label SACL");
            }
            uint error = SetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0)
                throw new Win32Exception((int)error, "restore integrity label");
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static string ReadLabel(string path)
    {
        IntPtr sacl, descriptor;
        uint error = GetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "read cleanup integrity label");
        try { return LabelString(descriptor); }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static bool IsManagedLowLabel(string text, string original, bool isFile)
    {
        // SetNamedSecurityInfo 会保留或设置 SACL 继承位；仅匹配自身标签 ACE。
        string prefix = original != null && original.StartsWith("S:P", StringComparison.Ordinal) ? "S:P" : "S:";
        string ace = isFile ? "(ML;;NW;;;LW)" : "(ML;OICI;NW;;;LW)";
        return text == prefix + ace || text == prefix + "AI" + ace;
    }
    private static RawSecurityDescriptor ParseLabel(string text)
    {
        return String.IsNullOrEmpty(text)
            ? new RawSecurityDescriptor(ControlFlags.None, null, null, null, null)
            : new RawSecurityDescriptor(text);
    }
    private static bool IsEquivalentEmptyLabel(string current, string original)
    {
        // 缺失或空 SACL 恢复后可能序列化为 S:PAINO_ACCESS_CONTROL；保留恢复日志。
        // 仅接受标签 API 生成的标志且无 ACE；外加标签或审计 ACE 均不视为空。
        try
        {
            var before = ParseLabel(original);
            var after = ParseLabel(current);
            var allowed = ControlFlags.SelfRelative | ControlFlags.SystemAclPresent |
                ControlFlags.SystemAclAutoInherited | ControlFlags.SystemAclProtected;
            foreach (var descriptor in new[] { before, after })
            {
                if (descriptor.Owner != null || descriptor.Group != null || descriptor.DiscretionaryAcl != null ||
                    (descriptor.SystemAcl != null && descriptor.SystemAcl.Count != 0) ||
                    (descriptor.ControlFlags & ~allowed) != 0) return false;
            }
            var protectedFlag = ControlFlags.SystemAclProtected;
            bool wasProtected = (before.ControlFlags & protectedFlag) != 0;
            bool nowProtected = (after.ControlFlags & protectedFlag) != 0;
            if (wasProtected && !nowProtected) return false;
            // Windows 会保护传入的 NULL SACL；新建的非空指针 ACL 即使无 ACE 也不是同一状态。
            if (!wasProtected && nowProtected && (before.SystemAcl != null || after.SystemAcl != null)) return false;
            var inheritedFlag = ControlFlags.SystemAclAutoInherited;
            if ((before.ControlFlags & inheritedFlag) != 0 && (after.ControlFlags & inheritedFlag) == 0) return false;
            return true;
        }
        catch (ArgumentException) { return false; }
        catch (SystemException) { return false; }
    }
    private static int Cleanup(string journal)
    {
        if (!File.Exists(journal))
            return 0;
        if (new FileInfo(journal).Length > 1024 * 1024)
            throw new IOException("Cleanup journal too large");
        var data = Json.Deserialize<JournalData>(File.ReadAllText(journal, Encoding.UTF8));
        if (data == null || (data.version != 2 && data.version != 3 && data.version != 4) || !Regex.IsMatch(data.profile ?? "", "^YunzaiGuard\\.[a-f0-9]{32}$") || data.jobName != "Local\\YunzaiGuard.Job." + data.profile.Substring("YunzaiGuard.".Length) || data.records == null || data.records.Count > 64 || data.readRoots == null)
            throw new IOException("Invalid cleanup journal");
        if (data.sid != ProfileSid(data.profile)) throw new IOException("Cleanup SID does not match its sandbox profile");
        var sessionSid = new SecurityIdentifier(data.sid);
        if (data.brokerPid != System.Diagnostics.Process.GetCurrentProcess().Id)
            try
            {
                var previous = System.Diagnostics.Process.GetProcessById(data.brokerPid);
                using (previous)
                {
                    if (previous.StartTime.ToUniversalTime().Ticks.ToString() == data.brokerCreated && !previous.WaitForExit(5000))
                        throw new IOException("Original sandbox broker is still alive; cleanup refused");
                }
            }
            catch (ArgumentException) { }
        IntPtr previousJob = OpenJobObjectW(0x0c, false, data.jobName);
        if (previousJob != IntPtr.Zero)
        {
            try
            {
                Check(TerminateJobObject(previousJob, 1), "terminate recorded job");
                WaitJobEmpty(previousJob);
            }
            finally { CloseHandle(previousJob); }
        }
        else if (Marshal.GetLastWin32Error() != 2)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "open recorded job for cleanup");
        string root = Path.GetFullPath(data.projectRoot);
        var allowed = new List<string>(data.readRoots);
        allowed.Add(root);
        using (var projectMutation = ProjectAclMutationLock(root))
        {
        foreach (var record in data.records)
        {
            string target = Path.GetFullPath(record.path);
            bool valid = false;
            foreach (string directory in allowed)
                valid |= Inside(target, Path.GetFullPath(directory));
            if (!valid)
                throw new IOException("Cleanup target outside recorded sandbox roots");
            if ((File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Refusing reparse point in cleanup journal");
            if (record.aces == null || record.aces.Count > 2) throw new IOException("Invalid sandbox ACE ledger");
            if (record.sharedLeaseToken != null)
            {
                if ((data.version != 3 && data.version != 4) || record.isFile || record.restoreLabel || record.label != null || record.deniedLeaseToken != null)
                    throw new IOException("Invalid shared directory cleanup record");
                ReleaseSharedDirectory(journal, data, record);
                continue;
            }
            if (record.deniedLeaseToken != null)
            {
                ReleaseDeniedDirectory(journal, data, record);
                continue;
            }
            IntPtr exact = IntPtr.Zero;
            try
            {
                if (record.isFile)
                {
                    // 额外链接不扩展对象身份；在同一 inode 上撤销该 SID。
                    exact = OpenExactFile(target, false);
                    if (FileIdentity(InspectExactFile(exact, false)) != record.fileIdentity) throw new IOException("Exact writable file identity changed; journal retained");
                }
                using (var mutex = AclMutex(target))
                {
                    try
                    {
                        FileSystemSecurity current = record.isFile ? (FileSystemSecurity)File.GetAccessControl(target) : (FileSystemSecurity)Directory.GetAccessControl(target);
                        var remove = new List<FileSystemAccessRule>();
                        foreach (FileSystemAccessRule rule in current.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                        {
                            if (!rule.IdentityReference.Equals(sessionSid)) continue;
                            bool expected = false;
                            foreach (var ace in record.aces)
                                expected |= ace.rights == (int)rule.FileSystemRights && ace.type == (int)rule.AccessControlType &&
                                    (int)rule.InheritanceFlags == (ace.inheritance ?? (int)(InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)) && rule.PropagationFlags == PropagationFlags.None;
                            if (!expected) throw new IOException("Sandbox ACE changed externally; journal retained for review");
                            remove.Add(rule);
                        }
                        // 仅修改本会话独占可写路径的标签。
                        if (record.restoreLabel)
                        {
                            string currentLabel = ReadLabel(target);
                            if (currentLabel != record.label && !IsEquivalentEmptyLabel(currentLabel, record.label))
                            {
                                if (!IsManagedLowLabel(currentLabel, record.label, record.isFile))
                                    throw new IOException("Sandbox integrity label changed externally; journal retained for review: " + currentLabel);
                                RestoreLabel(target, record.label);
                            }
                        }
                        // 标签不符需要人工恢复时，保留 SID 台账。
                        foreach (var rule in remove) current.RemoveAccessRuleSpecific(rule);
                        if (remove.Count > 0)
                        {
                            if (record.isFile) File.SetAccessControl(target, (FileSecurity)current);
                            else Directory.SetAccessControl(target, (DirectorySecurity)current);
                        }
                    }
                    finally { mutex.ReleaseMutex(); }
                }
            }
            finally { if (exact != IntPtr.Zero) CloseHandle(exact); }
        }
        }
        int hr = DeleteAppContainerProfile(data.profile);
        if (hr < 0 && hr != unchecked((int)0x80070002))
            Marshal.ThrowExceptionForHR(hr);
        File.Delete(journal);
        return 0;
    }
    private static void Grant(string directory, SecurityIdentifier sid, FileSystemRights rights)
    {
        Snapshot(directory);
        using (var mutex = AclMutex(directory))
        {
            try
            {
                var acl = Directory.GetAccessControl(directory);
                acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.SetAccessControl(directory, acl);
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
    private static void GrantFile(string path, SecurityIdentifier sid)
    {
        using (var mutex = AclMutex(path))
        {
            try
            {
                var acl = File.GetAccessControl(path);
                acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Write, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
                File.SetAccessControl(path, acl);
                LowLabel(path, IntPtr.Zero, true);
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
    private static void Deny(string target, SecurityIdentifier sid)
    {
        Snapshot(target);
        using (var mutex = AclMutex(target))
        {
            try
            {
                var acl = Directory.GetAccessControl(target);
                acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Deny));
                Directory.SetAccessControl(target, acl);
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
    private static void LowLabel(string directory, IntPtr handle, bool isFile = false)
    {
        IntPtr descriptor = IntPtr.Zero;
        uint size;
        bool present, defaulted;
        IntPtr sacl;
        try
        {
            Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(isFile ? "S:(ML;;NW;;;LW)" : "S:(ML;OICI;NW;;;LW)", 1, out descriptor, out size), "low label descriptor");
            Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted), "low label SACL");
            uint error = directory != null ? SetNamedSecurityInfoW(directory, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl) : SetSecurityInfo(handle, 6, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0)
                throw new Win32Exception((int)error, directory == null ? "pipe low label" : "directory low label");
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static string ReadLineBounded(TextReader reader)
    {
        var result = new StringBuilder();
        while (true)
        {
            int c = reader.Read();
            if (c < 0)
                return result.Length == 0 ? null : result.ToString();
            if (c == 10)
                return result.ToString();
            if (c != 13)
                result.Append((char)c);
            if (result.Length > 65536)
                throw new IOException("IPC frame too large");
        }
    }
    private static Thread Background(ThreadStart action)
    {
        var thread = new Thread(action);
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
    private static void Stop()
    {
        BeginStopping();
        var job = Job;
        if (job != IntPtr.Zero)
            TerminateJobObject(job, 1);
    }
    private static void CanonicalDiagnostic(string message)
    {
        try { Console.Error.WriteLine(message); } catch { }
    }
    private static void BeginStopping()
    {
        Stopping = true;
        try { BeginCanonicalStop(); }
        catch (Exception error) { CanonicalDiagnostic("Canonical metadata stop preparation unknown: " + error.Message); }
    }
    private static void WaitJobEmpty(IntPtr job)
    {
        IntPtr buffer = Marshal.AllocHGlobal(48);
        try
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (true)
            {
                uint returned;
                Check(QueryInformationJobObject(job, 1, buffer, 48, out returned), "query active job processes");
                if (Marshal.ReadInt32(buffer, 40) == 0)
                    return;
                if (DateTime.UtcNow >= deadline)
                    throw new IOException("Job still contains active processes; cleanup refused");
                Thread.Sleep(20);
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    private static NamedPipeServerStream NewPipe(string name, PipeSecurity security)
    {
        if (Listener != null)
            return new NamedPipeServerStream(name, PipeDirection.InOut, 32, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security);
        var stream = new NamedPipeServerStream(name, PipeDirection.InOut, 32, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security, HandleInheritability.None, PipeAccessRights.ChangePermissions | PipeAccessRights.TakeOwnership);
        LowLabel(null, stream.SafePipeHandle.DangerousGetHandle());
        return stream;
    }
    // 每条连接独立限制写队列；持有 PipeLock 时不执行管道 I/O。
    private static void CloseClient(Client client)
    {
        lock (client.gate)
        {
            if (client.closed) return;
            client.closed = true;
            client.unknown += client.retainedRecords;
            client.retainedBytes = client.retainedRecords = 0;
            client.writes.Clear();
        }
        client.wake.Set();
        try { client.stream.Dispose(); } catch { }
    }
    private static bool QueueClientWrite(Client client, object message)
    {
        byte[] bytes;
        try { bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(message) + "\n"); }
        catch
        {
            lock (client.gate) { client.offered++; client.rejected++; }
            CloseClient(client);
            return false;
        }
        bool refused = false;
        lock (client.gate)
        {
            client.offered++;
            if (client.closed || bytes.Length > 65536 || client.retainedBytes + bytes.Length > 256 * 1024 || client.retainedRecords >= 4096)
            {
                client.rejected++;
                refused = true;
            }
            else
            {
                client.retainedBytes += bytes.Length;
                client.retainedRecords++;
                client.writes.Enqueue(new ClientWrite { bytes = bytes, expiresAt = Stopwatch.GetTimestamp() + 2 * Stopwatch.Frequency });
            }
        }
        if (refused) CloseClient(client);
        else client.wake.Set();
        return !refused;
    }
    private static void StartClientWriter(Client client)
    {
        Background(delegate
        {
            try
            {
                while (true)
                {
                    ClientWrite pending = null;
                    lock (client.gate)
                    {
                        if (client.closed) return;
                        if (client.writes.Count > 0) pending = client.writes.Dequeue();
                    }
                    if (pending == null) { client.wake.WaitOne(); continue; }
                    int remaining = (int)Math.Min(2000, Math.Max(0, (pending.expiresAt - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency));
                    if (remaining <= 0) throw new IOException("Client write deadline exceeded");
                    Task operation = Task.Factory.FromAsync(
                        (callback, state) => client.stream.BeginWrite(pending.bytes, 0, pending.bytes.Length, callback, state),
                        client.stream.EndWrite, null);
                    if (!operation.Wait(remaining))
                    {
                        operation.ContinueWith(done => { var observed = done.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                        throw new IOException("Client write deadline exceeded");
                    }
                    lock (client.gate)
                    {
                        if (client.closed) return;
                        client.retainedBytes -= pending.bytes.Length;
                        client.retainedRecords--;
                        client.completed++;
                    }
                }
            }
            catch { CloseClient(client); }
        });
    }
    private static void Accept(string name, PipeSecurity security)
    {
        Background(delegate
        {
            try
            {
                while (!Stopping)
                {
                    var stream = Listener;
                    stream.WaitForConnection();
                    uint pid;
                    Check(GetNamedPipeClientProcessId(stream.SafePipeHandle.DangerousGetHandle(), out pid), "pipe peer PID");
                    bool member = false;
                    IntPtr process = OpenProcess(0x1000, false, pid);
                    if (process != IntPtr.Zero)
                    {
                        try
                        {
                            Check(IsProcessInJob(process, Job, out member), "pipe peer job membership");
                        }
                        finally { CloseHandle(process); }
                    }
                    try
                    {
                        Listener = NewPipe(name, security);
                    }
                    catch (Exception error) { throw new IOException("create next IPC pipe: " + error.Message, error); }
                    if (!member)
                    {
                        stream.Dispose();
                        continue;
                    }
                    var client = new Client { id = Interlocked.Increment(ref NextClient), pid = pid, stream = stream };
                    lock (PipeLock)
                        Clients.Add(client.id, client);
                    StartClientWriter(client);
                    Background(delegate
                    {
                        try
                        {
                            using (var reader = new StreamReader(stream, new UTF8Encoding(false), false, 4096, true))
                            {
                                string line;
                                while ((line = ReadLineBounded(reader)) != null)
                                {
                                    object message = Json.DeserializeObject(line);
                                    var value = message as Dictionary<string, object>;
                                    object kind;
                                    if (client.pid == RootPid && value != null && value.TryGetValue("type", out kind) && (string)kind == "preload-hello")
                                        Interlocked.CompareExchange(ref RootClient, client.id, 0);
                                    Emit(new
                                    {
                                        type = "ipc",
                                        clientId = client.id,
                                        pid = client.pid,
                                        message = message
                                    });
                                }
                            }
                        }
                        catch (Exception error) { if (!Stopping) Emit(new { type = "client-error", clientId = client.id, pid = client.pid, message = error.Message }); }
                        finally
                        {
                            lock (PipeLock) Clients.Remove(client.id);
                            CloseClient(client);
                            object counters;
                            lock (client.gate) counters = new { offered = client.offered, completed = client.completed, rejected = client.rejected, unknown = client.unknown, closed = true, scope = "native-client-write-only", evidence = "pipe-write-completion-only" };
                            Emit(new { type = "ipc-close", clientId = client.id, pid = client.pid, transportCounters = counters });
                            if (client.id == RootClient && !Stopping) Stop();
                        }
                    });
                }
            }
            catch (Exception error) { if (!Stopping) { Emit(new { type = "transport-error", message = error.Message }); Stop(); } }
        });
    }
    private static void Drain(IntPtr handle, string type)
    {
        Background(delegate
        {
            try
            {
                using (var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false))
                {
                    byte[] bytes = new byte[4096];
                    int count;
                    while ((count = stream.Read(bytes, 0, bytes.Length)) > 0)
                        Emit(new
                        {
                            type = type,
                            base64 = Convert.ToBase64String(bytes, 0, count)
                        });
                }
            }
            catch (Exception error) { if (!Stopping) Emit(new { type = "transport-error", message = error.Message }); }
        });
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        if (args.Length == 2 && args[0] == "--cleanup")
        {
            try
            {
                return Cleanup(Path.GetFullPath(args[1]));
            }
            catch (Exception error) { Emit(new { type = "cleanup-error", message = error.Message }); return 1; }
        }
        string root = null, cwd = null, journal = null, endpoint = null, readonlyLinks = null, network = "none";
        bool discardOutput = false, canonicalMetadata = false;
        var writes = new List<string>();
        var writeFiles = new List<string>();
        var sharedWrites = new List<string>();
        var reads = new List<string>();
        var denies = new List<string>();
        int separator = -1;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--")
            {
                separator = i;
                break;
            }
            if (i + 1 >= args.Length)
                throw new ArgumentException("Missing option value");
            string option = args[i++];
            if (option == "--root")
                root = Path.GetFullPath(args[i]);
            else if (option == "--journal")
                journal = Path.GetFullPath(args[i]);
            else if (option == "--readonly-links")
                readonlyLinks = Path.GetFullPath(args[i]);
            else if (option == "--write")
                writes.Add(Path.GetFullPath(args[i]));
            else if (option == "--shared-write")
            {
                sharedWrites.Add(Path.GetFullPath(args[i]));
                writes.Add(Path.GetFullPath(args[i]));
            }
            else if (option == "--write-file")
                writeFiles.Add(Path.GetFullPath(args[i]));
            else if (option == "--read")
                reads.Add(Path.GetFullPath(args[i]));
            else if (option == "--deny")
                denies.Add(Path.GetFullPath(args[i]));
            else if (option == "--cwd")
                cwd = Path.GetFullPath(args[i]);
            else if (option == "--pipe")
                endpoint = args[i];
            else if (option == "--network")
                network = args[i];
            else if (option == "--discard-output")
            {
                if (args[i] != "true" && args[i] != "false") throw new ArgumentException("Invalid discard-output option");
                discardOutput = args[i] == "true";
            }
            else if (option == "--canonical-metadata")
            {
                if (canonicalMetadata || args[i] != "1") throw new ArgumentException("Invalid canonical metadata protocol");
                canonicalMetadata = true;
            }
            else
                throw new ArgumentException("Unknown option: " + option);
        }
        if (root == null || separator < 0 || separator + 1 >= args.Length)
        {
            Console.Error.WriteLine("--root <disposable staging root> [--write <child>] [--cwd <child>] -- <staged executable> [args]");
            return 2;
        }
        root = root.TrimEnd(Path.DirectorySeparatorChar);
        cwd = cwd ?? root;
        string exe = Path.GetFullPath(args[separator + 1]);
        bool allowedExe = Inside(exe, root);
        foreach (string read in reads)
            allowedExe |= Inside(exe, read);
        if (!Directory.Exists(root) || !allowedExe || !Inside(cwd, root))
            throw new ArgumentException("Executable and cwd must be inside sandbox roots");
        foreach (string write in writes)
            if (!Inside(write, root))
                throw new ArgumentException("Writable directories must be inside sandbox root");
        if (writeFiles.Count > 16) throw new ArgumentException("At most 16 exact writable files are supported");
        foreach (string file in writeFiles)
        {
            if (!Inside(file, root)) throw new ArgumentException("Exact writable file is outside sandbox root");
            string relative = file.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar);
            string[] parts = relative.Split(Path.DirectorySeparatorChar);
            if (!Inside(file, root) || parts.Length < 2 || !(parts[0].Equals("data", StringComparison.OrdinalIgnoreCase) || parts[0].Equals("config", StringComparison.OrdinalIgnoreCase) || parts[0].Equals("temp", StringComparison.OrdinalIgnoreCase)) ||
                Inside(file, Path.Combine(root, "data", "yunzai-guard")) || Inside(file, Path.Combine(root, "config", "default_config")))
                throw new ArgumentException("Exact writable files must be business data/config/temp files outside Guard and core defaults");
            foreach (string part in parts)
                if (part.Length == 0 || part != part.Trim() || part.EndsWith(".", StringComparison.Ordinal) || part.IndexOfAny(new[] { ':', '<', '>', '"', '|', '?', '*' }) >= 0 || Regex.IsMatch(part, "^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\\.|$)", RegexOptions.IgnoreCase))
                    throw new ArgumentException("Exact writable file has an unsafe Windows path component");
            foreach (string directory in writes)
                if (Inside(file, directory)) throw new ArgumentException("Exact file and directory write grants overlap");
            foreach (string directory in denies)
                if (Inside(file, directory)) throw new ArgumentException("Exact writable file overlaps a denied directory");
            if (parts[0].Equals("config", StringComparison.OrdinalIgnoreCase) && (parts.Length == 2 || (parts.Length == 3 && parts[1].Equals("config", StringComparison.OrdinalIgnoreCase))))
            {
                string name = parts[parts.Length - 1];
                if (Regex.IsMatch(name, "^(bot|db|group|milky|other|redis|renderer|satori|server|qq)\\.yaml$", RegexOptions.IgnoreCase) || File.Exists(Path.Combine(root, "config", "default_config", name)))
                    throw new ArgumentException("Exact writable file is a protected core configuration file");
            }
        }
        foreach (string deny in denies)
        {
            if (!Inside(deny, root) || deny.Equals(root, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Denied directories must be sandbox root children");
            foreach (string write in writes)
                if (Inside(write, deny)) throw new ArgumentException("Writable directory cannot be inside a denied control directory");
            foreach (string read in reads)
                if (Inside(read, deny)) throw new ArgumentException("Readable runtime cannot be inside a denied control directory");
        }
        if (network != "none" && network != "host")
            throw new ArgumentException("Unknown network mode");
        if (endpoint != null && (!endpoint.StartsWith("\\\\.\\pipe\\yunzai-guard-", StringComparison.Ordinal) || !Regex.IsMatch(endpoint.Substring(9), "^yunzai-guard-[a-zA-Z0-9-]{16,100}$")))
            throw new ArgumentException("Invalid sandbox pipe endpoint");
        string profile = "YunzaiGuard." + Guid.NewGuid().ToString("N");
        IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, capsPtr = IntPtr.Zero, handlesPtr = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero, input = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool initialized = false, createdProfile = false;
        var capabilitySids = new List<IntPtr>();
        IntPtr capabilityArray = IntPtr.Zero;
        try
        {
            foreach (string write in writes)
                Directory.CreateDirectory(write);
            foreach (string deny in denies)
                Directory.CreateDirectory(deny);
            LoadReadonlyLinks(readonlyLinks, journal, root, reads, writes, writeFiles, denies);
            foreach (string write in writes)
                CheckWritableTree(write);
            foreach (string file in writeFiles)
                HoldExactFile(file);
            PrepareSharedDirectories(root, sharedWrites, writes, writeFiles, denies);
            PrepareDeniedDirectories(root, denies);
            RecoverDeniedDirectoryLeases(root);
            SecurityIdentifier package;
            using (var projectMutation = ProjectAclMutationLock(root))
            {
            Snapshot(root);
            foreach (string read in reads)
                Snapshot(read);
            foreach (string write in writes)
                Snapshot(write);
            foreach (string file in writeFiles)
                Snapshot(file);
            foreach (string deny in denies)
                Snapshot(deny);
            WriteJournal(journal, profile, root, reads, writes, writeFiles, denies);
            if (SharedDirectories.Count != 0) SharedCheckpoint("journal-prepared");
            int hr = CreateAppContainerProfile(profile, profile, "Yunzai Guard isolated runtime", IntPtr.Zero, 0, out sid);
            if (hr < 0)
                Marshal.ThrowExceptionForHR(hr);
            createdProfile = true;
            package = new SecurityIdentifier(sid);
            foreach (string deny in denies)
                AcquireDeniedDirectory(journal, profile, root, deny);
            Grant(root, package, FileSystemRights.ReadAndExecute);
            foreach (string read in reads)
                Grant(read, package, FileSystemRights.ReadAndExecute);
            foreach (string write in writes)
            {
                Directory.CreateDirectory(write);
                if (SharedDirectories.ContainsKey(write)) AcquireSharedDirectory(journal, profile, root, write, package);
                else
                {
                    Grant(write, package, FileSystemRights.Modify);
                    LowLabel(write, IntPtr.Zero);
                }
            }
            foreach (string file in writeFiles)
                GrantFile(file, package);
            foreach (string deny in denies)
            {
                Directory.CreateDirectory(deny);
                Deny(deny, package);
            }
            }
            string pipeName = endpoint == null ? "yunzai-guard-" + Guid.NewGuid().ToString("N") : endpoint.Substring(9);
            var pipeSecurity = new PipeSecurity();
            pipeSecurity.SetAccessRuleProtection(true, false);
            pipeSecurity.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            pipeSecurity.AddAccessRule(new PipeAccessRule(package, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            Listener = NewPipe(pipeName, pipeSecurity);
            Job = CreateJobObjectW(IntPtr.Zero, "Local\\YunzaiGuard.Job." + profile.Substring("YunzaiGuard.".Length));
            int jobError = Marshal.GetLastWin32Error();
            Check(Job != IntPtr.Zero, "create job");
            if (jobError == 183)
                throw new IOException("Refusing an already existing Job object");
            var limits = new ExtendedLimits();
            limits.basic.flags = 0x2000;
            Check(SetInformationJobObject(Job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "kill-on-close job");
            var security = new SecurityAttributes();
            security.length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.inherit = 1;
            if (discardOutput)
            {
                // 在系统边界丢弃插件原始输出，禁止通过 broker 控制通道转发。
                outputWrite = CreateFileW("NUL", 0x40000000, 3, ref security, 3, 0, IntPtr.Zero);
                Check(outputWrite != new IntPtr(-1), "stdout NUL");
                errorWrite = CreateFileW("NUL", 0x40000000, 3, ref security, 3, 0, IntPtr.Zero);
                Check(errorWrite != new IntPtr(-1), "stderr NUL");
            }
            else
            {
                Check(CreatePipe(out outputRead, out outputWrite, ref security, 0), "stdout pipe");
                Check(SetHandleInformation(outputRead, 1, 0), "stdout noninherit");
                Check(CreatePipe(out errorRead, out errorWrite, ref security, 0), "stderr pipe");
                Check(SetHandleInformation(errorRead, 1, 0), "stderr noninherit");
            }
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(input != new IntPtr(-1), "stdin NUL");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 3, 0, ref size), "initialize startup attributes");
            initialized = true;
            var caps = new SecurityCapabilities();
            caps.sid = sid;
            if (network == "host")
            {
                int stride = IntPtr.Size == 8 ? 16 : 8;
                capabilityArray = Marshal.AllocHGlobal(stride * 2);
                for (int i = 0; i < 2; i++)
                {
                    IntPtr capability;
                    Check(ConvertStringSidToSidW(i == 0 ? "S-1-15-3-1" : "S-1-15-3-3", out capability), "network capability SID");
                    capabilitySids.Add(capability);
                    Marshal.WriteIntPtr(capabilityArray, i * stride, capability);
                    Marshal.WriteInt32(capabilityArray, i * stride + IntPtr.Size, 4);
                }
                caps.capabilities = capabilityArray;
                caps.count = 2;
            }
            capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
            Marshal.StructureToPtr(caps, capsPtr, false);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), capsPtr, new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero), "AppContainer attribute");
            handlesPtr = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handlesPtr, 0, input);
            Marshal.WriteIntPtr(handlesPtr, IntPtr.Size, outputWrite);
            Marshal.WriteIntPtr(handlesPtr, IntPtr.Size * 2, errorWrite);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handlesPtr, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "inherited handles allowlist");
            IntPtr jobPtr = Marshal.AllocHGlobal(IntPtr.Size);
            try
            {
                Marshal.WriteIntPtr(jobPtr, Job);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobPtr, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "atomic job assignment");
            }
            finally { /* Attribute values must remain live until CreateProcess; reuse a dedicated allocation below. */ }
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry item in Environment.GetEnvironmentVariables())
                env[(string)item.Key] = (string)item.Value;
            env.Remove("NODE_OPTIONS");
            env.Remove("NODE_CHANNEL_FD");
            env["YUNZAI_GUARD_PIPE"] = "\\\\.\\pipe\\" + pipeName;
            env["YUNZAI_GUARD_SANDBOX"] = "appcontainer";
            if (writes.Count > 0)
            {
                env["TEMP"] = writes[0];
                env["TMP"] = writes[0];
            }
            InitializeCanonicalMetadata(canonicalMetadata, exe, journal, package, env);
            var block = new StringBuilder();
            foreach (var pair in env)
            {
                block.Append(pair.Key);
                block.Append('=');
                block.Append(pair.Value);
                block.Append('\0');
            }
            block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            var startup = new StartupInfoEx();
            startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.info.flags = 0x100;
            startup.info.input = input;
            startup.info.output = outputWrite;
            startup.info.error = errorWrite;
            startup.attributes = attributes;
            var command = new StringBuilder();
            for (int i = separator + 1; i < args.Length; i++)
            {
                if (command.Length > 0)
                    command.Append(' ');
                command.Append(Quote(args[i]));
            }
            Check(CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, environment, cwd, ref startup, out process), "create AppContainer worker");
            bool inJob;
            Check(IsProcessInJob(process.process, Job, out inJob) && inJob, "verify atomically assigned worker job");
            Marshal.FreeHGlobal(jobPtr);
            RootPid = process.pid;
            IntPtr token;
            Check(OpenProcessToken(process.process, 8, out token), "inspect worker token");
            int isAppContainer, returned;
            try
            {
                Check(GetTokenInformation(token, 29, out isAppContainer, 4, out returned), "verify AppContainer token");
                if (isAppContainer != 1)
                    throw new InvalidOperationException("Worker is not an AppContainer");
            }
            finally { CloseHandle(token); }
            BindCanonicalRoot(process.process, process.pid);
            CloseHandle(outputWrite);
            outputWrite = IntPtr.Zero;
            CloseHandle(errorWrite);
            errorWrite = IntPtr.Zero;
            CloseHandle(input);
            input = IntPtr.Zero;
            if (!discardOutput)
            {
                Drain(outputRead, "stdout");
                outputRead = IntPtr.Zero;
                Drain(errorRead, "stderr");
                errorRead = IntPtr.Zero;
            }
            Accept(pipeName, pipeSecurity);
            Background(delegate
            {
                try
                {
                    string line;
                    while ((line = ReadLineBounded(Console.In)) != null)
                    {
                        var message = Json.Deserialize<Dictionary<string, object>>(line);
                        object type;
                        if (!message.TryGetValue("type", out type))
                            throw new IOException("Invalid control frame");
                        if ((string)type == "stop")
                        {
                            Stop();
                            return;
                        }
                        if ((string)type == "ipc" || (string)type == "close")
                        {
                            Client target = null;
                            lock (PipeLock)
                            {
                                object requested;
                                if (message.TryGetValue("clientId", out requested))
                                    Clients.TryGetValue(Convert.ToInt32(requested), out target);
                                else if (RootClient > 0)
                                    Clients.TryGetValue(RootClient, out target);
                                else
                                    foreach (var candidate in Clients.Values)
                                        if (candidate.pid == RootPid)
                                        {
                                            target = candidate;
                                            break;
                                        }
                            }
                            if (target == null)
                            {
                                if ((string)type == "close") continue;
                                // 已退出的连接不能中断其他客户端或控制读取。
                                Emit(new { type = "control-rejected", reason = "client-disconnected" });
                                continue;
                            }
                            if ((string)type == "close") CloseClient(target);
                            else QueueClientWrite(target, message["message"]);
                        }
                        else
                            throw new IOException("Unknown control frame");
                    }
                }
                catch (Exception error) { Emit(new { type = "transport-error", message = error.Message }); }
                finally { Stop(); }
            });
            Emit(new
            {
                type = "ready",
                pid = process.pid,
                appContainer = true,
                appContainerSid = package.Value,
                profile = profile,
                pipe = "\\\\.\\pipe\\" + pipeName,
                network = network,
                rawOutput = discardOutput ? "nul" : "pipe",
                job = "kill-on-close-no-breakaway",
                canonicalMetadata = CanonicalMetadataSnapshot()
            });
            if (ResumeThread(process.thread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "resume worker");
            WaitForSingleObject(process.process, 0xffffffff);
            uint exit;
            GetExitCodeProcess(process.process, out exit);
            BeginStopping();
            TerminateJobObject(Job, exit);
            Emit(new
            {
                type = "exit",
                code = exit,
                canonicalMetadata = CanonicalMetadataSnapshot()
            });
            return exit == 0 ? 0 : 1;
        }
        catch (Exception error) { Emit(new { type = "error", message = error.Message, code = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0 }); return 1; }
        finally
        {
            BeginStopping();
            if (Job != IntPtr.Zero)
            {
                TerminateJobObject(Job, 1);
                try
                {
                    WaitJobEmpty(Job);
                }
                catch (Exception error) { CanonicalDiagnostic("Job drain unconfirmed: " + error.Message); }
            }
            bool canonicalCleanupConfirmed = false;
            try
            {
                canonicalCleanupConfirmed = StopCanonicalMetadata();
                if (!canonicalCleanupConfirmed) CanonicalDiagnostic("Canonical metadata cleanup unconfirmed");
            }
            catch (Exception error) { CanonicalDiagnostic("Canonical metadata cleanup unconfirmed: " + error.Message); }
            // 最终快照绕过业务 stdout 锁；宿主持续读取原始 stderr，退出后仍保留 unknown。
            try { CanonicalDiagnostic("canonical-metadata-final " + Json.Serialize(new { cleanupConfirmed = canonicalCleanupConfirmed, snapshot = CanonicalMetadataSnapshot() })); }
            catch (Exception error) { CanonicalDiagnostic("Canonical metadata final snapshot unconfirmed: " + error.Message); }
            if (Job != IntPtr.Zero) { CloseHandle(Job); Job = IntPtr.Zero; }
            if (process.process != IntPtr.Zero)
            {
                TerminateProcess(process.process, 1);
                WaitForSingleObject(process.process, 5000);
                CloseHandle(process.process);
            }
            if (process.thread != IntPtr.Zero)
                CloseHandle(process.thread);
            if (Listener != null)
                Listener.Dispose();
            Client[] closingClients;
            lock (PipeLock) { closingClients = new List<Client>(Clients.Values).ToArray(); Clients.Clear(); }
            foreach (var client in closingClients) CloseClient(client);
            foreach (IntPtr handle in new[] { outputRead, outputWrite, errorRead, errorWrite, input })
                if (handle != IntPtr.Zero && handle != new IntPtr(-1))
                    CloseHandle(handle);
            if (initialized)
                DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero)
                Marshal.FreeHGlobal(attributes);
            if (capsPtr != IntPtr.Zero)
                Marshal.FreeHGlobal(capsPtr);
            if (handlesPtr != IntPtr.Zero)
                Marshal.FreeHGlobal(handlesPtr);
            if (environment != IntPtr.Zero)
                Marshal.FreeHGlobal(environment);
            if (sid != IntPtr.Zero)
                FreeSid(sid);
            if (capabilityArray != IntPtr.Zero)
                Marshal.FreeHGlobal(capabilityArray);
            foreach (IntPtr capability in capabilitySids)
                LocalFree(capability);
            foreach (var restore in Restores)
                if (restore.descriptor != IntPtr.Zero)
                    LocalFree(restore.descriptor);
            if (journal != null && File.Exists(journal))
                try
                {
                    Cleanup(journal);
                }
                catch (Exception error) { Console.Error.WriteLine("Sandbox cleanup journal retained: " + error.Message); }
            else if (createdProfile)
            {
                int hr = DeleteAppContainerProfile(profile);
                if (hr < 0)
                    Console.Error.WriteLine("AppContainer profile cleanup HRESULT=" + hr);
            }
            foreach (IntPtr file in WritableFiles.Values)
                CloseHandle(file);
            foreach (var mutex in WritableFileLocks)
            {
                mutex.ReleaseMutex();
                mutex.Dispose();
            }
            foreach (var shared in SharedDirectories.Values) shared.Dispose();
            foreach (var denied in DeniedDirectories.Values) denied.Dispose();
        }
    }
}
