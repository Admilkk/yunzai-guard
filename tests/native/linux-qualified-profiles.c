/* 仅验证固定表项选择，不调用重命名后的生产入口。 */
#define main guard_identity_unused_entrypoint
#include "../../native/process-identity/linux_identity.c"
#undef main

int main(void) {
  const char *musl="569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
  const char *glibc="e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb";
  const char *selected=qualified_image_profile(musl);
  if(!selected||strcmp(selected,"node24.22.1-linux-x64-musl-569128"))return 1;
  selected=qualified_image_profile(glibc);
  if(!selected||strcmp(selected,"node24.22.1-linux-x64-glibc-e32e2d"))return 2;
  if(qualified_image_profile("0000000000000000000000000000000000000000000000000000000000000000"))return 3;
  if(qualified_image_profile(""))return 4;
  if(qualified_image_profile("e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfaf"))return 5;
  if(qualified_image_profile("e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb0"))return 6;
  if(qualified_image_profile("E32E2D16081CF644F88392934288086E7662529D0D43277C34F7AAD2207CFAFB"))return 7;
  puts("{\"passed\":7,\"processQueries\":0,\"signals\":0,\"inspectorActions\":0}");
  return 0;
}
