using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace YunzaiGuard.ProcessIdentity {
  // 仅允许真实调用进程的父子关系建立会话；不接受客体指定的信号、程序或目标。
  public static class Program {
    const uint Query = 0x1000, QueryFull = 0x400, Sync = 0x100000, Terminate = 1;
    const uint RemoteRights = 2 | 0x400 | 8 | 0x20 | 0x10 | Sync;
    const uint Signalled = 0, Timeout = 258;
    const int MaxFrame = 65536, MaxRecords = 256, MaxRequests = 64, MaxCensusRows = 65536;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxFrame, RecursionLimit = 12 };
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly Dictionary<string, Record> Records = new Dictionary<string, Record>();
    static readonly Dictionary<uint, Record> ByPid = new Dictionary<uint, Record>();
    static readonly Stream Input = Console.OpenStandardInput();
    static string Nonce, Role = "new", Binding;
    static long RequestId, LastProbe, LastConnection, CaptureSerial;
    static double Deadline = 10000;
    static bool Opened, ActivationAttempted, ActionStarted, ActivationAvailable;
    static string UnavailableReason = "UNSUPPORTED_NODE_PROFILE";
    static ProcessRef Caller, Root, Parent;
    static IntPtr ImageBase;
    static uint ImageSize;

    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
    [StructLayout(LayoutKind.Sequential)] struct BasicInfo {
      public IntPtr Reserved, Peb, Affinity, Priority;
      public UIntPtr Pid, ParentPid;
    }
    [StructLayout(LayoutKind.Sequential)] struct ModuleInfo { public IntPtr Base; public uint Size; public IntPtr Entry; }
    [StructLayout(LayoutKind.Sequential)] struct MemoryInfo {
      public IntPtr Base, AllocationBase; public uint AllocationProtect;
      public UIntPtr RegionSize; public uint State, Protect, Type;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, out BasicInfo result, int length, out int returned);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool EnumProcessModulesEx(IntPtr process, [Out] IntPtr[] modules, int size, out int needed, uint filter);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool GetModuleInformation(IntPtr process, IntPtr module, out ModuleInfo info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, [Out] byte[] output, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)] static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryInfo info, UIntPtr size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenFileMappingW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr MapViewOfFile(IntPtr mapping, uint access, uint high, uint low, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern bool UnmapViewOfFile(IntPtr view);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, UIntPtr stack, IntPtr start, IntPtr parameter, uint flags, IntPtr id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeThread(IntPtr thread, out uint code);

    sealed class Failure : Exception {
      public readonly string Code, Result; public readonly int SystemCode;
      public Failure(string code, string result = "refused-before-action", int systemCode = 0) { Code = code; Result = result; SystemCode = systemCode; }
    }
    sealed class ProcessRef : IDisposable {
      public uint Pid; public IntPtr Handle; public ulong Birth; public bool CanTerminate;
      public object Identity { get { return Obj("pid", Pid, "birth", Obj("kind", "windows-filetime-100ns", "value", Birth.ToString(CultureInfo.InvariantCulture))); } }
      public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; } }
    }
    sealed class Record {
      public string Id; public ProcessRef Process; public uint ParentPid;
      public object Wire { get { return Obj("recordId", Id, "identity", Process.Identity, "parentPid", ParentPid); } }
    }
    sealed class Metadata { public uint Pid, Parent; public ulong Birth; public bool Known; }
    sealed class TerminationState {
      public Record Record; public string Result = "unknown"; public int Code;
      public bool Requested, Wait;
      public object Wire { get { return Code == 0 ? Obj("recordId", Record.Id, "result", Result) : Obj("recordId", Record.Id, "result", Result, "systemCode", Code); } }
    }
    sealed class ObservationTimeout : Exception { }

    static Dictionary<string, object> Obj(params object[] pairs) {
      var value = new Dictionary<string, object>();
      for (int i = 0; i < pairs.Length; i += 2) value.Add((string)pairs[i], pairs[i + 1]);
      return value;
    }
    static string Token() { var bytes = new byte[16]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    static void CheckDeadline() { if (Clock.Elapsed.TotalMilliseconds >= Deadline) throw new Failure("DEADLINE", ActionStarted ? "started-unconfirmed" : "refused-before-action"); }
    static uint Remaining() { CheckDeadline(); return (uint)Math.Max(1, Math.Min(int.MaxValue, Math.Floor(Deadline - Clock.Elapsed.TotalMilliseconds))); }
    static string Text(IDictionary<string, object> value, string key, string pattern) {
      object item; if (!value.TryGetValue(key, out item) || !(item is string) || !Regex.IsMatch((string)item, pattern, RegexOptions.CultureInvariant)) throw new Failure("STATE_OR_REQUEST_INVALID"); return (string)item;
    }
    static long Number(IDictionary<string, object> value, string key, long max = 2147483647) {
      object item; if (!value.TryGetValue(key, out item) || (!(item is int) && !(item is long))) throw new Failure("STATE_OR_REQUEST_INVALID");
      long n = Convert.ToInt64(item, CultureInfo.InvariantCulture); if (n < 1 || n > max) throw new Failure("STATE_OR_REQUEST_INVALID"); return n;
    }
    static void Keys(IDictionary<string, object> value, params string[] extra) {
      var allowed = new HashSet<string>(new string[] { "protocol", "sessionNonce", "requestId", "remainingBudgetMs", "command" }); foreach (string key in extra) allowed.Add(key);
      foreach (string key in value.Keys) if (!allowed.Contains(key)) throw new Failure("STATE_OR_REQUEST_INVALID");
    }
    static void ExactKeys(IDictionary<string, object> value, params string[] keys) {
      if (value.Count != keys.Length) throw new Failure("STATE_OR_REQUEST_INVALID"); foreach (string key in keys) if (!value.ContainsKey(key)) throw new Failure("STATE_OR_REQUEST_INVALID");
    }
    static void Reply(string type, Dictionary<string, object> details) {
      var value = Obj("protocol", 1, "sessionNonce", Nonce, "requestId", RequestId, "type", type);
      foreach (var item in details) value.Add(item.Key, item.Value);
      string line = Json.Serialize(value); if (Utf8.GetByteCount(line) + 1 > MaxFrame) throw new Failure("FRAME_OR_SCOPE_LIMIT"); Console.Out.WriteLine(line); Console.Out.Flush();
    }
    static string ReadBoundedLine() {
      using (var bytes = new MemoryStream()) {
        int b; while ((b = Input.ReadByte()) >= 0) { if (b == 10) return Utf8.GetString(bytes.ToArray()); if (b == 13 || bytes.Length + 1 >= MaxFrame) throw new Failure("FRAME_OR_SCOPE_LIMIT"); bytes.WriteByte((byte)b); }
        if (bytes.Length != 0) throw new Failure("STATE_OR_REQUEST_INVALID"); return null;
      }
    }
    static void RejectDuplicateKeys(string line) {
      var sets = new Stack<HashSet<string>>();
      for (int i = 0; i < line.Length; i++) {
        if (line[i] == '{') sets.Push(new HashSet<string>(StringComparer.Ordinal));
        else if (line[i] == '}') { if (sets.Count == 0) throw new Failure("STATE_OR_REQUEST_INVALID"); sets.Pop(); }
        else if (line[i] == '"') {
          int start = i++, end; for (; i < line.Length; i++) { if (line[i] == '\\') i++; else if (line[i] == '"') break; } end = i;
          if (end >= line.Length) throw new Failure("STATE_OR_REQUEST_INVALID"); int next = end + 1; while (next < line.Length && Char.IsWhiteSpace(line[next])) next++;
          if (next < line.Length && line[next] == ':') { string key = Json.Deserialize<string>(line.Substring(start, end - start + 1)); if (sets.Count == 0 || !sets.Peek().Add(key)) throw new Failure("STATE_OR_REQUEST_INVALID"); }
        }
      }
      if (sets.Count != 0) throw new Failure("STATE_OR_REQUEST_INVALID");
    }
    static ProcessRef Open(uint pid, uint rights) {
      CheckDeadline(); var handle = OpenProcess(rights, false, pid); if (handle == IntPtr.Zero) throw new Failure("ACCESS_DENIED", "refused-before-action", Marshal.GetLastWin32Error());
      try { FileTime c, e, k, u; if (!GetProcessTimes(handle, out c, out e, out k, out u) || c.Value == 0) throw new Failure("IDENTITY_UNKNOWN", "refused-before-action", Marshal.GetLastWin32Error()); return new ProcessRef { Pid = pid, Handle = handle, Birth = c.Value, CanTerminate = (rights & Terminate) != 0 }; }
      catch { CloseHandle(handle); throw; }
    }
    static bool Alive(ProcessRef value) { CheckDeadline(); uint state = WaitForSingleObject(value.Handle, 0); if (state == Timeout) return true; if (state == Signalled) return false; throw new Failure("NATIVE_OPERATION_UNKNOWN", "unknown", Marshal.GetLastWin32Error()); }
    static uint NativeParent(IntPtr handle) { BasicInfo info; int returned; if (NtQueryInformationProcess(handle, 0, out info, Marshal.SizeOf(typeof(BasicInfo)), out returned) != 0 || returned < Marshal.SizeOf(typeof(BasicInfo))) throw new Failure("RELATIONSHIP_UNKNOWN"); ulong id = info.ParentPid.ToUInt64(); if (id <= 1 || id > int.MaxValue) throw new Failure("RELATIONSHIP_UNKNOWN"); return (uint)id; }
    static void BindCaller() {
      uint pid = NativeParent(GetCurrentProcess()); Caller = Open(pid, Query | Sync);
      using (var self = Open((uint)Process.GetCurrentProcess().Id, Query | Sync)) if (Caller.Birth > self.Birth || !Alive(Caller)) throw new Failure("ROOT_OR_PARENT_CHANGED");
    }
    static bool SameNativeBirth(ProcessRef process) { FileTime c, e, k, u; return GetProcessTimes(process.Handle, out c, out e, out k, out u) && c.Value == process.Birth; }
    static void LiveParent() {
      if (!Alive(Caller) || !Alive(Parent) || !SameNativeBirth(Caller) || !SameNativeBirth(Parent) || NativeParent(Caller.Handle) != Parent.Pid || Parent.Birth > Caller.Birth) throw new Failure("ROOT_OR_PARENT_CHANGED");
    }
    static void ExpectedParent(object raw) {
      var identity = raw as Dictionary<string, object>; if (identity == null) throw new Failure("STATE_OR_REQUEST_INVALID"); ExactKeys(identity, "pid", "birth");
      var birth = identity["birth"] as Dictionary<string, object>; if (birth == null) throw new Failure("STATE_OR_REQUEST_INVALID"); ExactKeys(birth, "kind", "value");
      if (Number(identity, "pid") != Parent.Pid || Text(birth, "kind", "^windows-filetime-100ns$") != "windows-filetime-100ns" || Text(birth, "value", "^[0-9]{1,20}$") != Parent.Birth.ToString(CultureInfo.InvariantCulture)) throw new Failure("ROOT_OR_PARENT_CHANGED");
    }
    static byte[] ReadMemory(IntPtr address, int length) {
      CheckDeadline(); if (length < 1 || length > 65536) throw new Failure("UNSUPPORTED_NODE_PROFILE"); byte[] result = new byte[length]; UIntPtr actual;
      if (!ReadProcessMemory(Parent.Handle, address, result, (UIntPtr)(uint)length, out actual) || actual.ToUInt64() != (ulong)length) throw new Failure("UNSUPPORTED_NODE_PROFILE"); return result;
    }
    static IntPtr Rva(uint rva, uint length) {
      if (rva > ImageSize || length > ImageSize - rva) throw new Failure("UNSUPPORTED_NODE_PROFILE"); return new IntPtr(checked(ImageBase.ToInt64() + rva));
    }
    static uint U32(byte[] bytes, int offset) { if (offset < 0 || offset > bytes.Length - 4) throw new Failure("UNSUPPORTED_NODE_PROFILE"); return BitConverter.ToUInt32(bytes, offset); }
    static ushort U16(byte[] bytes, int offset) { if (offset < 0 || offset > bytes.Length - 2) throw new Failure("UNSUPPORTED_NODE_PROFILE"); return BitConverter.ToUInt16(bytes, offset); }
    static uint ResourceChild(uint rootRva, uint rootLength, uint offset, int wanted, bool directory) {
      if (offset > rootLength || rootLength - offset < 16) throw new Failure("UNSUPPORTED_NODE_PROFILE"); byte[] header = ReadMemory(Rva(rootRva + offset, 16), 16);
      int count = U16(header, 12) + U16(header, 14); if (count < 1 || count > 256 || rootLength - offset - 16 < (uint)(count * 8)) throw new Failure("UNSUPPORTED_NODE_PROFILE");
      byte[] entries = ReadMemory(Rva(rootRva + offset + 16, (uint)(count * 8)), count * 8);
      for (int i = 0; i < count; i++) { uint name = U32(entries, i * 8), child = U32(entries, i * 8 + 4); if ((name & 0x80000000) != 0 || (wanted >= 0 && name != (uint)wanted)) continue; if (((child & 0x80000000) != 0) != directory) continue; return child & 0x7fffffff; }
      throw new Failure("UNSUPPORTED_NODE_PROFILE");
    }
    static bool QualifyMappedNode() {
      // 通过同一进程句柄读取已映射的 PE 和资源，避免磁盘路径被替换。
      IntPtr[] modules = new IntPtr[1]; int needed; ModuleInfo module;
      if (!EnumProcessModulesEx(Parent.Handle, modules, IntPtr.Size, out needed, 2) || needed < IntPtr.Size || !GetModuleInformation(Parent.Handle, modules[0], out module, Marshal.SizeOf(typeof(ModuleInfo)))) return false;
      ImageBase = module.Base; ImageSize = module.Size; if (ImageBase == IntPtr.Zero || ImageSize < 4096 || ImageSize > 512 * 1024 * 1024) return false;
      byte[] dos = ReadMemory(ImageBase, 64); if (U16(dos, 0) != 0x5a4d) return false; uint peOffset = U32(dos, 60); byte[] pe = ReadMemory(Rva(peOffset, 288), 288);
      if (U32(pe, 0) != 0x4550 || U16(pe, 4) != 0x8664 || U16(pe, 24) != 0x20b || U16(pe, 20) < 136 || U32(pe, 24 + 108) < 3) return false;
      uint resources = U32(pe, 24 + 112 + 16), size = U32(pe, 24 + 112 + 20); if (resources == 0 || size < 16 || size > 16 * 1024 * 1024) return false; Rva(resources, size);
      uint type = ResourceChild(resources, size, 0, 16, true), name = ResourceChild(resources, size, type, -1, true), language = ResourceChild(resources, size, name, -1, false);
      if (language > size || size - language < 16) return false; byte[] data = ReadMemory(Rva(resources + language, 16), 16); uint bodyRva = U32(data, 0), bodySize = U32(data, 4);
      if (bodySize < 52 || bodySize > 65536) return false; byte[] body = ReadMemory(Rva(bodyRva, bodySize), (int)bodySize);
      if (U16(body, 0) > body.Length || U16(body, 2) < 52) return false; byte[] key = Encoding.Unicode.GetBytes("VS_VERSION_INFO\0"); for (int i = 0; i < key.Length; i++) if (body[6 + i] != key[i]) return false;
      int value = (6 + key.Length + 3) & ~3; return U32(body, value) == 0xfeef04bd && U32(body, value + 8) == ((24u << 16) | 22u) && U32(body, value + 12) == (1u << 16);
    }
    static bool ExecutableHandler(IntPtr address) {
      long pointer = address.ToInt64(), start = ImageBase.ToInt64(); if (pointer < start || pointer - start >= ImageSize) return false;
      MemoryInfo info; if (VirtualQueryEx(Parent.Handle, address, out info, (UIntPtr)(uint)Marshal.SizeOf(typeof(MemoryInfo))) == UIntPtr.Zero) return false;
      uint protect = info.Protect & 0xff; return info.State == 0x1000 && info.Type == 0x1000000 && (info.Protect & 0x100) == 0 && (protect == 0x10 || protect == 0x20 || protect == 0x40 || protect == 0x80);
    }
    static void OpenRoot(IDictionary<string, object> request) {
      Keys(request, "rootPid", "sessionBudgetMs"); if (Role != "new") throw new Failure("STATE_OR_REQUEST_INVALID"); BindCaller();
      Root = Open((uint)Number(request, "rootPid"), Query | Sync); if (!Alive(Root) || Root.Birth < Caller.Birth || NativeParent(Root.Handle) != Caller.Pid) throw new Failure("RELATIONSHIP_UNKNOWN");
      Role = "root"; Binding = Token(); Reply("root-ready", Obj("rootBindingToken", Binding, "root", Root.Identity, "caller", Caller.Identity, "nativeRelation", "caller-direct-child"));
    }
    static void CheckObservation(double end) { CheckDeadline(); if (Clock.Elapsed.TotalMilliseconds >= end) throw new ObservationTimeout(); }
    static Dictionary<uint, Metadata> Census(double end, out HashSet<uint> duplicates, out List<Metadata> invalid) {
      var map = new Dictionary<uint, Metadata>(); int censusRows = 0; duplicates = new HashSet<uint>(); invalid = new List<Metadata>();
      CheckObservation(end);
      var options = new EnumerationOptions { ReturnImmediately = false, Rewindable = false, Timeout = TimeSpan.FromMilliseconds(Math.Max(1, Math.Min(Remaining(), end - Clock.Elapsed.TotalMilliseconds))) };
      using (var searcher = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\cimv2"), new ObjectQuery("SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process"), options))
      using (var rows = searcher.Get()) foreach (ManagementObject row in rows) using (row) {
        if (++censusRows > MaxCensusRows) throw new Failure("FRAME_OR_SCOPE_LIMIT");
        CheckObservation(end); var item = new Metadata();
        try { item.Pid = Convert.ToUInt32(row["ProcessId"], CultureInfo.InvariantCulture); item.Parent = Convert.ToUInt32(row["ParentProcessId"], CultureInfo.InvariantCulture); string created = row["CreationDate"] as string; if (String.IsNullOrEmpty(created)) throw new FormatException(); item.Birth = (ulong)ManagementDateTimeConverter.ToDateTime(created).ToUniversalTime().ToFileTimeUtc(); item.Known = item.Pid > 1 && item.Birth > 0 && item.Parent != item.Pid; } catch { item.Known = false; }
        if (item.Pid <= 1) { invalid.Add(item); continue; } if (map.ContainsKey(item.Pid)) duplicates.Add(item.Pid); else map.Add(item.Pid, item); if (!item.Known) invalid.Add(item);
      }
      return map;
    }
    static void Capture(IDictionary<string, object> request) {
      Keys(request, "rootBindingToken", "hostProbeSerial"); RootToken(request); long serial = Number(request, "hostProbeSerial", 9007199254740991); if (serial <= LastProbe) throw new Failure("STATE_OR_REQUEST_INVALID"); LastProbe = serial;
      int unknown = 0; var selected = new List<Metadata>();
      double observationEnd = Math.Min(Deadline, Clock.Elapsed.TotalMilliseconds + 12000);
      if (!Alive(Root)) unknown++;
      else try {
        HashSet<uint> duplicates; List<Metadata> invalid; var map = Census(observationEnd, out duplicates, out invalid); Metadata root;
        if (!map.TryGetValue(Root.Pid, out root) || !root.Known || duplicates.Contains(Root.Pid) || root.Parent != Caller.Pid || root.Birth / 10 != Root.Birth / 10) unknown++;
        else {
          var eligible = new HashSet<uint> { Root.Pid }; bool changed;
          do { changed = false; foreach (var item in map.Values) {
            CheckObservation(observationEnd);
            if (eligible.Contains(item.Pid) || !eligible.Contains(item.Parent)) continue; Metadata parent = map[item.Parent];
            if (!item.Known || duplicates.Contains(item.Pid) || duplicates.Contains(item.Parent)) { unknown++; continue; }
            if (item.Birth < parent.Birth) continue; // 排除已失效的历史父子关系。
            if (eligible.Count >= MaxRecords + 1) { unknown++; continue; } eligible.Add(item.Pid); selected.Add(item); changed = true;
          } } while (changed);
          foreach (var item in invalid) if (eligible.Contains(item.Parent)) unknown++;
          // 完成元数据、根身份和父子关系校验后才打开候选句柄。
          var held = new Dictionary<uint, ProcessRef>(); held.Add(Root.Pid, Root);
          foreach (var item in selected) {
            CheckObservation(observationEnd); ProcessRef original;
            if (!held.TryGetValue(item.Parent, out original) || !Alive(Root) || !Alive(original)) { unknown++; continue; }
            Record existing;
            if (ByPid.TryGetValue(item.Pid, out existing)) {
              if (existing.Process.Birth / 10 == item.Birth / 10 && Alive(existing.Process)) held[item.Pid] = existing.Process; else unknown++; continue;
            }
            ProcessRef candidate = null;
            try {
              try { candidate = Open(item.Pid, Query | Sync | Terminate); } catch (Failure error) { if (error.Code != "ACCESS_DENIED") throw; candidate = Open(item.Pid, Query | Sync); }
              if (!Alive(candidate) || candidate.Birth / 10 != item.Birth / 10 || candidate.Birth < original.Birth || NativeParent(candidate.Handle) != item.Parent || !Alive(Root) || !Alive(original)) { unknown++; candidate.Dispose(); continue; }
              if (Records.Count >= MaxRecords) { unknown++; candidate.Dispose(); continue; }
              var record = new Record { Id = Token(), Process = candidate, ParentPid = item.Parent }; Records.Add(record.Id, record); ByPid.Add(item.Pid, record); held[item.Pid] = candidate;
            } catch (Failure error) { if (candidate != null) candidate.Dispose(); if (error.Code == "DEADLINE") throw; unknown++; }
            catch { if (candidate != null) candidate.Dispose(); unknown++; }
          }
        }
        CheckObservation(observationEnd);
      } catch (Failure error) { if (error.Code == "DEADLINE") throw; unknown++; } catch { unknown++; }
      var output = new List<object>(); foreach (var record in Records.Values) output.Add(record.Wire);
      Reply("root-captured", Obj("rootBindingToken", Binding, "root", Root.Identity, "captureSerial", ++CaptureSerial, "records", output, "observation", unknown == 0 ? "complete" : "incomplete", "unknownCount", unknown));
    }
    static void RootToken(IDictionary<string, object> request) { if (Role != "root" || Text(request, "rootBindingToken", "^[a-f0-9]{32}$") != Binding) throw new Failure("STATE_OR_REQUEST_INVALID"); }
    static void ParentToken(IDictionary<string, object> request) { if (Role != "parent" || Text(request, "parentBindingToken", "^[a-f0-9]{32}$") != Binding) throw new Failure("STATE_OR_REQUEST_INVALID"); }
    static void TerminateRecords(IDictionary<string, object> request) {
      Keys(request, "rootBindingToken", "recordIds"); RootToken(request); object raw; if (!request.TryGetValue("recordIds", out raw) || !(raw is object[])) throw new Failure("STATE_OR_REQUEST_INVALID"); var ids = (object[])raw;
      if (ids.Length > MaxRecords) throw new Failure("FRAME_OR_SCOPE_LIMIT"); var seen = new HashSet<string>(); foreach (object id in ids) if (!(id is string) || !seen.Add((string)id) || !Records.ContainsKey((string)id)) throw new Failure("STATE_OR_REQUEST_INVALID");
      double phaseEnd = Math.Min(Deadline, Clock.Elapsed.TotalMilliseconds + 5000);
      var states = new List<TerminationState>();
      // 先提交全部固定动作再等待，避免慢进程阻塞其他句柄清理；整条命令限时 5 秒。
      foreach (string id in ids) {
        var state = new TerminationState { Record = Records[id] }; states.Add(state);
        var record = state.Record;
        try {
          CheckDeadline();
          if (Clock.Elapsed.TotalMilliseconds >= phaseEnd) state.Code = 258;
          else if (!SameNativeBirth(record.Process)) state.Result = "identity-changed";
          else if (!Alive(record.Process)) state.Result = "original-exited";
          else {
            state.Wait = true; CheckDeadline();
            if (Clock.Elapsed.TotalMilliseconds >= phaseEnd) state.Code = 258;
            else if (!record.Process.CanTerminate) state.Code = 5;
            else if (!(state.Requested = TerminateProcess(record.Process.Handle, 1))) state.Code = Marshal.GetLastWin32Error();
          }
        } catch (Failure error) { state.Code = error.Code == "DEADLINE" ? 258 : error.SystemCode; }
      }
      foreach (var state in states) if (state.Wait) {
        try {
          CheckDeadline();
          uint budget = (uint)Math.Max(0, Math.Min(Remaining(), Math.Floor(phaseEnd - Clock.Elapsed.TotalMilliseconds)));
          uint status = WaitForSingleObject(state.Record.Process.Handle, budget);
          if (status == Signalled) { state.Result = state.Requested ? "terminated-and-exited" : "original-exited"; state.Code = 0; }
          else if (status != Timeout) state.Code = Marshal.GetLastWin32Error();
          else if (state.Code == 0) state.Code = 258;
        } catch (Failure error) { state.Code = error.Code == "DEADLINE" ? 258 : error.SystemCode; }
      }
      var output = new List<object>(); foreach (var state in states) output.Add(state.Wire);
      Reply("captured-terminated", Obj("rootBindingToken", Binding, "results", output));
    }
    static void OpenParent(IDictionary<string, object> request) {
      Keys(request, "sessionBudgetMs", "expectedParent"); if (Role != "new") throw new Failure("STATE_OR_REQUEST_INVALID"); BindCaller(); uint pid = NativeParent(Caller.Handle);
      try { Parent = Open(pid, RemoteRights); ActivationAvailable = true; } catch (Failure error) { if (error.Code != "ACCESS_DENIED") throw; Parent = Open(pid, Query | Sync); ActivationAvailable = false; UnavailableReason = "ACCESS_DENIED"; }
      LiveParent(); if (request.ContainsKey("expectedParent")) ExpectedParent(request["expectedParent"]);
      if (ActivationAvailable) try { ActivationAvailable = QualifyMappedNode(); if (!ActivationAvailable) UnavailableReason = "UNSUPPORTED_NODE_PROFILE"; } catch { ActivationAvailable = false; UnavailableReason = "UNSUPPORTED_NODE_PROFILE"; }
      LiveParent(); Role = "parent"; Binding = Token(); var result = Obj("parentBindingToken", Binding, "caller", Caller.Identity, "parent", Parent.Identity, "activationAvailable", ActivationAvailable);
      if (ActivationAvailable) result.Add("activationProfile", Obj("id", "win32-x64-node24.22.1-inspector-v1", "platform", "win32", "architecture", "x64", "verification", "qualified-target-image", "inspectorActivation", "windows-held-handle-debug-mapping")); else result.Add("unavailableReason", UnavailableReason);
      Reply("inspector-parent-ready", result);
    }
    static void Activate(IDictionary<string, object> request) {
      Keys(request, "parentBindingToken"); ParentToken(request); if (ActivationAttempted) throw new Failure("ACTIVATION_ALREADY_ATTEMPTED"); ActivationAttempted = true;
      if (!ActivationAvailable) throw new Failure(UnavailableReason); LiveParent(); if (!QualifyMappedNode()) throw new Failure("UNSUPPORTED_NODE_PROFILE");
      IntPtr mapping = IntPtr.Zero, view = IntPtr.Zero, thread = IntPtr.Zero;
      try {
        mapping = OpenFileMappingW(4, false, "node-debug-handler-" + Parent.Pid.ToString(CultureInfo.InvariantCulture)); if (mapping == IntPtr.Zero) throw new Failure("INSPECTOR_ACTIVATION_DISABLED", "refused-before-action", Marshal.GetLastWin32Error());
        view = MapViewOfFile(mapping, 4, 0, 0, (UIntPtr)8); if (view == IntPtr.Zero) throw new Failure("UNSUPPORTED_NODE_PROFILE"); IntPtr handler = Marshal.ReadIntPtr(view);
        if (handler == IntPtr.Zero || !ExecutableHandler(handler)) throw new Failure("UNSUPPORTED_NODE_PROFILE"); LiveParent(); CheckDeadline();
        thread = CreateRemoteThread(Parent.Handle, IntPtr.Zero, UIntPtr.Zero, handler, IntPtr.Zero, 0, IntPtr.Zero); if (thread == IntPtr.Zero) throw new Failure("NATIVE_OPERATION_UNKNOWN", "failed", Marshal.GetLastWin32Error()); ActionStarted = true;
        uint status = WaitForSingleObject(thread, Remaining()), exit; if (status != Signalled || !GetExitCodeThread(thread, out exit) || !Alive(Parent) || !Alive(Caller)) throw new Failure("NATIVE_OPERATION_UNKNOWN", "started-unconfirmed", status == Timeout ? 258 : Marshal.GetLastWin32Error());
        Reply("inspector-activated", Obj("parentBindingToken", Binding, "actionSerial", 1, "originalParent", Parent.Identity, "result", "native-action-completed")); ActionStarted = false;
      } finally { if (thread != IntPtr.Zero) CloseHandle(thread); if (view != IntPtr.Zero) UnmapViewOfFile(view); if (mapping != IntPtr.Zero) CloseHandle(mapping); }
    }
    static void Dispatch(Dictionary<string, object> request) {
      string command = Text(request, "command", "^[a-z-]{1,40}$");
      switch (command) {
        case "open-root": OpenRoot(request); break;
        case "capture-root": Capture(request); break;
        case "terminate-captured": TerminateRecords(request); break;
        case "open-inspector-parent": OpenParent(request); break;
        case "activate-inspector-once": Activate(request); break;
        case "confirm-inspector-parent":
          Keys(request, "parentBindingToken", "connectionSerial"); ParentToken(request); long serial = Number(request, "connectionSerial", 9007199254740991); if (serial <= LastConnection) throw new Failure("STATE_OR_REQUEST_INVALID"); LiveParent(); LastConnection = serial;
          Reply("inspector-parent-confirmed", Obj("parentBindingToken", Binding, "connectionSerial", serial, "parent", Parent.Identity, "originalLive", true)); break;
        case "close-session": Keys(request); Reply("session-closed", Obj("released", true)); Role = "closed"; break;
        default: throw new Failure("STATE_OR_REQUEST_INVALID");
      }
    }
    public static int Main(string[] args) {
      Console.InputEncoding = Utf8; Console.OutputEncoding = Utf8;
      try {
        if (args.Length != 0 || IntPtr.Size != 8 || Environment.Is64BitProcess == false) return 78;
        for (int count = 0; count < MaxRequests; count++) {
          CheckDeadline(); var task = Task.Factory.StartNew<string>(ReadBoundedLine); if (!task.Wait((int)Remaining())) throw new Failure("DEADLINE"); string line = task.Result; if (line == null) return 0;
          RejectDuplicateKeys(line); var request = Json.DeserializeObject(line) as Dictionary<string, object>; if (request == null) throw new Failure("STATE_OR_REQUEST_INVALID");
          string nonce = Text(request, "sessionNonce", "^[a-f0-9]{48}$"); if (Nonce == null) Nonce = nonce; else if (Nonce != nonce) throw new Failure("STATE_OR_REQUEST_INVALID");
          long id = Number(request, "requestId", 9007199254740991); if (id <= RequestId || Number(request, "protocol") != 1) throw new Failure("STATE_OR_REQUEST_INVALID"); RequestId = id;
          long budget = Number(request, "remainingBudgetMs"); double now = Clock.Elapsed.TotalMilliseconds;
          if (!Opened) { long session = Text(request, "command", "^[a-z-]{1,40}$") == "close-session" ? budget : Number(request, "sessionBudgetMs"); Deadline = now + Math.Min(budget, session); Opened = true; } else Deadline = Math.Min(Deadline, now + budget);
          CheckDeadline(); Dispatch(request); if (Role == "closed") return 0;
        }
        throw new Failure("FRAME_OR_SCOPE_LIMIT");
      } catch (Exception error) {
        Failure failure = error as Failure; if (error is AggregateException && error.InnerException is Failure) failure = (Failure)error.InnerException;
        if (failure == null) failure = new Failure("NATIVE_OPERATION_UNKNOWN", ActionStarted ? "started-unconfirmed" : "unknown");
        if (Nonce != null && RequestId > 0) try { var details = Obj("result", failure.Result, "code", failure.Code); if (failure.SystemCode != 0) details.Add("systemCode", failure.SystemCode); Reply("refused", details); } catch { }
        return 78;
      } finally {
        foreach (var record in Records.Values) record.Process.Dispose(); if (Parent != null) Parent.Dispose(); if (Root != null) Root.Dispose(); if (Caller != null) Caller.Dispose(); Input.Dispose();
      }
    }
  }
}
