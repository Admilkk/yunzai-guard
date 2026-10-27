#define _GNU_SOURCE
/* Inspector 父进程专用会话，不接受调用方指定的 PID、路径或信号。 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include "native_json.h"
#include "native_sha256.h"

#if !defined(__linux__) || !defined(__x86_64__)
#error Only the qualified Linux x86_64 target is supported.
#endif
_Static_assert(SIGUSR1>0 && SIGUSR1<=64,"SIGUSR1 must fit proc status masks");
#define FRAME_BYTES 65536
#define MAX_BUDGET 2147483647ULL
typedef struct { const char *sha256, *id; } QualifiedImage;
static const QualifiedImage qualified_images[] = {
  {"569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108", "node24.22.1-linux-x64-musl-569128"},
  {"e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb", "node24.22.1-linux-x64-glibc-e32e2d"}
};
static const char *qualified_image_profile(const char *digest) {
  for(size_t i=0;i<sizeof(qualified_images)/sizeof(qualified_images[0]);i++)
    if(!strcmp(digest,qualified_images[i].sha256))return qualified_images[i].id;
  return NULL;
}

typedef struct { pid_t pid, ppid; uint64_t start; int procfd, nsfd, pidfd, exefd; struct stat ns, exe; } Process;
typedef struct {
  char nonce[49], binding[33], boot[37]; uint64_t request, deadline, connection;
  int opened, attempted, action_unknown, request_count;
  Process caller,parent; int activation; const char *unavailable, *profile;
} Session;
static Session session;
static Json json;
static uint64_t monotonic_ms(void) { struct timespec t; if(clock_gettime(CLOCK_MONOTONIC,&t)) return 0; return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000; }
static int budget_live(void) { return monotonic_ms()<session.deadline; }
static void init_process(Process *p) { memset(p,0,sizeof(*p));p->procfd=p->nsfd=p->pidfd=p->exefd=-1; }
static void release_process(Process *p) { if(p->procfd>=0)close(p->procfd);if(p->nsfd>=0)close(p->nsfd);if(p->pidfd>=0)close(p->pidfd);if(p->exefd>=0)close(p->exefd);init_process(p); }
static void release(void) { release_process(&session.caller);release_process(&session.parent); }
static int live_pidfd(int fd) { struct pollfd p={.fd=fd,.events=POLLIN}; int n; do {n=poll(&p,1,0);}while(n<0&&errno==EINTR&&budget_live()); return n==0 && p.revents==0; }
static ssize_t read_file_at(int dirfd,const char *name,char *buf,size_t capacity) {
  int fd=openat(dirfd,name,O_RDONLY|O_CLOEXEC);if(fd<0)return -1;
  size_t used=0;while(used<capacity){ssize_t n=read(fd,buf+used,capacity-used);if(n<0&&errno==EINTR)continue;if(n<0){close(fd);return -1;}if(!n){close(fd);return (ssize_t)used;}used+=(size_t)n;}
  char extra;ssize_t more;do{more=read(fd,&extra,1);}while(more<0&&errno==EINTR);close(fd);if(more!=0){errno=EOVERFLOW;return -1;}return (ssize_t)used;
}
static int parse_u64(const char *p,size_t n,uint64_t *value) {
  if(!n||n>20)return 0;uint64_t x=0;for(size_t i=0;i<n;i++){unsigned d=(unsigned)(p[i]-'0');if(d>9||x>UINT64_MAX/10||(x==UINT64_MAX/10&&d>UINT64_MAX%10))return 0;x=x*10+d;}*value=x;return 1;
}
static int read_stat(int fd,pid_t expected,pid_t *ppid,uint64_t *start) {
  char buf[16384];ssize_t n=read_file_at(fd,"stat",buf,sizeof(buf)-1);if(n<1)return 0;buf[n]=0;
  char *open=strchr(buf,'('),*close=strrchr(buf,')');uint64_t pid;
  if(!open||!close||open<buf+2||close<open||!parse_u64(buf,(size_t)(open-buf-1),&pid)||pid!=(uint64_t)expected||close[1]!=' ')return 0;
  char *p=close+2;pid_t parent=0;uint64_t born=0;
  /* state 为第 3 字段，starttime 为第 22 字段；comm 可能包含右括号。 */
  for(int field=3;field<=22;field++){while(*p==' ')p++;char *end=p;while(*end&&*end!=' '&&*end!='\n')end++;if(end==p)return 0;
    uint64_t v;if(field==4){if(!parse_u64(p,(size_t)(end-p),&v)||v>INT_MAX)return 0;parent=(pid_t)v;}
    if(field==22){if(!parse_u64(p,(size_t)(end-p),&born)||!born)return 0;}p=end;}
  *ppid=parent;*start=born;return 1;
}
static int read_boot(char out[37]) {
  char b[64];ssize_t n=read_file_at(AT_FDCWD,"/proc/sys/kernel/random/boot_id",b,sizeof(b));if(n!=37||b[36]!='\n')return 0;
  for(int i=0;i<36;i++){if(i==8||i==13||i==18||i==23){if(b[i]!='-')return 0;}else if(!((b[i]>='0'&&b[i]<='9')||(b[i]>='a'&&b[i]<='f')))return 0;}memcpy(out,b,36);out[36]=0;return 1;
}
static int bind_process(Process *p,pid_t pid) {
  char route[64];init_process(p);p->pid=pid;if(pid<=1)return 0;
  p->pidfd=(int)syscall(SYS_pidfd_open,pid,0);if(p->pidfd<0||!live_pidfd(p->pidfd))return 0;
  snprintf(route,sizeof(route),"/proc/%d",pid);p->procfd=open(route,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);if(p->procfd<0)return 0;
  if(!read_stat(p->procfd,pid,&p->ppid,&p->start))return 0;
  p->nsfd=openat(p->procfd,"ns/pid",O_RDONLY|O_CLOEXEC);if(p->nsfd<0||fstat(p->nsfd,&p->ns))return 0;
  p->exefd=openat(p->procfd,"exe",O_RDONLY|O_CLOEXEC);if(p->exefd<0||fstat(p->exefd,&p->exe)||!S_ISREG(p->exe.st_mode))return 0;
  pid_t parent;uint64_t born;return read_stat(p->procfd,pid,&parent,&born)&&parent==p->ppid&&born==p->start&&live_pidfd(p->pidfd);
}
static int same_file(const struct stat *a,const struct stat *b) {
  return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_size==b->st_size&&a->st_mtim.tv_sec==b->st_mtim.tv_sec&&a->st_mtim.tv_nsec==b->st_mtim.tv_nsec&&a->st_ctim.tv_sec==b->st_ctim.tv_sec&&a->st_ctim.tv_nsec==b->st_ctim.tv_nsec;
}
static int process_unchanged(Process *p) {
  pid_t parent;uint64_t born;struct stat ns,exe;
  if(!budget_live()||!live_pidfd(p->pidfd)||!read_stat(p->procfd,p->pid,&parent,&born)||born!=p->start||parent!=p->ppid)return 0;
  int nsfd=openat(p->procfd,"ns/pid",O_RDONLY|O_CLOEXEC);if(nsfd<0)return 0;int good=fstat(nsfd,&ns)==0&&ns.st_dev==p->ns.st_dev&&ns.st_ino==p->ns.st_ino;close(nsfd);if(!good)return 0;
  int exefd=openat(p->procfd,"exe",O_RDONLY|O_CLOEXEC);if(exefd<0)return 0;good=fstat(exefd,&exe)==0&&same_file(&exe,&p->exe);close(exefd);
  return good&&live_pidfd(p->pidfd);
}
static int relation_unchanged(void) {
  return getppid()==session.caller.pid&&process_unchanged(&session.caller)&&process_unchanged(&session.parent)&&session.caller.ppid==session.parent.pid&&session.parent.start<=session.caller.start;
}
static const char *exact_image(Process *p) {
  unsigned char elf[64];if(pread(p->exefd,elf,sizeof(elf),0)!=(ssize_t)sizeof(elf)||memcmp(elf,"\177ELF",4)||elf[4]!=2||elf[5]!=1||elf[18]!=62||elf[19]!=0)return 0;
  GuardSha256 s;sha_init(&s);unsigned char buf[65536];off_t offset=0;
  for(;;){if(!budget_live())return 0;ssize_t n=pread(p->exefd,buf,sizeof(buf),offset);if(n<0&&errno==EINTR)continue;if(n<0)return 0;if(!n)break;sha_update(&s,buf,(size_t)n);offset+=n;}
  char digest[65];sha_final(&s,digest);struct stat after;
  if(fstat(p->exefd,&after)||!same_file(&after,&p->exe)||!process_unchanged(p))return NULL;
  return qualified_image_profile(digest);
}
static int status_masks(Process *p,uint64_t masks[5]) {
  const char *names[]={"SigCgt:","SigIgn:","SigBlk:","SigPnd:","ShdPnd:"};int found[5]={0};char buf[65536];
  ssize_t n=read_file_at(p->procfd,"status",buf,sizeof(buf)-1);if(n<1)return 0;buf[n]=0;
  for(char *line=buf;*line;){char *end=strchr(line,'\n');if(!end)end=line+strlen(line);
    for(int k=0;k<5;k++)if((size_t)(end-line)>=strlen(names[k])&&!memcmp(line,names[k],strlen(names[k]))){if(found[k]++)return 0;char *x=line+strlen(names[k]);while(x<end&&(*x==' '||*x=='\t'))x++;if(end-x!=16)return 0;uint64_t mask=0;for(;x<end;x++){unsigned d;if(*x>='0'&&*x<='9')d=(unsigned)(*x-'0');else if(*x>='a'&&*x<='f')d=(unsigned)(*x-'a'+10);else if(*x>='A'&&*x<='F')d=(unsigned)(*x-'A'+10);else return 0;mask=(mask<<4)|d;}masks[k]=mask;}
    line=*end?end+1:end;}
  for(int k=0;k<5;k++)if(found[k]!=1)return 0;return 1;
}
/* PM2 会重写 argv，因此这里只用于排除，不能证明原始参数完整。
 * 已核验的 Node daemon 不得并发替换处理器或执行 exec。 */
