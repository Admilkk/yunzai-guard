/* 私有测试实现：限制大小并拒绝未知字段的 JSON 协议解码器。 */
#ifndef GUARD_NATIVE_JSON_H
#define GUARD_NATIVE_JSON_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

#define J_MAX 4096
typedef struct { int kind, start, end, next, count; } JToken;
typedef struct { const char *text; size_t length, at; int used, error; JToken tokens[J_MAX]; } Json;
enum { J_OBJECT = 1, J_ARRAY, J_STRING, J_NUMBER, J_TRUE, J_FALSE, J_NULL };
static void j_space(Json *j) { while (j->at < j->length && (j->text[j->at]==' ' || j->text[j->at]=='\r' || j->text[j->at]=='\n' || j->text[j->at]=='\t')) j->at++; }
static int j_string_equal(Json *j, int a, int b) {
  JToken *x=&j->tokens[a], *y=&j->tokens[b];
  return x->kind==J_STRING && y->kind==J_STRING && x->end-x->start==y->end-y->start && !memcmp(j->text+x->start,j->text+y->start,(size_t)(x->end-x->start));
}
static int j_parse_value(Json *j, int depth) {
  j_space(j);
  if (depth>16 || j->used>=J_MAX || j->at>=j->length) { j->error=1; return -1; }
  int id=j->used++, kind=0; JToken *t=&j->tokens[id];
  char c=j->text[j->at];
  t->start=(int)j->at;
  if (c=='{' || c=='[') {
    t->kind=c=='{'?J_OBJECT:J_ARRAY; j->at++; j_space(j);
    char close=c=='{'?'}':']';
    if (j->at<j->length && j->text[j->at]==close) j->at++;
    else for (;;) {
      if (t->kind==J_OBJECT) {
        if (j->at>=j->length || j->text[j->at]!='"') { j->error=1; break; }
        int key=j_parse_value(j,depth+1);
        if (key<0) break;
        /* 键仅允许未转义 ASCII，确保精确检查重名。 */
        for (int p=id+1; p<key;) { if (j_string_equal(j,p,key)) j->error=1; p=j->tokens[j->tokens[p].next].next; }
        j_space(j); if (j->at>=j->length || j->text[j->at++]!=':') { j->error=1; break; }
      }
      if (j_parse_value(j,depth+1)<0) break;
      t->count++; j_space(j);
      if (j->at>=j->length) { j->error=1; break; }
      char end=j->text[j->at++]; if (end==close) break;
      if (end!=',') { j->error=1; break; }
      j_space(j);
    }
  } else if (c=='"') {
    t->kind=J_STRING; t->start=(int)++j->at;
    while (j->at<j->length && j->text[j->at]!='"') {
      unsigned char x=(unsigned char)j->text[j->at++];
      /* 协议字符串不承载路径或自由文本，拒绝转义和 Unicode。 */
      if (x<32 || x>126 || x=='\\') { j->error=1; break; }
    }
    t->end=(int)j->at;
    if (j->at>=j->length || j->text[j->at++]!='"' || t->end-t->start>4096) j->error=1;
  } else if (c>='0' && c<='9') {
    t->kind=J_NUMBER;
    if (c=='0') j->at++;
    else while (j->at<j->length && j->text[j->at]>='0' && j->text[j->at]<='9') j->at++;
    t->end=(int)j->at;
  } else {
    const char *literal=NULL;
    if (c=='t') { literal="true"; kind=J_TRUE; }
    if (c=='f') { literal="false"; kind=J_FALSE; }
    if (c=='n') { literal="null"; kind=J_NULL; }
    if (!literal || j->length-j->at<strlen(literal) || memcmp(j->text+j->at,literal,strlen(literal))) j->error=1;
    else { j->at+=strlen(literal); t->kind=kind; t->end=(int)j->at; }
  }
  if (t->kind==J_OBJECT || t->kind==J_ARRAY) t->end=(int)j->at;
  t->next=j->used;
  return j->error?-1:id;
}
static int j_parse(Json *j, const char *text, size_t length) {
  memset(j,0,sizeof(*j)); j->text=text; j->length=length;
  if (j_parse_value(j,0)!=0) return 0;
  j_space(j); return !j->error && j->at==length && j->tokens[0].kind==J_OBJECT;
}
static int j_equals(Json *j, int token, const char *value) {
  if (token<0 || token>=j->used || j->tokens[token].kind!=J_STRING) return 0;
  JToken *t=&j->tokens[token]; return strlen(value)==(size_t)(t->end-t->start) && !memcmp(j->text+t->start,value,strlen(value));
}
static int j_get(Json *j, int object, const char *key) {
  if (object<0 || j->tokens[object].kind!=J_OBJECT) return -1;
  for (int p=object+1;p<j->tokens[object].next;) { int value=j->tokens[p].next; if (j_equals(j,p,key)) return value; p=j->tokens[value].next; }
  return -1;
}
static int j_keys(Json *j, int object, const char *const *required, size_t nr, const char *const *optional, size_t no) {
  if (object<0 || j->tokens[object].kind!=J_OBJECT) return 0;
  for (size_t i=0;i<nr;i++) if (j_get(j,object,required[i])<0) return 0;
  for (int p=object+1;p<j->tokens[object].next;) {
    int found=0; for (size_t i=0;i<nr;i++) if (j_equals(j,p,required[i])) found=1;
    for (size_t i=0;i<no;i++) if (j_equals(j,p,optional[i])) found=1;
    if (!found) return 0; p=j->tokens[j->tokens[p].next].next;
  }
  return 1;
}
static int j_string(Json *j, int token, char *output, size_t capacity) {
  if (token<0 || token>=j->used || j->tokens[token].kind!=J_STRING) return 0;
  JToken *t=&j->tokens[token]; size_t n=(size_t)(t->end-t->start);
  if (n>=capacity) return 0; memcpy(output,j->text+t->start,n); output[n]=0; return 1;
}
static int j_uint(Json *j, int token, uint64_t maximum, uint64_t *output) {
  if (token<0 || token>=j->used || j->tokens[token].kind!=J_NUMBER) return 0;
  JToken *t=&j->tokens[token]; uint64_t n=0;
  for (int i=t->start;i<t->end;i++) { unsigned digit=(unsigned)(j->text[i]-'0'); if (digit>9 || n>maximum/10 || (n==maximum/10 && digit>maximum%10)) return 0; n=n*10+digit; }
  if (!n) return 0; *output=n; return 1;
}
#endif
