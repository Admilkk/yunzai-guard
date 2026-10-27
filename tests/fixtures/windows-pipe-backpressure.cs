using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// 探针仅在新建的同用户回环管道上调用有界写入器，不启动 GuardSandbox.Main 或修改 ACL。
internal static class WindowsPipeBackpressureProbe
{
    private static readonly Type Guard = typeof(GuardSandbox);
    private static readonly Type Client = Guard.GetNestedType("Client", BindingFlags.NonPublic);
    private static object Get(object client, string name) { return Client.GetField(name).GetValue(client); }
    private static object Call(string name, params object[] args) { return Guard.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args); }
    private sealed class Pair : IDisposable
    {
        public object target;
        public NamedPipeServerStream server;
        public NamedPipeClientStream reader;
        public Pair()
        {
            string name = "yunzai-guard-owned-pipe-probe-" + Guid.NewGuid().ToString("N");
            server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096);
            Task connected = Task.Factory.StartNew(() => server.WaitForConnection());
            reader = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            reader.Connect(2000);
            if (!connected.Wait(2000)) throw new IOException("Owned pipe connect timeout");
            target = Activator.CreateInstance(Client, true);
            Client.GetField("stream").SetValue(target, server);
        }
        public bool Queue(object value) { return (bool)Call("QueueClientWrite", target, value); }
        public void Start() { Call("StartClientWriter", target); }
        public void Dispose() { Call("CloseClient", target); reader.Dispose(); }
    }
    public static int Main()
    {
        try
        {
            var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            environment["YUNZAI_GUARD_CANONICAL_METADATA"] = "injected";
            environment["yunzai_guard_canonical_endpoint"] = "untrusted";
            environment["UNCHANGED_FIXTURE"] = "retained";
            Call("InitializeCanonicalMetadata", false, null, null, null, environment);
            bool scrubbed = environment.Count == 1 && environment["UNCHANGED_FIXTURE"] == "retained";
            Call("BindCanonicalRoot", IntPtr.Zero, (uint)0);
            Call("BeginCanonicalStop");
            bool canonicalStopped = (bool)Call("StopCanonicalMetadata");
            bool exact, unicode, independent, expired;
            long unknown, elapsed, roundTrip;
            int retained;
            using (var capacity = new Pair())
            {
                string fullFrame = new string('x', 65533); // JSON quotes + LF = 65536 UTF-8 bytes.
                exact = capacity.Queue(fullFrame) && capacity.Queue(fullFrame) && capacity.Queue(fullFrame) && capacity.Queue(fullFrame)
                    && (int)Get(capacity.target, "retainedBytes") == 256 * 1024;
                exact = exact && !capacity.Queue("one-byte-over-capacity") && (bool)Get(capacity.target, "closed")
                    && (long)Get(capacity.target, "unknown") == 4 && (long)Get(capacity.target, "rejected") == 1;
            }
            using (var wide = new Pair())
                unicode = !wide.Queue(new string('\u4e2d', 22000)) && (bool)Get(wide.target, "closed") && (long)Get(wide.target, "rejected") == 1;
            using (var stalled = new Pair())
            using (var healthy = new Pair())
            {
                var clock = Stopwatch.StartNew();
                stalled.Start(); healthy.Start();
                if (!stalled.Queue(new string('x', 60000))) throw new IOException("Stalled frame not accepted");
                var reader = new StreamReader(healthy.reader);
                long started = clock.ElapsedMilliseconds;
                healthy.Queue("healthy");
                Task<string> read = Task.Factory.StartNew(() => reader.ReadLine());
                if (!read.Wait(1000)) throw new IOException("Independent healthy client was stalled");
                roundTrip = clock.ElapsedMilliseconds - started;
                independent = read.Result == "\"healthy\"";
                while (!(bool)Get(stalled.target, "closed") && clock.ElapsedMilliseconds < 5000) Thread.Sleep(10);
                elapsed = clock.ElapsedMilliseconds;
                expired = (bool)Get(stalled.target, "closed");
                unknown = (long)Get(stalled.target, "unknown");
                retained = (int)Get(stalled.target, "retainedBytes");
                healthy.Queue("still-healthy");
                Task<string> again = Task.Factory.StartNew(() => reader.ReadLine());
                if (!again.Wait(1000)) throw new IOException("Healthy pipe lost after another peer expired");
                independent = independent && again.Result == "\"still-healthy\"";
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {
                scope = "owned-loopback-pipe-transport-only", exactCapacity = exact, unicodeRejected = unicode,
                canonicalDisabledScrubbed = scrubbed, canonicalDisabledStopConfirmed = canonicalStopped,
                peerIndependent = independent, expiredClosed = expired, unknown = unknown,
                retainedAfterClose = retained, healthyRoundTripMs = roundTrip, expiredMs = elapsed
            }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
