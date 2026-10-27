/* 仅供插件私有运行时使用，元数据不能代理文件内容。
 * 由 win/fs.c 在 internal.h 后包含一次；uv__fs_init 已在 JS 启动前运行，禁止重复初始化。 */
#ifndef YUNZAI_CANONICAL_METADATA_CLIENT_H
#define YUNZAI_CANONICAL_METADATA_CLIENT_H
#include <process.h>
#include <stdint.h>
#include <wchar.h>

#define GC_MAGIC 0x314d4347u
#define GC_BOOT_MAGIC 0x31424d43u
#define GC_BUDGET 2000u
#define GC_MAX_UNITS 32767u
#define GC_SLOTS 8

typedef struct {
  LONG references;
  LONG abandoned;
  HANDLE start, done, thread, file;
  ULONGLONG deadline;
  int initialize, success;
  unsigned char request[88], reply[64];
  WCHAR path[GC_MAX_UNITS + 1];
  DWORD units;
} gc_request;

static volatile LONG gc_phase; /* 0 not initialized, 1 connecting, 2 live, 3 dead */
static volatile LONG gc_slots;
static HANDLE gc_lock, gc_dead, gc_pipe = INVALID_HANDLE_VALUE;
static DWORD gc_server;
static uint64_t gc_birth, gc_sequence;
static unsigned char gc_nonce[24];

