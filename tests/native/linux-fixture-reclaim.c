#define _GNU_SOURCE
/* 仅供测试，输入来自夹具此前已验证的身份记录，不纳入生产协议或产物。 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include "../../native/process-identity/native_json.h"

typedef struct { pid_t pid;uint64_t ticks;char ns[64]; } Record;
static Json input;
static Record records[256];
static uint64_t now_ms(void){struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return 0;return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000;}
static int read_at(int directory,const char *name,char *buffer,size_t capacity){int fd=openat(directory,name,O_RDONLY|O_CLOEXEC);if(fd<0)return -1;size_t n=0;while(n<capacity-1){ssize_t k=read(fd,buffer+n,capacity-1-n);if(k<0&&errno==EINTR)continue;if(k<0){close(fd);return -1;}if(!k){buffer[n]=0;close(fd);return (int)n;}n+=(size_t)k;}close(fd);return -1;}
static int decimal(const char *s,uint64_t *v){if(!*s||strlen(s)>20||*s=='0')return 0;uint64_t n=0;for(;*s;s++){unsigned d=(unsigned)(*s-'0');if(d>9||n>UINT64_MAX/10||(n==UINT64_MAX/10&&d>UINT64_MAX%10))return 0;n=n*10+d;}*v=n;return 1;}
static int ticks_at(int directory,pid_t expected,uint64_t *ticks){char buffer[16384];if(read_at(directory,"stat",buffer,sizeof(buffer))<1)return 0;char *open=strchr(buffer,'('),*close=strrchr(buffer,')');if(!open||!close||open<buffer+2||close<open||close[1]!=' ')return 0;char pid[32];size_t n=(size_t)(open-buffer-1);if(n>=sizeof(pid))return 0;memcpy(pid,buffer,n);pid[n]=0;uint64_t actual;if(!decimal(pid,&actual)||actual!=(uint64_t)expected)return 0;char *p=close+2;for(int field=3;field<=22;field++){while(*p==' ')p++;char *end=p;while(*end&&*end!=' '&&*end!='\n')end++;if(end==p)return 0;if(field==22){char old=*end;*end=0;int valid=decimal(p,ticks);*end=old;return valid;}p=end;}return 0;}
static int namespace_at(int directory,char out[64]){int fd=openat(directory,"ns/pid",O_RDONLY|O_CLOEXEC);if(fd<0)return 0;struct stat st;int valid=fstat(fd,&st)==0;close(fd);if(valid)snprintf(out,64,"%ju:%ju",(uintmax_t)st.st_dev,(uintmax_t)st.st_ino);return valid;}
static int pidfd_exited(int fd){struct pollfd p={.fd=fd,.events=POLLIN};int n=poll(&p,1,0);if(n<0)return -1;if(n==0)return 0;return p.revents&POLLIN?1:-1;}
static const char *reclaim(Record *r,uint64_t deadline,int *error){
  if(now_ms()>=deadline)return "deadline";
  int pidfd=(int)syscall(SYS_pidfd_open,r->pid,0);if(pidfd<0){*error=errno;return errno==ESRCH?"already-gone-unconfirmed":"unknown";}
  const char *result="unknown";int exited=pidfd_exited(pidfd);if(exited==1){result="already-gone-unconfirmed";goto done;}if(exited<0)goto done;
  char route[64];snprintf(route,sizeof(route),"/proc/%d",r->pid);int directory=open(route,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(directory<0){*error=errno;goto done;}
  uint64_t ticks;char ns[64];int valid=ticks_at(directory,r->pid,&ticks)&&ticks==r->ticks&&namespace_at(directory,ns)&&!strcmp(ns,r->ns)&&ticks_at(directory,r->pid,&ticks)&&ticks==r->ticks&&pidfd_exited(pidfd)==0;
  close(directory);if(!valid){result="identity-mismatch-or-unknown";goto done;}if(now_ms()>=deadline){result="deadline";goto done;}
  /* 只向已持有且记录已验证的 pidfd 发送固定 SIGKILL，不调用 kill(numericPid,...)。 */
  if(syscall(SYS_pidfd_send_signal,pidfd,SIGKILL,NULL,0)<0){*error=errno;goto done;}
  uint64_t wait_end=now_ms()+5000;if(wait_end>deadline)wait_end=deadline;
  for(;;){uint64_t now=now_ms();if(now>=wait_end){result="sent-exit-unconfirmed";break;}struct pollfd p={.fd=pidfd,.events=POLLIN};int n=poll(&p,1,(int)(wait_end-now));if(n<0&&errno==EINTR)continue;if(n>0&&(p.revents&POLLIN)){result="terminated-and-exited";break;}if(n<0)*error=errno;result="sent-exit-unconfirmed";break;}
