// 控制目录不继承项目的 AppContainer 读权限；跨会话恢复权限，不迁移业务文件。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static partial class GuardSandbox
{
    public sealed class DeniedDirectoryLedger
    {
        public int version = 1;
        public string root, path, owner, identity, generation, originalDacl, protectedDacl, restoreDacl;
        public List<SharedLabelMember> members = new List<SharedLabelMember>();
    }
    private static readonly Dictionary<string, SharedDirectoryPlan> DeniedDirectories = new Dictionary<string, SharedDirectoryPlan>(StringComparer.OrdinalIgnoreCase);
    private static void DeniedCheckpoint(string stage) { /* GuardDeniedDirectoryCheckpoint */ }
    private static string DeniedLedgerPath(string root, string path)
    {
        return Path.Combine(SharedStore(root), "deny-" + SharedKey(path) + ".json");
    }
    private static void PrepareDeniedDirectories(string root, List<string> paths)
    {
        foreach (string path in paths)
        {
            if (!Inside(path, root) || path.Equals(root, StringComparison.OrdinalIgnoreCase) || DeniedDirectories.ContainsKey(path)) throw new IOException("Denied control directories must be distinct real project children");
            DeniedDirectories.Add(path, OpenSharedDirectory(path, Guid.NewGuid().ToString("N"), null));
        }
    }
    private static void ValidateOrdinaryDeniedAcl(DirectorySecurity acl)
    {
        var raw = new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(), 0);
        if (raw.DiscretionaryAcl == null || !acl.AreAccessRulesCanonical) throw new IOException("Denied directory requires an ordinary canonical ACL");
        foreach (GenericAce ace in raw.DiscretionaryAcl)
        {
            var common = ace as CommonAce;
            if (common == null || common.IsCallback || common.OpaqueLength != 0 || (common.AceQualifier != AceQualifier.AccessAllowed && common.AceQualifier != AceQualifier.AccessDenied)) throw new IOException("Unsupported denied-directory ACL entry; no permissions changed");
        }
    }
    private static DirectorySecurity ParseDeniedAcl(string text)
    {
        if (text == null || text.Length > 65536) throw new IOException("Invalid denied-directory ACL snapshot");
        var acl = new DirectorySecurity(); acl.SetSecurityDescriptorSddlForm(text, AccessControlSections.Access); ValidateOrdinaryDeniedAcl(acl); return acl;
    }
    private static DirectorySecurity ProtectedDeniedBaseline(DirectorySecurity before)
    {
        ValidateOrdinaryDeniedAcl(before);
        foreach (FileSystemAccessRule rule in before.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value.StartsWith("S-1-15-", StringComparison.Ordinal)) throw new IOException("Denied directory has an untracked AppContainer read grant; recover earlier scopes first");
        if (before.AreAccessRulesProtected) return ParseDeniedAcl(before.GetSecurityDescriptorSddlForm(AccessControlSections.Access));
        var result = new DirectorySecurity(); result.SetAccessRuleProtection(true, false);
        foreach (FileSystemAccessRule rule in before.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value.StartsWith("S-1-15-", StringComparison.Ordinal)) throw new IOException("Denied directory has an untracked AppContainer read grant; recover earlier scopes first");
            result.AddAccessRule(new FileSystemAccessRule((SecurityIdentifier)rule.IdentityReference, rule.FileSystemRights, rule.InheritanceFlags, rule.PropagationFlags, rule.AccessControlType));
        }
        return result;
    }
    private static void SetDeniedHandleAcl(IntPtr handle, DirectorySecurity acl, string expectedBefore)
    {
        ValidateOrdinaryDeniedAcl(acl);
        if (SharedHandleAcl(handle).GetSecurityDescriptorSddlForm(AccessControlSections.Access) != expectedBefore) throw new IOException("Denied-directory ACL changed before update; ledger retained");
        byte[] bytes = acl.GetSecurityDescriptorBinaryForm(); IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length); bool present, defaulted; IntPtr dacl;
            Check(GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted), "extract denied-directory ACL");
            if (!present) throw new IOException("Denied-directory ACL unexpectedly absent");
            uint info = 4u | (acl.AreAccessRulesProtected ? 0x80000000u : 0x20000000u);
            uint error = SetSecurityInfo(handle, 1, info, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new System.ComponentModel.Win32Exception((int)error, "set denied-directory inheritance");
            if (SharedHandleAcl(handle).AreAccessRulesProtected != acl.AreAccessRulesProtected) throw new IOException("Denied-directory inheritance update is unconfirmed");
        }
        finally { Marshal.FreeHGlobal(descriptor); }
    }
    private static DeniedDirectoryLedger ReadDeniedLedger(string filename, string root, string path, string identity)
    {
        if (!File.Exists(filename)) return null;
        ValidateSharedMetadataFile(filename);
        if (new FileInfo(filename).Length > 512 * 1024) throw new IOException("Denied-directory ledger too large");
        var ledger = new JavaScriptSerializer { MaxJsonLength = 512 * 1024, RecursionLimit = 8 }.Deserialize<DeniedDirectoryLedger>(File.ReadAllText(filename, Encoding.UTF8));
        if (ledger == null || ledger.version != 1 || !String.Equals(ledger.root, root, StringComparison.OrdinalIgnoreCase) || !String.Equals(ledger.path, path, StringComparison.OrdinalIgnoreCase) || ledger.owner != SharedOwner().Value || ledger.identity != identity || !Regex.IsMatch(ledger.generation ?? "", "^[a-f0-9]{32}$") || ledger.members == null || ledger.members.Count == 0 || ledger.members.Count > 128) throw new IOException("Invalid denied-directory ledger");
        ParseDeniedAcl(ledger.originalDacl); if (!ParseDeniedAcl(ledger.protectedDacl).AreAccessRulesProtected) throw new IOException("Denied-directory ledger lacks a protected baseline");
        if (ledger.restoreDacl != null) ParseDeniedAcl(ledger.restoreDacl);
        var tokens = new HashSet<string>(); var profiles = new HashSet<string>();
        foreach (var member in ledger.members)
            if (member == null || !Regex.IsMatch(member.token ?? "", "^[a-f0-9]{32}$") || !Regex.IsMatch(member.profile ?? "", "^YunzaiGuard\\.[a-f0-9]{32}$") || member.sid != ProfileSid(member.profile) || member.journal == null || member.journal.Length > 4096 || member.brokerPid <= 0 || !Regex.IsMatch(member.brokerCreated ?? "", "^[0-9]{1,20}$") || !Regex.IsMatch(member.phase ?? "", "^(reserved|active|releasing|revoked|restoring|restored)$") || !tokens.Add(member.token) || !profiles.Add(member.profile)) throw new IOException("Invalid denied-directory member");
        return ledger;
    }
    private static void WriteDeniedLedger(string filename, DeniedDirectoryLedger ledger)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer { MaxJsonLength = 512 * 1024, RecursionLimit = 8 }.Serialize(ledger));
        if (bytes.Length > 512 * 1024) throw new IOException("Denied-directory ledger too large");
        string temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            if (File.Exists(filename)) { ValidateSharedMetadataFile(filename); File.Replace(temporary, filename, null); } else File.Move(temporary, filename);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static string DeniedRuleKey(FileSystemAccessRule rule, bool mask)
    {
        return rule.IdentityReference.Value + ":" + (int)rule.AccessControlType + ":" + (int)rule.InheritanceFlags + ":" + (int)rule.PropagationFlags + (mask ? ":" + (int)rule.FileSystemRights : "");
    }
    private static Dictionary<string, List<FileSystemAccessRule>> DeniedRuleGroups(DirectorySecurity acl)
    {
        var result = new Dictionary<string, List<FileSystemAccessRule>>();
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier)))
        {
            string key = DeniedRuleKey(rule, false); List<FileSystemAccessRule> group;
            if (!result.TryGetValue(key, out group)) result[key] = group = new List<FileSystemAccessRule>(); group.Add(rule);
        }
        return result;
    }
    private static bool SameDeniedRules(List<FileSystemAccessRule> left, List<FileSystemAccessRule> right)
    {
        if (left.Count != right.Count) return false;
        var keys = new List<string>(); foreach (var rule in right) keys.Add(DeniedRuleKey(rule, true));
        foreach (var rule in left) if (!keys.Remove(DeniedRuleKey(rule, true))) return false;
        return true;
    }
    private static void CheckDeniedProtected(DirectorySecurity acl, DeniedDirectoryLedger ledger)
    {
        ValidateOrdinaryDeniedAcl(acl);
        if (!acl.AreAccessRulesProtected) throw new IOException("Denied-directory inheritance changed externally; ledger retained");
        var expected = DeniedRuleGroups(ParseDeniedAcl(ledger.protectedDacl)); var actual = DeniedRuleGroups(acl);
        foreach (var pair in expected)
        {
            List<FileSystemAccessRule> group;
            if (!actual.TryGetValue(pair.Key, out group) || !SameDeniedRules(pair.Value, group)) throw new IOException("Denied-directory baseline ACL changed externally; ledger retained");
        }
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value.StartsWith("S-1-15-", StringComparison.Ordinal)) throw new IOException("Denied directory acquired an AppContainer allow ACE; ledger retained");
    }
    private static void RecoverDeniedDirectoryLeases(string root)
    {
        var journals = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in DeniedDirectories)
        {
            string filename = DeniedLedgerPath(root, pair.Key);
            using (var fileLock = SharedStoreLock(filename + ".lock"))
            {
                var ledger = ReadDeniedLedger(filename, root, pair.Key, pair.Value.identity);
                if (ledger == null) continue;
                foreach (var member in ledger.members)
                {
                    bool alive = false;
                    try { using (var process = System.Diagnostics.Process.GetProcessById(member.brokerPid)) alive = !process.HasExited && process.StartTime.ToUniversalTime().Ticks.ToString() == member.brokerCreated; }
                    catch (ArgumentException) { }
                    if (!alive)
                    {
                        if (!File.Exists(member.journal)) throw new IOException("Denied-directory recovery journal is missing; ledger retained");
                        journals.Add(member.journal);
                    }
                }
            }
        }
        foreach (string journal in journals) Cleanup(journal);
    }
    private static void AcquireDeniedDirectory(string journal, string profile, string root, string path)
    {
        var directory = DeniedDirectories[path]; string filename = DeniedLedgerPath(root, path);
        using (var fileLock = SharedStoreLock(filename + ".lock"))
        using (var mutex = AclMutex(path))
        {
            try
            {
                CheckSharedIdentity(directory, path); var acl = SharedHandleAcl(directory.handle);
                var ledger = ReadDeniedLedger(filename, root, path, directory.identity);
                if (ledger == null)
                {
                    var protectedAcl = ProtectedDeniedBaseline(acl);
                    ledger = new DeniedDirectoryLedger { root = root, path = path, owner = SharedOwner().Value, identity = directory.identity, generation = Guid.NewGuid().ToString("N"), originalDacl = acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access), protectedDacl = protectedAcl.GetSecurityDescriptorSddlForm(AccessControlSections.Access) };
                }
                else CheckDeniedProtected(acl, ledger);
                if (ledger.members.Count >= 128) throw new IOException("Denied directory has too many sessions");
                foreach (var peer in ledger.members) if (peer.token == directory.token || peer.profile == profile) throw new IOException("Duplicate denied-directory session reservation");
                var self = System.Diagnostics.Process.GetCurrentProcess();
                var member = new SharedLabelMember { token = directory.token, profile = profile, sid = ProfileSid(profile), journal = Path.GetFullPath(journal), brokerPid = self.Id, brokerCreated = self.StartTime.ToUniversalTime().Ticks.ToString(), phase = "reserved" };
                ledger.members.Add(member); WriteDeniedLedger(filename, ledger); DeniedCheckpoint("reserved");
                if (!acl.AreAccessRulesProtected) SetDeniedHandleAcl(directory.handle, ParseDeniedAcl(ledger.protectedDacl), acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access));
                CheckDeniedProtected(SharedHandleAcl(directory.handle), ledger); DeniedCheckpoint("protected");
                member.phase = "active"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("active");
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
    private static void CheckDeniedAncestors(string root, string path)
    {
        for (string cursor = Path.GetDirectoryName(path); Inside(cursor, root); cursor = Path.GetDirectoryName(cursor))
        {
            foreach (FileSystemAccessRule rule in Directory.GetAccessControl(cursor).GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value.StartsWith("S-1-15-", StringComparison.Ordinal) && (rule.InheritanceFlags & (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)) != 0) throw new IOException("Denied-directory ancestor retains an AppContainer read grant; protection retained");
            if (cursor.Equals(root, StringComparison.OrdinalIgnoreCase)) break;
        }
    }
    private static DirectorySecurity RestoreDeniedInheritance(DirectorySecurity current, DeniedDirectoryLedger ledger)
    {
        CheckDeniedProtected(current, ledger);
        var original = ParseDeniedAcl(ledger.originalDacl);
        var before = DeniedRuleGroups(original); var baseline = DeniedRuleGroups(ParseDeniedAcl(ledger.protectedDacl));
        foreach (var pair in baseline)
        {
            List<FileSystemAccessRule> prior;
            if (!before.TryGetValue(pair.Key, out prior)) prior = new List<FileSystemAccessRule>();
            if (SameDeniedRules(pair.Value, prior)) continue;
            foreach (var rule in pair.Value) current.RemoveAccessRuleSpecific(rule);
            foreach (var rule in prior) current.AddAccessRule(rule);
        }
        current.SetAccessRuleProtection(original.AreAccessRulesProtected, false); return current;
    }
    private static void CheckDeniedRestored(DirectorySecurity current, DeniedDirectoryLedger ledger)
    {
        ValidateOrdinaryDeniedAcl(current);
        if (ledger.restoreDacl == null) throw new IOException("Denied-directory restoration intent is missing; ledger retained");
        var intent = ParseDeniedAcl(ledger.restoreDacl);
        if (current.AreAccessRulesProtected != intent.AreAccessRulesProtected) throw new IOException("Denied-directory restored inheritance changed externally; ledger retained");
        var expected = DeniedRuleGroups(intent); var actual = DeniedRuleGroups(current);
        foreach (var pair in expected)
        {
            List<FileSystemAccessRule> group;
            if (!actual.TryGetValue(pair.Key, out group) || !SameDeniedRules(pair.Value, group)) throw new IOException("Denied-directory restoration intent does not match current ACL; ledger retained");
        }
        var original = DeniedRuleGroups(ParseDeniedAcl(ledger.originalDacl));
        foreach (var pair in DeniedRuleGroups(ParseDeniedAcl(ledger.protectedDacl)))
        {
            List<FileSystemAccessRule> before, wanted, now;
            if (!original.TryGetValue(pair.Key, out before)) before = new List<FileSystemAccessRule>();
            if (SameDeniedRules(pair.Value, before)) continue;
            if (!expected.TryGetValue(pair.Key, out wanted)) wanted = new List<FileSystemAccessRule>();
            if (!actual.TryGetValue(pair.Key, out now)) now = new List<FileSystemAccessRule>();
            if (!SameDeniedRules(wanted, now)) throw new IOException("Denied-directory promotion remains or changed externally; ledger retained");
        }
    }
    private static void ReleaseDeniedDirectory(string journal, JournalData data, JournalRecord record)
    {
        string root = Path.GetFullPath(data.projectRoot), path = Path.GetFullPath(record.path);
        if (data.version != 4 || record.isFile || record.restoreLabel || record.sharedLeaseToken != null || !Regex.IsMatch(record.deniedLeaseToken ?? "", "^[a-f0-9]{32}$") || !Regex.IsMatch(record.fileIdentity ?? "", "^[a-f0-9]{8}:[a-f0-9]{16}$")) throw new IOException("Invalid denied-directory journal reference");
        var sid = new SecurityIdentifier(data.sid);
        var expected = new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Deny);
        if (record.aces.Count != 1 || record.aces[0].rights != (int)expected.FileSystemRights || record.aces[0].type != (int)expected.AccessControlType || record.aces[0].inheritance != (int)expected.InheritanceFlags) throw new IOException("Invalid denied-directory ACE journal");
        using (var directory = OpenSharedDirectory(path, record.deniedLeaseToken, record.fileIdentity))
        {
            string filename = DeniedLedgerPath(root, path);
            using (var fileLock = SharedStoreLock(filename + ".lock"))
            using (var mutex = AclMutex(path))
            {
                try
                {
                    CheckSharedIdentity(directory, path); var acl = SharedHandleAcl(directory.handle);
                    var ledger = ReadDeniedLedger(filename, root, path, directory.identity); var own = new List<FileSystemAccessRule>();
                    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                        if (rule.IdentityReference.Equals(sid)) { if (DeniedRuleKey(rule, true) != DeniedRuleKey(expected, true)) throw new IOException("Denied-directory session ACE changed externally; ledger retained"); own.Add(rule); }
                    SharedLabelMember member = null; if (ledger != null) foreach (var candidate in ledger.members) if (candidate.token == record.deniedLeaseToken) member = candidate;
                    if (member == null) { if (own.Count != 0) throw new IOException("Denied-directory member missing while its ACE remains"); return; }
                    if (member.profile != data.profile || member.sid != data.sid || !String.Equals(member.journal, Path.GetFullPath(journal), StringComparison.OrdinalIgnoreCase) || member.brokerPid != data.brokerPid || member.brokerCreated != data.brokerCreated) throw new IOException("Denied-directory journal member mismatch");
                    bool originalProtected = ParseDeniedAcl(ledger.originalDacl).AreAccessRulesProtected;
                    bool neverProtected = member.phase == "reserved" && ledger.members.Count == 1 && !acl.AreAccessRulesProtected && !originalProtected;
                    bool restored = (member.phase == "restoring" || member.phase == "restored") && ledger.members.Count == 1 && acl.AreAccessRulesProtected == originalProtected && own.Count == 0;
                    if (restored) CheckDeniedRestored(acl, ledger);
                    if (!neverProtected && !restored) CheckDeniedProtected(acl, ledger);
                    if (neverProtected || restored)
                    {
                        if (own.Count != 0) throw new IOException("Unapplied or restored denied-directory lease retains a session ACE");
                        CheckDeniedAncestors(root, path);
                        if (neverProtected) ledger.restoreDacl = acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                        member.phase = "restoring"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("restoring");
                        DeniedCheckpoint("restored-acl"); member.phase = "restored"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("restored");
                        File.Delete(filename); DeniedCheckpoint("ledger-deleted"); return;
                    }
                    member.phase = "releasing"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("releasing");
                    string beforeRevocation = acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                    foreach (var rule in own) acl.RemoveAccessRuleSpecific(rule);
                    if (own.Count != 0) SetDeniedHandleAcl(directory.handle, acl, beforeRevocation);
                    DeniedCheckpoint("revoked-ace"); member.phase = "revoked"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("revoked");
                    if (ledger.members.Count > 1) { ledger.members.Remove(member); WriteDeniedLedger(filename, ledger); DeniedCheckpoint("peer-removed"); return; }
                    CheckDeniedAncestors(root, path);
                    var restoring = SharedHandleAcl(directory.handle);
                    string beforeRestore = restoring.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                    var intended = RestoreDeniedInheritance(restoring, ledger);
                    ledger.restoreDacl = intended.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                    member.phase = "restoring"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("restoring");
                    SetDeniedHandleAcl(directory.handle, intended, beforeRestore);
                    DeniedCheckpoint("restored-acl");
                    if (SharedHandleAcl(directory.handle).AreAccessRulesProtected != originalProtected) throw new IOException("Original denied-directory inheritance restoration is unconfirmed");
                    CheckDeniedRestored(SharedHandleAcl(directory.handle), ledger);
                    member.phase = "restored"; WriteDeniedLedger(filename, ledger); DeniedCheckpoint("restored");
                    File.Delete(filename); DeniedCheckpoint("ledger-deleted");
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
    }
}
