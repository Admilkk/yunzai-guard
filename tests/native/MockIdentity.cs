// 仅供测试的确定性协议对端，不查询或操作目标进程。
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class MockIdentity {
  static JavaScriptSerializer J = new JavaScriptSerializer();
  static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i=0;i<pairs.Length;i+=2)d[(string)pairs[i]]=pairs[i+1];return d; }
  static object Identity(int pid,string born) { return D("pid",pid,"birth",D("kind","windows-filetime-100ns","value",born)); }
  static void Main(string[] args) {
    if(args.Length!=0)Environment.Exit(2);
    Console.InputEncoding = new System.Text.UTF8Encoding(false,true); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    string mode=Environment.GetEnvironmentVariable("GUARD_NATIVE_IDENTITY_TEST_MODE")??"incomplete";
    int caller=int.Parse(Environment.GetEnvironmentVariable("GUARD_NATIVE_IDENTITY_TEST_CALLER"));
    int root=0,captures=0;string binding=new string('a',32),record=new string('b',32),line;
    while((line=Console.ReadLine())!=null) {
      var q=J.Deserialize<Dictionary<string,object>>(line);string command=(string)q["command"];
      var r=D("protocol",1,"sessionNonce",q["sessionNonce"],"requestId",q["requestId"]);
      if(command=="open-root") { root=Convert.ToInt32(q["rootPid"]);r["type"]="root-ready";r["rootBindingToken"]=binding;r["root"]=Identity(root,"100001");r["caller"]=Identity(caller,"100000");r["nativeRelation"]="caller-direct-child"; }
      else if(command=="capture-root") {
        captures++;
        if(captures>1 && mode=="refused") {r["type"]="refused";r["result"]="refused-before-action";r["code"]="IDENTITY_UNKNOWN";}
        else if(captures>1 && mode=="malformed-refusal") {r["type"]="refused";r["result"]="refused-before-action";r["code"]="IDENTITY_UNKNOWN";r["unexpected"]=true;}
        else {
          r["type"]="root-captured";r["rootBindingToken"]=binding;r["root"]=Identity(root,"100001");r["captureSerial"]=captures;
          r["records"]=new object[]{D("recordId",record,"identity",Identity(2147483000,"100002"),"parentPid",root)};
          bool incomplete=captures>1&&mode=="incomplete";r["observation"]=incomplete?"incomplete":"complete";r["unknownCount"]=incomplete?1:0;
          if(captures>1&&mode=="unknown-field")r["unexpected"]=true;
          if(captures>1&&mode=="wrong-nonce")r["sessionNonce"]=new string('0',48);
          if(captures>1&&mode=="stale-serial")r["captureSerial"]=1;
          if(captures>1&&mode=="unknown-record-field")r["records"]=new object[]{D("recordId",record,"identity",Identity(2147483000,"100002"),"parentPid",root,"unexpected",true)};
        }
      } else if(command=="terminate-captured") {r["type"]="captured-terminated";r["rootBindingToken"]=binding;r["results"]=new object[]{D("recordId",record,"result","terminated-and-exited")};}
      else if(command=="close-session") {r["type"]="session-closed";r["released"]=true;}
      else {r["type"]="refused";r["result"]="refused-before-action";r["code"]="STATE_OR_REQUEST_INVALID";}
      Console.WriteLine(J.Serialize(r));Console.Out.Flush();if(command=="close-session")return;
    }
  }
}
