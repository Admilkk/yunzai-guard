// 业务数据保留原路径，此处仅存权限恢复信息。
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class GuardSandbox
{
    private sealed class SharedDirectoryPlan : IDisposable
    {
        public string token, identity; public IntPtr handle;
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
    public sealed class SharedLabelMember
    {
        public string token, profile, sid, journal, brokerCreated, phase;
        public int brokerPid;
    }
    public sealed class SharedLabelLedger
    {
        public int version = 1;
        public string root, path, owner, identity, generation, originalLabel;
        public List<SharedLabelMember> members = new List<SharedLabelMember>();
    }
    private static readonly Dictionary<string, SharedDirectoryPlan> SharedDirectories = new Dictionary<string, SharedDirectoryPlan>(StringComparer.OrdinalIgnoreCase);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);

    private static string SharedKey(string path)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()))).Replace("-", "").ToLowerInvariant();
    }
    private static bool SharedBusinessPath(string root, string path)
    {
        if (!Inside(path, root) || path.Equals(root, StringComparison.OrdinalIgnoreCase)) return false;
        string[] parts = path.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar).Split(Path.DirectorySeparatorChar);
        if (parts.Length < 2 || !(parts[0].Equals("data", StringComparison.OrdinalIgnoreCase) || parts[0].Equals("config", StringComparison.OrdinalIgnoreCase) || parts[0].Equals("temp", StringComparison.OrdinalIgnoreCase))) return false;
        foreach (string part in parts)
            if (part.Length == 0 || part != part.Trim() || part.EndsWith(".", StringComparison.Ordinal) || part == "." || part == ".." || part.IndexOfAny(new[] { ':', '<', '>', '"', '|', '?', '*' }) >= 0 || Regex.IsMatch(part, "^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\\.|$)", RegexOptions.IgnoreCase)) return false;
        foreach (string relative in new[] { "data/yunzai-guard", "config/default_config", "config/config" })
            if (Overlaps(path, Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)))) return false;
        return true;
    }
    private static SharedDirectoryPlan OpenSharedDirectory(string path, string token, string expectedIdentity)
    {
        CheckNoReparseParents(path);
        var attributes = new SecurityAttributes(); attributes.length = Marshal.SizeOf(typeof(SecurityAttributes));
        // 必须使用 FILE_LIST_DIRECTORY；仅读属性无法阻止重命名。
        IntPtr handle = CreateFileW(path, 0x000e0081, 3, ref attributes, 3, 0x02200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "hold shared directory identity");
        var plan = new SharedDirectoryPlan { handle = handle, token = token };
        try
        {
            FileInformation info; Check(GetFileInformationByHandle(handle, out info), "inspect shared directory identity");
            if ((info.attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != (uint)FileAttributes.Directory) throw new IOException("Shared write target must be an ordinary directory");
            plan.identity = FileIdentity(info);
            if (expectedIdentity != null && plan.identity != expectedIdentity) throw new IOException("Shared directory identity changed; journal retained");
            return plan;
        }
        catch { plan.Dispose(); throw; }
    }
    private static void PrepareSharedDirectories(string root, List<string> shared, List<string> writes, List<string> files, List<string> denies)
    {
        if (shared.Count > 16) throw new IOException("At most 16 shared directory grants are supported");
        foreach (string path in shared)
        {
            if (!SharedBusinessPath(root, path) || !ContainsPath(writes, path) || SharedDirectories.ContainsKey(path)) throw new IOException("Shared directory must be an explicitly writable business data/config/temp child");
            foreach (string write in writes) if (!path.Equals(write, StringComparison.OrdinalIgnoreCase) && Overlaps(path, write)) throw new IOException("Shared directory overlaps another write grant");
            foreach (string file in files) if (Overlaps(path, file)) throw new IOException("Shared directory overlaps an exact file grant");
            foreach (string deny in denies) if (Overlaps(path, deny)) throw new IOException("Shared directory overlaps a protected path");
            SharedDirectories.Add(path, OpenSharedDirectory(path, Guid.NewGuid().ToString("N"), null));
        }
    }
    private static string SharedHandleLabel(IntPtr handle)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, 1, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "read shared integrity label");
        try { return LabelString(descriptor); }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static void SetSharedHandleLabel(IntPtr handle, string label)
    {
        IntPtr descriptor = IntPtr.Zero, sacl = IntPtr.Zero;
        try
        {
            uint size; bool present, defaulted;
            if (!String.IsNullOrEmpty(label))
            {
                Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(label, 1, out descriptor, out size), "parse shared integrity label");
                Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted), "extract shared integrity label");
            }
            uint error = SetSecurityInfo(handle, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0) throw new Win32Exception((int)error, "set shared integrity label");
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static DirectorySecurity SharedHandleAcl(IntPtr handle)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "read shared directory ACL");
        try
        {
            IntPtr text; uint length;
            Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, out text, out length), "serialize shared directory ACL");
            try { var acl = new DirectorySecurity(); acl.SetSecurityDescriptorSddlForm(Marshal.PtrToStringUni(text), AccessControlSections.Access); return acl; }
            finally { LocalFree(text); }
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static void SetSharedHandleAcl(IntPtr handle, DirectorySecurity acl)
    {
        byte[] bytes = acl.GetSecurityDescriptorBinaryForm();
        IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length);
            bool present, defaulted; IntPtr dacl;
            Check(GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted), "extract shared directory ACL");
            if (!present) throw new IOException("Shared directory ACL unexpectedly absent");
            uint error = SetSecurityInfo(handle, 1, 4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error, "set shared directory ACL");
        }
        finally { Marshal.FreeHGlobal(descriptor); }
    }
    private static SecurityIdentifier SharedOwner() { return WindowsIdentity.GetCurrent().User; }
    private static void ValidatePrivateAcl(FileSystemSecurity acl)
    {
        var owner = SharedOwner();
        if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(owner)) throw new IOException("Shared label metadata owner mismatch");
        bool ownerFull = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || (!rule.IdentityReference.Equals(owner) && rule.IdentityReference.Value != "S-1-5-18")) throw new IOException("Shared label metadata ACL is not owner-private");
            ownerFull |= rule.IdentityReference.Equals(owner) && (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl;
        }
        if (!ownerFull) throw new IOException("Shared label metadata owner lacks full control");
    }
    private static string SharedStore(string root)
    {
        string basePath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (String.IsNullOrEmpty(basePath)) throw new IOException("Shared labels require an owner-private local application data directory");
        CheckNoReparseParents(basePath);
        string current = basePath;
        foreach (string name in new[] { "YunzaiGuard", "WindowsSandboxLabels", SharedKey(root) })
        {
            current = Path.Combine(current, name);
            if (!Directory.Exists(current))
            {
                var security = new DirectorySecurity();
                security.SetOwner(SharedOwner()); security.SetAccessRuleProtection(true, false);
                foreach (SecurityIdentifier sid in new[] { SharedOwner(), new SecurityIdentifier("S-1-5-18") })
                    security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.CreateDirectory(current, security);
                RestoreLabel(current, "S:(ML;OICI;NW;;;ME)");
            }
            CheckNoReparseParents(current);
            var acl = Directory.GetAccessControl(current);
            if (!acl.AreAccessRulesProtected) throw new IOException("Shared label directory must disable ACL inheritance");
            ValidatePrivateAcl(acl);
            string label = ReadLabel(current);
            if (label != "S:(ML;OICI;NW;;;ME)" && label != "S:AI(ML;OICI;NW;;;ME)") throw new IOException("Shared label metadata integrity label changed externally");
        }
        if (Inside(current, root) || Inside(root, current)) throw new IOException("Shared label metadata cannot overlap the sandbox project");
        return current;
    }
    private static void ValidateSharedMetadataFile(string path)
    {
        CheckNoReparseParents(path);
        var attributes = new SecurityAttributes(); attributes.length = Marshal.SizeOf(typeof(SecurityAttributes));
        IntPtr handle = CreateFileW(path, 0x80, 7, ref attributes, 3, 0x00200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "inspect shared label metadata file");
        try { InspectExactFile(handle); }
        finally { CloseHandle(handle); }
        ValidatePrivateAcl(File.GetAccessControl(path));
    }
    private static FileStream SharedStoreLock(string filename)
    {
        DateTime end = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            try
            {
                try { CheckNoReparseParents(filename); }
                catch (FileNotFoundException) { CheckNoReparseParents(Path.GetDirectoryName(filename)); }
                var stream = new FileStream(filename, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                try
                {
                    CheckNoReparseParents(filename);
                    InspectExactFile(stream.SafeFileHandle.DangerousGetHandle());
                    ValidatePrivateAcl(File.GetAccessControl(filename)); return stream;
                }
                catch { stream.Dispose(); throw; }
            }
            catch (IOException error)
            {
                int code = error.HResult & 0xffff;
                if (code != 32 && code != 33) throw;
                if (DateTime.UtcNow >= end) throw new IOException("Shared label metadata lock timed out"); Thread.Sleep(20);
            }
        }
    }
    private static FileStream ProjectAclMutationLock(string root)
    {
        // 父级 ACE 传播与子级 ACL 修改互斥；v2/v3 作用域跨登录会话共用此锁。
        return SharedStoreLock(Path.Combine(SharedStore(root), "project-acl.lock"));
    }
    private static SharedLabelLedger ReadSharedLedger(string filename, string root, string path, string identity)
    {
        if (!File.Exists(filename)) return null;
        ValidateSharedMetadataFile(filename);
        if (new FileInfo(filename).Length > 256 * 1024) throw new IOException("Shared label ledger too large");
        var ledger = new JavaScriptSerializer { MaxJsonLength = 256 * 1024, RecursionLimit = 8 }.Deserialize<SharedLabelLedger>(File.ReadAllText(filename, Encoding.UTF8));
        if (ledger == null || ledger.version != 1 || !String.Equals(ledger.root, root, StringComparison.OrdinalIgnoreCase) || !String.Equals(ledger.path, path, StringComparison.OrdinalIgnoreCase) || ledger.owner != SharedOwner().Value || ledger.identity != identity || !Regex.IsMatch(ledger.generation ?? "", "^[a-f0-9]{32}$") || ledger.originalLabel == null || ledger.originalLabel.Length > 16384 || ledger.members == null || ledger.members.Count == 0 || ledger.members.Count > 128) throw new IOException("Invalid shared label ledger");
        var tokens = new HashSet<string>(); var profiles = new HashSet<string>();
        foreach (var member in ledger.members)
        {
            if (member == null || !Regex.IsMatch(member.token ?? "", "^[a-f0-9]{32}$") || !Regex.IsMatch(member.profile ?? "", "^YunzaiGuard\\.[a-f0-9]{32}$") || member.sid != ProfileSid(member.profile) || member.journal == null || member.journal.Length > 4096 || member.brokerPid <= 0 || !Regex.IsMatch(member.brokerCreated ?? "", "^[0-9]{1,20}$") || !Regex.IsMatch(member.phase ?? "", "^(reserved|active|releasing|revoked|restoring|restored)$") || !tokens.Add(member.token) || !profiles.Add(member.profile)) throw new IOException("Invalid shared label member");
        }
        return ledger;
    }
    private static void WriteSharedLedger(string filename, SharedLabelLedger ledger)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer { MaxJsonLength = 256 * 1024, RecursionLimit = 8 }.Serialize(ledger));
        if (bytes.Length > 256 * 1024) throw new IOException("Shared label ledger too large");
        string temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            if (File.Exists(filename)) { ValidateSharedMetadataFile(filename); File.Replace(temporary, filename, null); }
            else File.Move(temporary, filename);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static void SharedCheckpoint(string stage) { /* GuardSharedLabelCheckpoint */ }
    private static void CheckSharedIdentity(SharedDirectoryPlan directory, string path)
    {
        CheckNoReparseParents(path);
        FileInformation info; Check(GetFileInformationByHandle(directory.handle, out info), "recheck shared directory identity");
        if (FileIdentity(info) != directory.identity || (info.attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != (uint)FileAttributes.Directory) throw new IOException("Shared directory changed identity or became a reparse point");
        using (var current = OpenSharedDirectory(path, directory.token, directory.identity)) { }
    }
    private static void CheckSharedLabel(SharedLabelLedger ledger, string label, SharedLabelMember retiring)
    {
        bool active = false;
        foreach (var member in ledger.members) active |= member.phase == "active" && (retiring == null || member != retiring || retiring.phase == "active");
        bool original = label == ledger.originalLabel || IsEquivalentEmptyLabel(label, ledger.originalLabel);
        if (!IsManagedLowLabel(label, ledger.originalLabel, false) && (active || !original)) throw new IOException("Shared directory integrity label changed externally; ledger retained: " + label);
    }
    private static FileSystemAccessRule SharedModifyRule(SecurityIdentifier sid)
    {
        return new FileSystemAccessRule(sid, FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow);
    }
    private static List<FileSystemAccessRule> SharedOwnRules(DirectorySecurity acl, SecurityIdentifier sid)
    {
        var result = new List<FileSystemAccessRule>(); var expected = SharedModifyRule(sid);
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier)))
        {
            if (!rule.IdentityReference.Equals(sid)) continue;
            if (rule.AccessControlType != expected.AccessControlType || rule.FileSystemRights != expected.FileSystemRights || rule.InheritanceFlags != expected.InheritanceFlags || rule.PropagationFlags != PropagationFlags.None) throw new IOException("Shared directory session ACE changed externally; ledger retained");
            result.Add(rule);
        }
        return result;
    }
    private static void CheckSharedWriters(DirectorySecurity acl, SharedLabelLedger ledger)
    {
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || !rule.IdentityReference.Value.StartsWith("S-1-15-2-", StringComparison.Ordinal) || (rule.FileSystemRights & FileSystemRights.Write) == 0) continue;
            SharedLabelMember member = null;
            foreach (var candidate in ledger.members) if (candidate.sid == rule.IdentityReference.Value) member = candidate;
            if (member == null || member.phase == "revoked" || member.phase == "restoring" || member.phase == "restored" || rule.IsInherited) throw new IOException("Shared directory has an untracked or revoked AppContainer write ACE; ledger retained");
            SharedOwnRules(acl, new SecurityIdentifier(member.sid));
        }
    }
    private static void AcquireSharedDirectory(string journal, string profile, string root, string path, SecurityIdentifier sid)
    {
        var directory = SharedDirectories[path];
        string store = SharedStore(root), filename = Path.Combine(store, SharedKey(path) + ".json");
        using (var fileLock = SharedStoreLock(filename + ".lock"))
        using (var mutex = AclMutex(path))
        {
            try
            {
                CheckSharedIdentity(directory, path);
                var ledger = ReadSharedLedger(filename, root, path, directory.identity);
                var acl = SharedHandleAcl(directory.handle);
                if (ledger == null)
                {
                    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                        if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value.StartsWith("S-1-15-2-", StringComparison.Ordinal) && (rule.FileSystemRights & FileSystemRights.Write) != 0) throw new IOException("Shared directory retains an untracked AppContainer write grant; recover its journal first");
                    ledger = new SharedLabelLedger { root = root, path = path, owner = SharedOwner().Value, identity = directory.identity, generation = Guid.NewGuid().ToString("N"), originalLabel = SharedHandleLabel(directory.handle) };
                }
                else
                {
                    CheckSharedLabel(ledger, SharedHandleLabel(directory.handle), null);
                    CheckSharedWriters(acl, ledger);
                }
                if (ledger.members.Count >= 128) throw new IOException("Shared directory has too many sessions");
                foreach (var peer in ledger.members) if (peer.token == directory.token || peer.profile == profile) throw new IOException("Duplicate shared directory session reservation");
                if (SharedOwnRules(acl, sid).Count != 0) throw new IOException("New shared directory SID already has explicit write permissions");
                var self = System.Diagnostics.Process.GetCurrentProcess();
                var member = new SharedLabelMember { token = directory.token, profile = profile, sid = sid.Value, journal = Path.GetFullPath(journal), brokerPid = self.Id, brokerCreated = self.StartTime.ToUniversalTime().Ticks.ToString(), phase = "reserved" };
                ledger.members.Add(member);
                WriteSharedLedger(filename, ledger); SharedCheckpoint("reserved");
                string low = (ledger.originalLabel.StartsWith("S:P", StringComparison.Ordinal) ? "S:P" : "S:") + "(ML;OICI;NW;;;LW)";
                SetSharedHandleLabel(directory.handle, low); SharedCheckpoint("low");
                acl.AddAccessRule(SharedModifyRule(sid)); SetSharedHandleAcl(directory.handle, acl); SharedCheckpoint("granted");
                member.phase = "active"; WriteSharedLedger(filename, ledger); SharedCheckpoint("active");
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
    private static void ReleaseSharedDirectory(string journal, JournalData data, JournalRecord record)
    {
        string root = Path.GetFullPath(data.projectRoot), path = Path.GetFullPath(record.path);
        if (!SharedBusinessPath(root, path) || !Regex.IsMatch(record.sharedLeaseToken ?? "", "^[a-f0-9]{32}$") || !Regex.IsMatch(record.fileIdentity ?? "", "^[a-f0-9]{8}:[a-f0-9]{16}$")) throw new IOException("Invalid shared directory journal reference");
        var sid = new SecurityIdentifier(data.sid);
        var expectedAce = SharedModifyRule(sid);
        if (record.aces.Count != 1 || record.aces[0].rights != (int)expectedAce.FileSystemRights || record.aces[0].type != (int)AccessControlType.Allow || record.aces[0].inheritance != (int)expectedAce.InheritanceFlags) throw new IOException("Invalid shared directory ACE journal");
        using (var directory = OpenSharedDirectory(path, record.sharedLeaseToken, record.fileIdentity))
        {
            string filename = Path.Combine(SharedStore(root), SharedKey(path) + ".json");
            using (var fileLock = SharedStoreLock(filename + ".lock"))
            using (var mutex = AclMutex(path))
            {
                try
                {
                    CheckSharedIdentity(directory, path);
                    var ledger = ReadSharedLedger(filename, root, path, directory.identity);
                    var acl = SharedHandleAcl(directory.handle); var own = SharedOwnRules(acl, sid);
                    SharedLabelMember member = null;
                    if (ledger != null) foreach (var candidate in ledger.members) if (candidate.token == record.sharedLeaseToken) member = candidate;
                    if (member == null)
                    {
                        if (own.Count != 0) throw new IOException("Missing shared directory member still has a write ACE; original label cannot be guessed");
                        return;
                    }
                    if (member.profile != data.profile || member.sid != data.sid || !String.Equals(member.journal, Path.GetFullPath(journal), StringComparison.OrdinalIgnoreCase) || member.brokerPid != data.brokerPid || member.brokerCreated != data.brokerCreated) throw new IOException("Shared directory journal member mismatch");
                    CheckSharedWriters(acl, ledger);
                    CheckSharedLabel(ledger, SharedHandleLabel(directory.handle), member);
                    member.phase = "releasing"; WriteSharedLedger(filename, ledger); SharedCheckpoint("releasing");
                    foreach (var rule in own) acl.RemoveAccessRuleSpecific(rule);
                    if (own.Count != 0) SetSharedHandleAcl(directory.handle, acl);
                    SharedCheckpoint("revoked-ace");
                    member.phase = "revoked"; WriteSharedLedger(filename, ledger); SharedCheckpoint("revoked");
                    if (ledger.members.Count > 1)
                    {
                        ledger.members.Remove(member); WriteSharedLedger(filename, ledger); SharedCheckpoint("peer-removed");
                        return;
                    }
                    member.phase = "restoring"; WriteSharedLedger(filename, ledger); SharedCheckpoint("restoring");
                    string current = SharedHandleLabel(directory.handle);
                    if (current != ledger.originalLabel && !IsEquivalentEmptyLabel(current, ledger.originalLabel)) SetSharedHandleLabel(directory.handle, ledger.originalLabel);
                    SharedCheckpoint("restored-label");
                    current = SharedHandleLabel(directory.handle);
                    if (current != ledger.originalLabel && !IsEquivalentEmptyLabel(current, ledger.originalLabel)) throw new IOException("Original shared directory label restoration is unconfirmed");
                    member.phase = "restored"; WriteSharedLedger(filename, ledger); SharedCheckpoint("restored");
                    File.Delete(filename); SharedCheckpoint("ledger-deleted");
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
    }
}