done:close(pidfd);return result;
}
int main(int argc,char **argv){(void)argv;if(argc!=1)return 2;uint64_t initial=now_ms(),deadline=initial+15000;char frame[65537];size_t used=0;
  while(used<65536){uint64_t now=now_ms();if(now>=deadline)return 3;struct pollfd p={.fd=0,.events=POLLIN};int n=poll(&p,1,(int)(deadline-now));if(n<0&&errno==EINTR)continue;if(n<=0)return 3;char c;if(read(0,&c,1)!=1)return 2;frame[used++]=c;if(c=='\n')break;}if(!used||frame[used-1]!='\n')return 2;frame[--used]=0;
  if(!j_parse(&input,frame,used))return 2;const char *const required[]={"protocol","nonce","bootId","budgetMs","records"};if(!j_keys(&input,0,required,5,NULL,0))return 2;
  uint64_t protocol,budget;char nonce[49],boot[37],current[64];if(!j_uint(&input,j_get(&input,0,"protocol"),1,&protocol)||!j_uint(&input,j_get(&input,0,"budgetMs"),15000,&budget)||!j_string(&input,j_get(&input,0,"nonce"),nonce,sizeof(nonce))||strlen(nonce)!=48||!j_string(&input,j_get(&input,0,"bootId"),boot,sizeof(boot)))return 2;
  for(int i=0;i<48;i++)if(!((nonce[i]>='0'&&nonce[i]<='9')||(nonce[i]>='a'&&nonce[i]<='f')))return 2;
  if(read_at(AT_FDCWD,"/proc/sys/kernel/random/boot_id",current,sizeof(current))!=37||current[36]!='\n')return 2;current[36]=0;if(strcmp(current,boot))return 2;
  if(initial+budget<deadline)deadline=initial+budget;
  int array=j_get(&input,0,"records");if(array<0||input.tokens[array].kind!=J_ARRAY||input.tokens[array].count>256)return 2;
  int count=0;const char *const fields[]={"pid","startTicks","pidNamespace"};char ownns[64];int own=open("/proc/self",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(own<0||!namespace_at(own,ownns)){if(own>=0)close(own);return 2;}close(own);
  for(int p=array+1;p<input.tokens[array].next;p=input.tokens[p].next){uint64_t pid;char ticks[32];Record *r=&records[count];if(!j_keys(&input,p,fields,3,NULL,0)||!j_uint(&input,j_get(&input,p,"pid"),INT_MAX,&pid)||pid<=1||pid==(uint64_t)getpid()||pid==(uint64_t)getppid()||!j_string(&input,j_get(&input,p,"startTicks"),ticks,sizeof(ticks))||!decimal(ticks,&r->ticks)||!j_string(&input,j_get(&input,p,"pidNamespace"),r->ns,sizeof(r->ns))||strcmp(ownns,r->ns))return 2;r->pid=(pid_t)pid;for(int k=0;k<count;k++)if(records[k].pid==r->pid)return 2;count++;}
  if(count==0){
    if(now_ms()>=deadline)return 3;
    /* 能力预检不接受自选目标或信号；自身 signal-0 成功不证明其他进程的权限或清理结果。 */
    int self=(int)syscall(SYS_pidfd_open,getpid(),0);if(self<0)return 4;
    int sent=(int)syscall(SYS_pidfd_send_signal,self,0,NULL,0);
    int exited=pidfd_exited(self);int closed=close(self);
    if(sent!=0||exited!=0||closed!=0)return 4;
    printf("{\"protocol\":1,\"nonce\":\"%s\",\"nativeEligibility\":\"pidfd-self-open-send0-poll\",\"scopeObservationComplete\":false,\"results\":[]}\n",nonce);
    return fflush(stdout)==0?0:2;
  }
  printf("{\"protocol\":1,\"nonce\":\"%s\",\"scopeObservationComplete\":false,\"results\":[",nonce);
  for(int i=0;i<count;i++){int error=0;const char *result=reclaim(&records[i],deadline,&error);printf("%s{\"pid\":%d,\"startTicks\":\"%" PRIu64 "\",\"result\":\"%s\"",i?",":"",records[i].pid,records[i].ticks,result);if(error)printf(",\"systemCode\":%d",error);printf("}");}
  printf("]}\n");return fflush(stdout)==0?0:2;
}
