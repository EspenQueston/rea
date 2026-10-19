/* Synthetic protocol faults only; never opens or executes the selected target. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  const char *mode = getenv("REA_FAULT_MODE");
  const char *transport = getenv("REA_FAULT_TRANSPORT");
  int pipe = !strcmp(transport, "r2pipe");
  int mcp = !strcmp(transport, "r2mcp");
  setbuf(stdout, NULL);
  if (pipe) putchar(0);
  FILE *ready = fopen(getenv("REA_FAULT_READY"), "w");
  if (!ready) return 1;
  fprintf(ready, "%d", getpid());
  fclose(ready);
  if (!strcmp(mode, "environment")) {
    const char *path = getenv("REA_FAULT_ENV_REPORT");
    FILE *report = fopen(path, "w");
    if (!report) return 4;
    fprintf(report, "%s\n%s\n", getenv("REA_FAULT_OMITTED") ? "inherited" : "absent",
        getenv("REA_FAULT_SELECTED"));
    fclose(report);
  }
  if (!strncmp(mode, "final-hash-", 11)) {
    const char *target = getenv("REA_FAULT_TARGET");
    if (!strcmp(mode, "final-hash-timeout")) {
      if (truncate(target, (off_t)4 * 1024 * 1024 * 1024)) return 2;
    } else if (unlink(target)) return 3;
    fputs("{\"error\":false,\"code\":0,\"res\":\"completed-native-reply\"}", stdout);
    fputs("completed-native-stderr\n", stderr);
    return 0;
  }
  if (!strcmp(mode, "blocked")) {
    for (;;) pause();
  }
  if (pipe || mcp) {
    int c;
    while ((c = getchar()) != '\n' && c != EOF) {}
  }
  if (!strcmp(mode, "partial")) {
    fputs("{\"res\":\"partial-", stdout);
    putchar(0xff);
    for (;;) pause();
  }
  if (!strcmp(mode, "overflow")) {
    char chunk[65536];
    memset(chunk, 'x', sizeof(chunk));
    for (int i = 0; i < 17 * 16; i++) fwrite(chunk, 1, sizeof(chunk), stdout);
    if (pipe) putchar(0);
    return 0;
  }
  if (!strcmp(mode, "completed") || !strcmp(mode, "linger") || !strcmp(mode, "environment")) {
    fputs("{\"error\":false,\"code\":0,\"res\":\"completed-native-reply\"}", stdout);
    if (pipe) putchar(0);
    if (mcp) putchar('\n');
    if (!strcmp(mode, "linger")) for (;;) pause();
    while (getchar() != EOF) {}
    return 0;
  }
  if (mcp) fputs("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"", stdout);
  else fputs("{\"error\":false,\"code\":0,\"res\":\"", stdout);
  putchar(0xff);
  fputs("\"}", stdout);
  if (pipe) putchar(0);
  if (mcp) putchar('\n');
  if (pipe || mcp) {
    while (getchar() != EOF) {}
  }
  return 0;
}