static int node_options_gate(Process *p) {
  char buf[65536];ssize_t n=read_file_at(p->procfd,"environ",buf,sizeof(buf));if(n<0)return -1;
  int found=0;for(size_t i=0;i<(size_t)n;){size_t end=i;while(end<(size_t)n&&buf[end])end++;if(end==(size_t)n)return -1;
    if(end-i>=13&&!memcmp(buf+i,"NODE_OPTIONS=",13)){if(found++)return -1;size_t at=i+13;
      while(at<end){while(at<end&&buf[at]==' ')at++;if(at==end)break;char token[4097];size_t used=0;int quote=0;
        while(at<end){char c=buf[at++];if(c=='"'){quote=!quote;continue;}if(c=='\\'&&quote){if(at==end)return -1;c=buf[at++];}else if(c==' '&&!quote)break;if((unsigned char)c<32||(unsigned char)c>126||used>=4096)return -1;token[used++]=c;}
        if(quote)return -1;token[used]=0;char *equals=strchr(token,'=');if(equals)*equals=0;for(char *x=token;*x;x++)if(*x=='_')*x='-';if(!strcmp(token,"--disable-sigusr1"))return 0;
      }
    }i=end+1;}return 1;
}
static const char *activation_gate(void) {
  if(!relation_unchanged())return "ROOT_OR_PARENT_CHANGED";
  int options=node_options_gate(&session.parent);if(options<0)return "IDENTITY_UNKNOWN";if(!options)return "INSPECTOR_ACTIVATION_DISABLED";
  uint64_t masks[5],bit=UINT64_C(1)<<(SIGUSR1-1);
  if(!status_masks(&session.parent,masks)||!(masks[0]&bit)||(masks[1]&bit)||(masks[2]&bit)||(masks[3]&bit)||(masks[4]&bit))return "SIGNAL_HANDLER_UNAVAILABLE_OR_UNKNOWN";
  return NULL;
}
static int random_token(char out[33]) { unsigned char b[16];size_t at=0;while(at<sizeof(b)){ssize_t n=getrandom(b+at,sizeof(b)-at,0);if(n<0&&errno==EINTR)continue;if(n<=0)return 0;at+=(size_t)n;}const char *h="0123456789abcdef";for(int i=0;i<16;i++){out[i*2]=h[b[i]>>4];out[i*2+1]=h[b[i]&15];}out[32]=0;return 1; }
static int lower_hex(const char *text,size_t bytes) { if(strlen(text)!=bytes)return 0;for(size_t i=0;i<bytes;i++)if(!((text[i]>='a'&&text[i]<='f')||(text[i]>='0'&&text[i]<='9')))return 0;return 1; }
static void header(const char *type) { printf("{\"protocol\":1,\"sessionNonce\":\"%s\",\"requestId\":%" PRIu64 ",\"type\":\"%s\"",session.nonce,session.request,type); }
static void identity(Process *p) { printf("{\"pid\":%d,\"birth\":{\"kind\":\"linux-proc-start-ticks\",\"value\":\"%" PRIu64 "\",\"bootId\":\"%s\",\"pidNamespace\":\"%ju:%ju\"}}",p->pid,p->start,session.boot,(uintmax_t)p->ns.st_dev,(uintmax_t)p->ns.st_ino); }
static int flush_reply(void) { return printf("}\n")>=0&&fflush(stdout)==0; }
static int refuse(const char *code,const char *result,int system) { header("refused");printf(",\"result\":\"%s\",\"code\":\"%s\"",result,code);if(system)printf(",\"systemCode\":%d",system);return flush_reply(); }
static int expected_matches(int token,Process *p) {
  const char *const outer[]={"pid","birth"},*const birth[]={"kind","value","bootId","pidNamespace"};uint64_t pid;char start[41],boot[37],ns[64],expected_ns[64];
  int b=j_get(&json,token,"birth");if(!j_keys(&json,token,outer,2,NULL,0)||!j_uint(&json,j_get(&json,token,"pid"),INT_MAX,&pid)||pid!=(uint64_t)p->pid||!j_keys(&json,b,birth,4,NULL,0)||!j_equals(&json,j_get(&json,b,"kind"),"linux-proc-start-ticks")||!j_string(&json,j_get(&json,b,"value"),start,sizeof(start))||!j_string(&json,j_get(&json,b,"bootId"),boot,sizeof(boot))||!j_string(&json,j_get(&json,b,"pidNamespace"),ns,sizeof(ns)))return 0;
  char actual_start[41];snprintf(actual_start,sizeof(actual_start),"%" PRIu64,p->start);snprintf(expected_ns,sizeof(expected_ns),"%ju:%ju",(uintmax_t)p->ns.st_dev,(uintmax_t)p->ns.st_ino);return !strcmp(start,actual_start)&&!strcmp(boot,session.boot)&&!strcmp(ns,expected_ns);
}
static int request_keys(const char *extra1,const char *extra2,const char *optional) {
  const char *required[8]={"protocol","sessionNonce","requestId","remainingBudgetMs","command"};size_t n=5;if(extra1)required[n++]=extra1;if(extra2)required[n++]=extra2;const char *o[1]={optional};return j_keys(&json,0,required,n,o,optional?1:0);
}
static int binding_matches(void) { char b[33];return j_string(&json,j_get(&json,0,"parentBindingToken"),b,sizeof(b))&&!strcmp(b,session.binding); }
static int read_frame(char *buf,size_t capacity) {
  size_t at=0;for(;;){uint64_t now=monotonic_ms();if(now>=session.deadline)return -2;uint64_t remain=session.deadline-now;struct pollfd fd={.fd=STDIN_FILENO,.events=POLLIN};int wait=(int)(remain>INT_MAX?INT_MAX:remain);int ready=poll(&fd,1,wait);if(ready<0&&errno==EINTR)continue;if(ready<=0)return ready==0?-2:-1;
    char c;ssize_t n=read(STDIN_FILENO,&c,1);if(n<0&&errno==EINTR)continue;if(n==0)return at?-1:0;if(n<0)return -1;if(at+1>=capacity)return -1;buf[at++]=c;if(c=='\n'){buf[at-1]=0;return at>1?(int)at-1:-1;}}
}
int main(int argc,char **argv) {
  (void)argv;if(argc!=1)return 2;memset(&session,0,sizeof(session));init_process(&session.caller);init_process(&session.parent);session.deadline=monotonic_ms()+10000;
  /* stdout 是专用管道；调用方退出后关闭描述符，不触发 SIGPIPE。 */
  struct sigaction ignore;memset(&ignore,0,sizeof(ignore));ignore.sa_handler=SIG_IGN;sigemptyset(&ignore.sa_mask);if(sigaction(SIGPIPE,&ignore,NULL))return 2;
  char frame[FRAME_BYTES+1];int exit_code=0;
  for(;;){int n=read_frame(frame,sizeof(frame));if(n==0)break;if(n<0){exit_code=n==-2?3:2;break;}if(++session.request_count>64||!j_parse(&json,frame,(size_t)n)){exit_code=2;break;}
    uint64_t protocol,id,remaining;char nonce[49],command[64];
    if(!j_uint(&json,j_get(&json,0,"protocol"),1,&protocol)||!j_uint(&json,j_get(&json,0,"requestId"),UINT64_C(9007199254740991),&id)||id<=session.request||!j_uint(&json,j_get(&json,0,"remainingBudgetMs"),MAX_BUDGET,&remaining)||!j_string(&json,j_get(&json,0,"sessionNonce"),nonce,sizeof(nonce))||!lower_hex(nonce,48)||!j_string(&json,j_get(&json,0,"command"),command,sizeof(command))){exit_code=2;break;}
    if(session.request_count==1)memcpy(session.nonce,nonce,sizeof(nonce));else if(strcmp(nonce,session.nonce)){exit_code=2;break;}session.request=id;
    uint64_t deadline=monotonic_ms()+remaining;
    if(session.request_count==1){uint64_t budget;if(!strcmp(command,"close-session"))session.deadline=deadline;else if(!j_uint(&json,j_get(&json,0,"sessionBudgetMs"),MAX_BUDGET,&budget)){exit_code=2;break;}else{session.deadline=monotonic_ms()+budget;if(deadline<session.deadline)session.deadline=deadline;}}
    else if(deadline<session.deadline)session.deadline=deadline;
    if(!budget_live()){refuse("DEADLINE","refused-before-action",0);exit_code=3;break;}
    if(!strcmp(command,"close-session")){if(!request_keys(NULL,NULL,NULL)){exit_code=2;break;}release();header("session-closed");printf(",\"released\":true");if(!flush_reply())exit_code=2;break;}
    if(!strcmp(command,"open-root")){if(!request_keys("rootPid","sessionBudgetMs",NULL)){exit_code=2;break;}if(!refuse("UNSUPPORTED_PLATFORM_OR_ARCH","refused-before-action",0)){exit_code=2;break;}continue;}
    if(!strcmp(command,"open-inspector-parent")){
      if(session.opened||session.request_count!=1||!request_keys("sessionBudgetMs",NULL,"expectedParent")){exit_code=2;break;}
      pid_t app=getppid();if(!read_boot(session.boot)||!bind_process(&session.caller,app)||getppid()!=app||!bind_process(&session.parent,session.caller.ppid)){refuse(errno==EACCES||errno==EPERM?"ACCESS_DENIED":"NATIVE_PRIMITIVE_UNAVAILABLE","refused-before-action",errno);exit_code=0;break;}
      struct stat ownns;int own=open("/proc/self/ns/pid",O_RDONLY|O_CLOEXEC);int nsok=own>=0&&fstat(own,&ownns)==0&&ownns.st_dev==session.caller.ns.st_dev&&ownns.st_ino==session.caller.ns.st_ino&&ownns.st_dev==session.parent.ns.st_dev&&ownns.st_ino==session.parent.ns.st_ino;if(own>=0)close(own);
      if(!nsok||!relation_unchanged()){refuse("RELATIONSHIP_UNKNOWN","refused-before-action",0);break;}
      int expected=j_get(&json,0,"expectedParent");if(expected>=0&&!expected_matches(expected,&session.parent)){refuse("ROOT_OR_PARENT_CHANGED","refused-before-action",0);break;}
      if(!random_token(session.binding)){refuse("NATIVE_PRIMITIVE_UNAVAILABLE","refused-before-action",errno);break;}
      session.opened=1;session.profile=exact_image(&session.parent);session.unavailable=session.profile?activation_gate():"UNSUPPORTED_NODE_PROFILE";session.activation=session.unavailable==NULL;
      if(!budget_live()){refuse("DEADLINE","refused-before-action",0);exit_code=3;break;}
      header("inspector-parent-ready");printf(",\"parentBindingToken\":\"%s\",\"caller\":",session.binding);identity(&session.caller);printf(",\"parent\":");identity(&session.parent);printf(",\"activationAvailable\":%s",session.activation?"true":"false");
      if(session.activation)printf(",\"activationProfile\":{\"id\":\"%s\",\"platform\":\"linux\",\"architecture\":\"x64\",\"verification\":\"qualified-target-image\",\"inspectorActivation\":\"linux-held-pidfd-sigusr1-under-trusted-stable-handler\"}",session.profile);
      else printf(",\"unavailableReason\":\"%s\"",session.unavailable);if(!flush_reply()){exit_code=2;break;}continue;
    }
    if(!strcmp(command,"activate-inspector-once")){
      if(!session.opened||!request_keys("parentBindingToken",NULL,NULL)||!binding_matches()){exit_code=2;break;}
      if(session.attempted){if(!refuse("ACTIVATION_ALREADY_ATTEMPTED","refused-before-action",0)){exit_code=2;break;}continue;}
      if(!session.activation){if(!refuse(session.unavailable,"refused-before-action",0)){exit_code=2;break;}continue;}
      const char *denied=activation_gate();if(denied){if(!refuse(denied,"refused-before-action",0)){exit_code=2;break;}continue;}
      if(!budget_live()){refuse("DEADLINE","refused-before-action",0);exit_code=3;break;}
      session.attempted=1;session.action_unknown=1;
      /* 唯一的生产信号操作，仅作用于已持有的 pidfd。 */
      int sent=(int)syscall(SYS_pidfd_send_signal,session.parent.pidfd,SIGUSR1,NULL,0);int code=errno;
      if(sent<0){session.action_unknown=0;if(!refuse(code==EPERM||code==EACCES?"ACCESS_DENIED":"NATIVE_OPERATION_UNKNOWN","failed",code)){exit_code=2;break;}continue;}
      header("inspector-activated");printf(",\"parentBindingToken\":\"%s\",\"actionSerial\":1,\"originalParent\":",session.binding);identity(&session.parent);printf(",\"result\":\"native-action-completed\"");if(!flush_reply()){exit_code=2;break;}session.action_unknown=0;continue;
    }
    if(!strcmp(command,"confirm-inspector-parent")){
      uint64_t serial;if(!session.opened||session.action_unknown||!request_keys("parentBindingToken","connectionSerial",NULL)||!binding_matches()||!j_uint(&json,j_get(&json,0,"connectionSerial"),UINT64_C(9007199254740991),&serial)||serial<=session.connection){exit_code=2;break;}
      if(!relation_unchanged()){if(!refuse("ROOT_OR_PARENT_CHANGED","refused-before-action",0)){exit_code=2;break;}continue;}session.connection=serial;
      header("inspector-parent-confirmed");printf(",\"parentBindingToken\":\"%s\",\"connectionSerial\":%" PRIu64 ",\"parent\":",session.binding,serial);identity(&session.parent);printf(",\"originalLive\":true");if(!flush_reply()){exit_code=2;break;}continue;
    }
    exit_code=2;break;
  }
  release();return exit_code;
}
