/* 独立组件验证，不涉及 Yunzai、Node 构建或外部路径；取消失败是故意注入的测试故障。 */
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <wchar.h>
#include <process.h>
#define uv__malloc malloc
static BOOL fixture_cancel(HANDLE thread) { (void)thread; SetLastError(ERROR_NOT_FOUND); return FALSE; }
#define CancelSynchronousIo fixture_cancel
#include "../../scripts/private-node/canonical-metadata-client.h"
#undef CancelSynchronousIo

typedef struct {
  HANDLE pipe, thread, pause, started;
  const char* mode;
  WCHAR endpoint[129], path[32768];
  unsigned char nonce[24];
  LONG queries, hellos;
} fixture;
static int assertions;
#define REQUIRE(value) do { assertions++; if (!(value)) { fprintf(stderr, "assertion:%d:%s error=%lu\n", __LINE__, #value, GetLastError()); return 1; } } while (0)
static int io(HANDLE pipe, void* p, DWORD bytes, int write) {
  DWORD count, at = 0;
  while (at < bytes) {
    if (!(write ? WriteFile(pipe, (char*)p + at, bytes - at, &count, NULL) : ReadFile(pipe, (char*)p + at, bytes - at, &count, NULL)) || count == 0) return 0;
    at += count;
  }
  return 1;
}
static unsigned __stdcall server(void* argument) {
  fixture* f = (fixture*)argument;
  unsigned char request[88], reply[64 + 65536 + 1]; DWORD units, size; uint64_t seq;
  if (!ConnectNamedPipe(f->pipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) return 0;
  while (io(f->pipe, request, 88, 0)) {
    if (gc_u32(request) != GC_MAGIC || gc_u16(request + 4) != 1 || gc_u16(request + 6) != 88 || memcmp(request + 24, f->nonce, 24) != 0) return 2;
    seq = gc_u64(request + 8); memset(reply, 0, sizeof(reply));
    gc_p32(reply, GC_MAGIC); gc_p16(reply + 4, 1); gc_p16(reply + 6, 64); gc_p64(reply + 8, seq);
    if (gc_u32(request + 80) == 1) {
      InterlockedIncrement(&f->hellos);
      if (!io(f->pipe, reply, 64, 1)) return 0;
      continue;
    }
    InterlockedIncrement(&f->queries);
    if (!strcmp(f->mode, "timeout") || !strcmp(f->mode, "slots")) {
      SetEvent(f->started); WaitForSingleObject(f->pause, 5000);
    }
    units = (DWORD)wcslen(f->path); gc_p32(reply + 24, units); memcpy(reply + 32, request + 48, 24);
    memcpy(reply + 64, f->path, units * sizeof(WCHAR)); size = 64 + units * sizeof(WCHAR);
    if (!strcmp(f->mode, "bad-sequence")) gc_p64(reply + 8, seq + 1);
    if (!strcmp(f->mode, "bad-id")) reply[32] ^= 1;
    if (!strcmp(f->mode, "embedded-nul")) memset(reply + 64 + 8 * sizeof(WCHAR), 0, sizeof(WCHAR));
    if (!strcmp(f->mode, "extra-reply")) reply[size++] = 1;
    if (!strcmp(f->mode, "short-reply")) { io(f->pipe, reply, 32, 1); DisconnectNamedPipe(f->pipe); return 0; }
    if (!io(f->pipe, reply, size, 1)) return 0;
  }
  return 0;
}
static int bootstrap(fixture* f, const WCHAR* image) {
  WCHAR path[32768]; unsigned char bytes[512]; DWORD units, at, wrote; HANDLE output;
  FILETIME birth, exit, kernel, user;
  wcscpy(path, image);
  for (at = (DWORD)wcslen(path); at != 0 && path[at - 1] != L'\\'; at--) { }
  wcscpy(path + at, L"canonical-metadata-v1.bin");
  memset(bytes, 0, sizeof(bytes));
  gc_p32(bytes, GC_BOOT_MAGIC); gc_p16(bytes + 4, 1); gc_p16(bytes + 6, 64);
  gc_p32(bytes + 8, GetCurrentProcessId() + (!strcmp(f->mode, "wrong-server") ? 1 : 0));
  units = (DWORD)wcslen(f->endpoint); gc_p16(bytes + 12, (uint16_t)units);
  if (!GetProcessTimes(GetCurrentProcess(), &birth, &exit, &kernel, &user)) return 0;
  memcpy(bytes + 16, &birth, 8); memcpy(bytes + 24, f->nonce, 24); memcpy(bytes + 64, f->endpoint, units * 2);
  if (!strcmp(f->mode, "bad-bootstrap")) bytes[48] = 1;
  output = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (output == INVALID_HANDLE_VALUE) return 0;
  at = WriteFile(output, bytes, 64 + units * 2, &wrote, NULL) && wrote == 64 + units * 2;
  CloseHandle(output); return (int)at;
}
static int wait_slots(LONG expected) {
  ULONGLONG end = GetTickCount64() + 2000;
  while (InterlockedCompareExchange(&gc_slots, 0, 0) != expected && GetTickCount64() < end) Sleep(5);
  return InterlockedCompareExchange(&gc_slots, 0, 0) == expected;
}
static int exercise(fixture* f, const WCHAR* original) {
  gc_request* request; HANDLE file, saved; WCHAR* result; DWORD units = 0, i; ULONGLONG start;
  unsigned char identity[24];
  gc_phase = 1; gc_lock = CreateSemaphoreW(NULL, 1, 1, NULL); gc_dead = CreateEventW(NULL, TRUE, FALSE, NULL);
  REQUIRE(gc_lock != NULL && gc_dead != NULL);
  request = gc_submit(NULL, 1); REQUIRE(request != NULL);
  i = gc_await(request); gc_release(request);
  if (!strcmp(f->mode, "wrong-server") || !strcmp(f->mode, "bad-bootstrap")) {
    REQUIRE(i == 0); gc_disable(); REQUIRE(wait_slots(0)); return 0;
  }
  REQUIRE(i == 1 && gc_phase == 2 && f->hellos == 1);
  if (!strcmp(f->mode, "slots")) {
    gc_request* pending[8];
    for (i = 0; i < 8; i++) {
      file = CreateFileW(original, 0, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
      REQUIRE(file != INVALID_HANDLE_VALUE); pending[i] = gc_submit(&file, 0);
      REQUIRE(pending[i] != NULL && file == INVALID_HANDLE_VALUE);
    }
    REQUIRE(WaitForSingleObject(f->started, 1000) == WAIT_OBJECT_0 && gc_slots == 8);
    file = CreateFileW(original, 0, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL); saved = file;
    REQUIRE(file != INVALID_HANDLE_VALUE && gc_submit(&file, 0) == NULL && file == saved); CloseHandle(file);
    start = GetTickCount64();
    for (i = 0; i < 8; i++) { REQUIRE(gc_await(pending[i]) == 0); gc_release(pending[i]); }
    REQUIRE(GetTickCount64() - start <= 2300 && gc_phase == 3 && gc_slots == 1);
    SetEvent(f->pause); REQUIRE(wait_slots(0)); return 0;
  }
  file = CreateFileW(original, 0, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL); saved = file;
  REQUIRE(file != INVALID_HANDLE_VALUE); start = GetTickCount64();
  result = uv__canonical_metadata(&file, &units);
  REQUIRE(file == INVALID_HANDLE_VALUE);
  if (!strcmp(f->mode, "normal") || !strcmp(f->mode, "unpaired-surrogate")) {
    REQUIRE(result != NULL && units == wcslen(f->path) && !wmemcmp(result, f->path, units)); free(result);
  } else {
    REQUIRE(result == NULL);
    if (!strcmp(f->mode, "timeout")) {
      REQUIRE(GetTickCount64() - start >= 1800 && GetTickCount64() - start <= 2300);
      REQUIRE(gc_phase == 3 && gc_slots == 1);
      /* 仍使用已移交的自有原始句柄，不重新打开进程或 PID。 */
      REQUIRE(GetFileInformationByHandleEx(saved, (FILE_INFO_BY_HANDLE_CLASS)18, identity, 24));
      SetEvent(f->pause);
    }
  }
  REQUIRE(wait_slots(0));
  if (gc_phase == 3) {
    file = CreateFileW(original, 0, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL); saved = file;
    start = GetTickCount64(); REQUIRE(uv__canonical_metadata(&file, &units) == NULL && file == saved && GetTickCount64() - start < 100);
    CloseHandle(file); REQUIRE(f->hellos == 1 && f->queries == 1);
  }
  return 0;
}
int wmain(int argc, WCHAR** argv) {
  fixture f; WCHAR original[32768], image[32768]; HANDLE file; DWORD n; int result = 1; uintptr_t thread;
  if (argc != 3) return 2;
  memset(&f, 0, sizeof(f)); f.pipe = INVALID_HANDLE_VALUE;
  f.mode = "normal";
  {
    static char mode[64];
    if (!WideCharToMultiByte(CP_UTF8, 0, argv[1], -1, mode, sizeof(mode), NULL, NULL)) return 2;
    f.mode = mode;
  }
  swprintf(original, 32768, L"%ls\\canonical-\x6d4b\x8bd5.txt", argv[2]);
  if (!strcmp(f.mode, "unpaired-surrogate")) {
    static const WCHAR suffix[] = { L'\\', L'c', L'a', L'n', L'o', L'n', L'-', 0xd800, L'.', L't', L'x', L't', 0 };
    wcscpy(original, argv[2]); wcscat(original, suffix);
  }
  file = CreateFileW(original, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 2;
  CloseHandle(file);
  file = CreateFileW(original, 0, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 2;
  n = GetFinalPathNameByHandleW(file, f.path, 32768, 0); CloseHandle(file);
  if (n == 0 || n >= 32768) return 2;
  if (!strcmp(f.mode, "wrong-file")) {
    wcscat(f.path, L".other"); file = CreateFileW(f.path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2; CloseHandle(file);
  }
  if (!strcmp(f.mode, "missing-file")) wcscat(f.path, L".missing");
  if (!strcmp(f.mode, "unc-path")) wcscpy(f.path, L"\\\\?\\UNC\\fixture.invalid\\never-opened");
  swprintf(f.endpoint, 129, L"\\\\.\\pipe\\yunzai-guard-canonical-%016llx%016llx", (unsigned long long)GetCurrentProcessId(), (unsigned long long)GetTickCount64());
  memset(f.nonce, 0x2a, 24);
  f.pipe = CreateNamedPipeW(f.endpoint, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS, 1, 131072, 4096, 2000, NULL);
  f.pause = CreateEventW(NULL, TRUE, FALSE, NULL); f.started = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (f.pipe == INVALID_HANDLE_VALUE || f.pause == NULL || f.started == NULL) goto cleanup;
  GetModuleFileNameW(NULL, image, 32768);
  if (!bootstrap(&f, image)) goto cleanup;
  thread = _beginthreadex(NULL, 0, server, &f, 0, NULL); if (thread == 0) goto cleanup; f.thread = (HANDLE)thread;
  result = exercise(&f, original);
cleanup:
  gc_disable();
  SetEvent(f.pause);
  if (gc_pipe != INVALID_HANDLE_VALUE) { CloseHandle(gc_pipe); gc_pipe = INVALID_HANDLE_VALUE; }
  if (f.thread != NULL) {
    CancelSynchronousIo(f.thread);
    if (WaitForSingleObject(f.thread, 2000) != WAIT_OBJECT_0) result = 3;
    CloseHandle(f.thread);
  }
  if (f.pipe != INVALID_HANDLE_VALUE) CloseHandle(f.pipe);
  if (f.pause != NULL) CloseHandle(f.pause);
  if (f.started != NULL) CloseHandle(f.started);
  if (gc_lock != NULL) CloseHandle(gc_lock);
  if (gc_dead != NULL) CloseHandle(gc_dead);
  printf("{\"mode\":\"%s\",\"assertions\":%d,\"hellos\":%ld,\"queries\":%ld,\"remainingSlots\":%ld,\"nativeExit\":%d}\n", f.mode, assertions, f.hellos, f.queries, gc_slots, result);
  return result;
}