static uint16_t gc_u16(const unsigned char* p) { uint16_t n; memcpy(&n, p, 2); return n; }
static uint32_t gc_u32(const unsigned char* p) { uint32_t n; memcpy(&n, p, 4); return n; }
static uint64_t gc_u64(const unsigned char* p) { uint64_t n; memcpy(&n, p, 8); return n; }
static void gc_p16(unsigned char* p, uint16_t n) { memcpy(p, &n, 2); }
static void gc_p32(unsigned char* p, uint32_t n) { memcpy(p, &n, 4); }
static void gc_p64(unsigned char* p, uint64_t n) { memcpy(p, &n, 8); }
static int gc_zero(const unsigned char* p, size_t n) {
  size_t i; unsigned char all = 0;
  for (i = 0; i < n; i++) all |= p[i];
  return all == 0;
}
static DWORD gc_remaining(gc_request* r) {
  ULONGLONG now = GetTickCount64();
  return now >= r->deadline ? 0 : (DWORD)(r->deadline - now);
}
static int gc_alive(gc_request* r) {
  return !InterlockedCompareExchange(&r->abandoned, 0, 0) &&
         InterlockedCompareExchange(&gc_phase, 0, 0) != 3 && gc_remaining(r) != 0;
}
static void gc_disable(void) {
  InterlockedExchange(&gc_phase, 3);
  if (gc_dead != NULL) SetEvent(gc_dead);
}
static void gc_release(gc_request* r) {
  if (InterlockedDecrement(&r->references) != 0) return;
  if (r->file != INVALID_HANDLE_VALUE) CloseHandle(r->file);
  if (r->thread != NULL) CloseHandle(r->thread);
  if (r->done != NULL) CloseHandle(r->done);
  if (r->start != NULL) CloseHandle(r->start);
  free(r);
  InterlockedDecrement(&gc_slots);
}
static int gc_io(gc_request* r, HANDLE pipe, void* buffer, DWORD bytes, int write) {
  DWORD at = 0, count;
  while (at < bytes) {
    if (!gc_alive(r)) return 0;
    count = 0;
    if (!(write ? WriteFile(pipe, (char*)buffer + at, bytes - at, &count, NULL)
                : ReadFile(pipe, (char*)buffer + at, bytes - at, &count, NULL)) || count == 0)
      return 0;
    at += count;
  }
  return gc_alive(r);
}
static int gc_endpoint(const WCHAR* path, DWORD units) {
  static const WCHAR prefix[] = L"\\\\.\\pipe\\yunzai-guard-canonical-";
  DWORD i, n = (DWORD)(sizeof(prefix) / sizeof(WCHAR) - 1);
  if (units != n + 32 || wmemcmp(path, prefix, n) != 0) return 0;
  for (i = n; i < units; i++)
    if (!((path[i] >= L'0' && path[i] <= L'9') || (path[i] >= L'a' && path[i] <= L'f')))
      return 0;
  return 1;
}
static int gc_dos_path(const WCHAR* path, DWORD n) {
  DWORD i;
  if (n < 7 || n > GC_MAX_UNITS || wmemcmp(path, L"\\\\?\\", 4) != 0 ||
      !((path[4] >= L'A' && path[4] <= L'Z') || (path[4] >= L'a' && path[4] <= L'z')) ||
      path[5] != L':' || path[6] != L'\\') return 0;
  for (i = 0; i < n; i++) if (path[i] == 0 || (i > 5 && path[i] == L':')) return 0;
  return 1;
}
static int gc_pipe_identity(HANDLE pipe) {
  ULONG pid; DWORD available;
  return GetNamedPipeServerProcessId(pipe, &pid) && pid == gc_server &&
         PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL) && available == 0;
}
static void gc_frame(gc_request* r, uint64_t seq, uint64_t file, const unsigned char* id, DWORD kind) {
  memset(r->request, 0, sizeof(r->request));
  gc_p32(r->request, GC_MAGIC); gc_p16(r->request + 4, 1); gc_p16(r->request + 6, 88);
  gc_p64(r->request + 8, seq); gc_p64(r->request + 16, file);
  memcpy(r->request + 24, gc_nonce, 24);
  if (id != NULL) memcpy(r->request + 48, id, 24);
  gc_p64(r->request + 72, gc_birth); gc_p32(r->request + 80, kind);
}
/* -1：会话损坏；0：合法拒绝；1：完整成功。 */
static int gc_exchange(gc_request* r, HANDLE pipe, uint64_t seq, int hello) {
  DWORD status, units;
  if (!gc_io(r, pipe, r->request, 88, 1) || !gc_io(r, pipe, r->reply, 64, 0)) return -1;
  status = gc_u32(r->reply + 16); units = gc_u32(r->reply + 24);
  if (gc_u32(r->reply) != GC_MAGIC || gc_u16(r->reply + 4) != 1 || gc_u16(r->reply + 6) != 64 ||
      gc_u64(r->reply + 8) != seq || gc_u32(r->reply + 28) != 0 || gc_u64(r->reply + 56) != 0 ||
      units > GC_MAX_UNITS || !(status == 0 || status == 2 || status == 4 || status == 5 || status == 6 || status == 7)) return -1;
  if (status != 0) {
    if (units != 0 || !gc_zero(r->reply + 32, 24) || (status != 7 && gc_u32(r->reply + 20) != 0)) return -1;
    return gc_pipe_identity(pipe) ? 0 : -1;
  }
  if (gc_u32(r->reply + 20) != 0) return -1;
  if (hello) return units == 0 && gc_zero(r->reply + 32, 24) && gc_pipe_identity(pipe) ? 1 : -1;
  if (units == 0 || !gc_io(r, pipe, r->path, units * sizeof(WCHAR), 0)) return -1;
  r->path[units] = 0; r->units = units;
  return gc_dos_path(r->path, units) ? 1 : -1;
}
static int gc_bootstrap(gc_request* r, WCHAR* endpoint) {
  WCHAR image[32768]; unsigned char bytes[512], after[24], before[24];
  BY_HANDLE_FILE_INFORMATION info; LARGE_INTEGER size; HANDLE file;
  DWORD n, got, at, i; FILETIME birth, exit, kernel, user;
  n = GetModuleFileNameW(NULL, image, 32768);
  if (n == 0 || n >= 32768) return 0;
  for (at = n; at != 0 && image[at - 1] != L'\\'; at--) { }
  if (at == 0 || at + 26 >= 32768) return 0;
  wcscpy(image + at, L"canonical-metadata-v1.bin");
  file = CreateFileW(image, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                     FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return 0;
  n = 0;
  if (GetFileInformationByHandle(file, &info) && info.nNumberOfLinks == 1 &&
      !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
      GetFileSizeEx(file, &size) && size.QuadPart >= 64 && size.QuadPart <= 512 &&
      GetFileInformationByHandleEx(file, (FILE_INFO_BY_HANDLE_CLASS)18, before, 24) &&
      ReadFile(file, bytes, (DWORD)size.QuadPart, &got, NULL) && got == size.QuadPart &&
      GetFileInformationByHandleEx(file, (FILE_INFO_BY_HANDLE_CLASS)18, after, 24) && memcmp(before, after, 24) == 0)
    n = got;
  CloseHandle(file);
  if (n < 64 || gc_u32(bytes) != GC_BOOT_MAGIC || gc_u16(bytes + 4) != 1 || gc_u16(bytes + 6) != 64 ||
      gc_u32(bytes + 8) == 0 || gc_u16(bytes + 14) != 0 || gc_u64(bytes + 16) == 0 ||
      gc_zero(bytes + 24, 24) || !gc_zero(bytes + 48, 16)) return 0;
  got = gc_u16(bytes + 12);
  if (got > 128 || n != 64 + got * 2) return 0;
  for (i = 0; i < got; i++) endpoint[i] = (WCHAR)gc_u16(bytes + 64 + i * 2);
  endpoint[got] = 0;
  if (!gc_endpoint(endpoint, got) || !gc_alive(r) ||
      !GetProcessTimes(GetCurrentProcess(), &birth, &exit, &kernel, &user)) return 0;
  gc_server = gc_u32(bytes + 8); memcpy(gc_nonce, bytes + 24, 24); memcpy(&gc_birth, &birth, 8);
  return 1;
}
static int gc_connect(gc_request* r) {
  WCHAR endpoint[129]; HANDLE pipe = INVALID_HANDLE_VALUE; int ok = 0;
  if (!gc_bootstrap(r, endpoint)) return 0;
  while (gc_alive(r)) {
    pipe = CreateFileW(endpoint, 0x100003, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY || !WaitNamedPipeW(endpoint, gc_remaining(r))) return 0;
  }
  if (pipe == INVALID_HANDLE_VALUE) return 0;
  if (gc_pipe_identity(pipe)) {
    gc_frame(r, 0, 0, NULL, 1);
    if (gc_exchange(r, pipe, 0, 1) == 1 && gc_alive(r)) {
      gc_pipe = pipe;
      if (InterlockedCompareExchange(&gc_phase, 2, 1) == 1) ok = 1;
      else gc_pipe = INVALID_HANDLE_VALUE;
    }
  }
  if (!ok) CloseHandle(pipe);
  return ok;
}
static int gc_query(gc_request* r) {
  HANDLE reopen = INVALID_HANDLE_VALUE; unsigned char before[24], after[24], reopened[24]; int reply;
  if (!gc_alive(r) || !GetFileInformationByHandleEx(r->file, (FILE_INFO_BY_HANDLE_CLASS)18, before, 24) ||
      gc_sequence == UINT64_MAX) return 0;
  gc_frame(r, ++gc_sequence, (uint64_t)(uintptr_t)r->file, before, 2);
  reply = gc_exchange(r, gc_pipe, gc_sequence, 0);
  if (reply < 0) { gc_disable(); return 0; }
  if (reply == 0) return 0;
  if (memcmp(before, r->reply + 32, 24) != 0 ||
      !GetFileInformationByHandleEx(r->file, (FILE_INFO_BY_HANDLE_CLASS)18, after, 24) || memcmp(before, after, 24) != 0) goto broken;
  /* 仅以客体身份和原始 libuv 权限重开文件；Host 路径不能授权替换对象。 */
  reopen = CreateFileW(r->path, 0, 0, NULL, OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (reopen == INVALID_HANDLE_VALUE) return 0;
  reply = GetFileInformationByHandleEx(reopen, (FILE_INFO_BY_HANDLE_CLASS)18, reopened, 24) &&
          memcmp(before, reopened, 24) == 0;
  CloseHandle(reopen);
  if (!reply) goto broken;
  if (!GetFileInformationByHandleEx(r->file, (FILE_INFO_BY_HANDLE_CLASS)18, after, 24) ||
      memcmp(before, after, 24) != 0 || !gc_pipe_identity(gc_pipe) || !gc_alive(r)) goto broken;
  return 1;
broken:
  gc_disable(); return 0;
}
static unsigned __stdcall gc_worker(void* arg) {
  gc_request* r = (gc_request*)arg; HANDLE waiting[2]; DWORD wait; int locked = 0;
  WaitForSingleObject(r->start, INFINITE);
  if (r->initialize) r->success = gc_connect(r);
  else {
    waiting[0] = gc_dead; waiting[1] = gc_lock;
    wait = WaitForMultipleObjects(2, waiting, FALSE, gc_remaining(r));
    if (wait == WAIT_OBJECT_0 + 1) {
      locked = 1;
      if (gc_alive(r) && InterlockedCompareExchange(&gc_phase, 0, 0) == 2) r->success = gc_query(r);
    }
  }
  if (!gc_alive(r)) r->success = 0;
  if (InterlockedCompareExchange(&gc_phase, 0, 0) == 3 && (locked || r->initialize) && gc_pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(gc_pipe); gc_pipe = INVALID_HANDLE_VALUE;
  }
  if (locked) ReleaseSemaphore(gc_lock, 1, NULL);
  SetEvent(r->done);
  gc_release(r);
  return 0;
}
static gc_request* gc_submit(HANDLE* file, int initialize) {
  gc_request* r; uintptr_t thread;
  if (InterlockedIncrement(&gc_slots) > GC_SLOTS) { InterlockedDecrement(&gc_slots); return NULL; }
  r = (gc_request*)calloc(1, sizeof(*r));
  if (r == NULL) { InterlockedDecrement(&gc_slots); return NULL; }
  r->references = 1; r->file = INVALID_HANDLE_VALUE; r->initialize = initialize;
  r->deadline = GetTickCount64() + GC_BUDGET;
  r->start = CreateEventW(NULL, TRUE, FALSE, NULL); r->done = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (r->start == NULL || r->done == NULL) { gc_release(r); return NULL; }
  r->references = 2;
  thread = _beginthreadex(NULL, 0, gc_worker, r, 0, NULL);
  if (thread == 0) { r->references = 1; gc_release(r); return NULL; }
  r->thread = (HANDLE)thread;
  if (file != NULL) { r->file = *file; *file = INVALID_HANDLE_VALUE; }
  SetEvent(r->start);
  return r;
}
static int gc_await(gc_request* r) {
  if (WaitForSingleObject(r->done, gc_remaining(r)) == WAIT_OBJECT_0 && gc_alive(r)) return r->success;
  InterlockedExchange(&r->abandoned, 1); gc_disable();
  /* 双方释放前持续持有原始 Worker 句柄；取消请求不授权释放待处理缓冲区或文件。 */
  CancelSynchronousIo(r->thread);
  return 0;
}
static void uv__canonical_init(void) {
  WCHAR flag[3]; HANDLE token; DWORD ac = 0, bytes; gc_request* r;
  if (InterlockedCompareExchange(&gc_phase, 1, 0) != 0) return;
  if (GetEnvironmentVariableW(L"YUNZAI_GUARD_CANONICAL_METADATA", flag, 3) != 1 || flag[0] != L'1' ||
      !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { gc_disable(); return; }
  bytes = sizeof(ac);
  if (!GetTokenInformation(token, (TOKEN_INFORMATION_CLASS)29, &ac, bytes, &bytes)) ac = 0;
  CloseHandle(token);
  if (ac == 0) { gc_disable(); return; }
  gc_lock = CreateSemaphoreW(NULL, 1, 1, NULL); gc_dead = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (gc_lock == NULL || gc_dead == NULL) { gc_disable(); return; }
  r = gc_submit(NULL, 1);
  if (r == NULL) { gc_disable(); return; }
  if (!gc_await(r)) gc_disable();
  gc_release(r);
}
/* 接收请求时移交原始 realpath 句柄所有权；调用方超时不能关闭仍在查询的句柄。 */
static WCHAR* uv__canonical_metadata(HANDLE* file, DWORD* units) {
  gc_request* r; WCHAR* result = NULL;
  if (InterlockedCompareExchange(&gc_phase, 0, 0) != 2) return NULL;
  r = gc_submit(file, 0);
  if (r == NULL) return NULL;
  if (gc_await(r)) {
    result = uv__malloc((r->units + 1) * sizeof(WCHAR));
    if (result != NULL) { memcpy(result, r->path, (r->units + 1) * sizeof(WCHAR)); *units = r->units; }
  }
  gc_release(r);
  return result;
}
#endif
