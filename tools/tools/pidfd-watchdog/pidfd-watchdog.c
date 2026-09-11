#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/epoll.h>
#include <sys/wait.h>
#include <signal.h>
#include <errno.h>
#include <time.h>
#include <sys/syscall.h>
#include <ctype.h>
#include <sys/time.h>
#include <stdarg.h>
#include <sys/stat.h>

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif

#define MAX_SERVICES 32
#define CONFIG_FILE "/etc/pidfd-watchdog.json"
#define LOG_DIR "/sdcard/gt5_nas/tools/watchdog/logs"
#define MAX_LOG_SIZE (10 * 1024 * 1024)  // 10MB

struct service {
    char name[64];
    char cmd[256];
    int enabled;
    int active;
    pid_t pid;
    int pidfd;
};

static struct service services[MAX_SERVICES];
static int num_services = 0;
static FILE *log_fp = NULL;
static char log_path[512] = {0};
static char log_start_time[64] = {0};

static int pidfd_open(pid_t pid, unsigned int flags) {
    return syscall(__NR_pidfd_open, pid, flags);
}

static long long current_ms() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static void get_timestamp(char *buf, size_t size) {
    struct timeval tv;
    struct tm *tm_info;
    gettimeofday(&tv, NULL);
    tm_info = localtime(&tv.tv_sec);
    strftime(buf, size, "%Y%m%d_%H%M%S", tm_info);
}

static void get_timestamp_readable(char *buf, size_t size) {
    struct timeval tv;
    struct tm *tm_info;
    gettimeofday(&tv, NULL);
    tm_info = localtime(&tv.tv_sec);
    strftime(buf, size, "%Y-%m-%d %H:%M:%S", tm_info);
}

static void compress_log(const char *old_path, const char *start_time, const char *end_time) {
    char new_path[512];
    char cmd[1024];
    
    // 重命名: 开始时间_结束时间.log
    snprintf(new_path, sizeof(new_path), "%s/%s_%s.log", LOG_DIR, start_time, end_time);
    rename(old_path, new_path);
    
    // zstd压缩，使用最大压缩比
    snprintf(cmd, sizeof(cmd), "zstd -19 --rm -f %s 2>/dev/null", new_path);
    system(cmd);
}

static void open_log_file() {
    if (log_fp) {
        fclose(log_fp);
        log_fp = NULL;
    }
    
    // 确保日志目录存在
    mkdir(LOG_DIR, 0755);
    
    // 查找最新的日志文件
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "ls -t %s/*.log 2>/dev/null | head -1", LOG_DIR);
    FILE *fp = popen(cmd, "r");
    if (fp) {
        if (fgets(log_path, sizeof(log_path), fp)) {
            // 去掉换行符
            log_path[strcspn(log_path, "\n")] = 0;
            
            // 检查文件大小
            struct stat st;
            if (stat(log_path, &st) == 0 && st.st_size < MAX_LOG_SIZE) {
                // 文件存在且未满，追加模式
                log_fp = fopen(log_path, "a");
                if (log_fp) {
                    // 获取文件创建时间作为log_start_time
                    struct tm *tm_info = localtime(&st.st_ctime);
                    strftime(log_start_time, sizeof(log_start_time), "%Y%m%d_%H%M%S", tm_info);
                    pclose(fp);
                    return;
                }
            }
        }
        pclose(fp);
    }
    
    // 没有找到合适的文件，创建新文件
    get_timestamp(log_start_time, sizeof(log_start_time));
    snprintf(log_path, sizeof(log_path), "%s/%s.log", LOG_DIR, log_start_time);
    
    log_fp = fopen(log_path, "a");
    if (!log_fp) {
        fprintf(stderr, "Cannot open log file: %s\n", log_path);
    }
}

static void check_log_rotation() {
    if (!log_fp) return;
    
    struct stat st;
    if (fstat(fileno(log_fp), &st) == 0) {
        if (st.st_size >= MAX_LOG_SIZE) {
            char end_time[64];
            get_timestamp(end_time, sizeof(end_time));
            
            fclose(log_fp);
            log_fp = NULL;
            
            // 压缩旧日志
            compress_log(log_path, log_start_time, end_time);
            
            // 打开新日志
            open_log_file();
        }
    }
}

static void log_with_time(const char *fmt, ...) {
    if (!log_fp) return;
    
    check_log_rotation();
    
    struct timeval tv;
    struct tm *tm_info;
    gettimeofday(&tv, NULL);
    tm_info = localtime(&tv.tv_sec);
    
    char timestamp[64];
    strftime(timestamp, sizeof(timestamp), "%Y-%m-%d %H:%M:%S", tm_info);
    
    fprintf(log_fp, "[%s.%03ld] [PID:%d] ", timestamp, tv.tv_usec / 1000, getpid());
    
    va_list args;
    va_start(args, fmt);
    vfprintf(log_fp, fmt, args);
    va_end(args);
    
    fflush(log_fp);
}

static char *trim(char *s) {
    while (isspace(*s)) s++;
    char *end = s + strlen(s) - 1;
    while (end > s && isspace(*end)) *end-- = '\0';
    return s;
}

static char *extract_string(const char *json, const char *key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    
    char *pos = strstr(json, pattern);
    if (!pos) return NULL;
    
    pos = strchr(pos + strlen(pattern), ':');
    if (!pos) return NULL;
    pos++;
    
    while (isspace(*pos)) pos++;
    
    if (*pos != '"') return NULL;
    pos++;
    
    char *end = strchr(pos, '"');
    if (!end) return NULL;
    
    int len = end - pos;
    char *result = malloc(len + 1);
    strncpy(result, pos, len);
    result[len] = '\0';
    return result;
}

static int extract_bool(const char *json, const char *key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    
    char *pos = strstr(json, pattern);
    if (!pos) return 0;
    
    pos = strchr(pos + strlen(pattern), ':');
    if (!pos) return 0;
    pos++;
    
    while (isspace(*pos)) pos++;
    
    return strncmp(pos, "true", 4) == 0;
}

static int load_config(const char *filename) {
    FILE *fp = fopen(filename, "r");
    if (!fp) {
        fprintf(stderr, "Cannot open config: %s\n", filename);
        return -1;
    }
    
    fseek(fp, 0, SEEK_END);
    long size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    
    char *json = malloc(size + 1);
    fread(json, 1, size, fp);
    json[size] = '\0';
    fclose(fp);
    
    char *array_start = strstr(json, "\"services\"");
    if (!array_start) {
        free(json);
        return -1;
    }
    
    array_start = strchr(array_start, '[');
    if (!array_start) {
        free(json);
        return -1;
    }
    
    char *pos = array_start + 1;
    num_services = 0;
    
    while (*pos && *pos != ']' && num_services < MAX_SERVICES) {
        char *obj_start = strchr(pos, '{');
        if (!obj_start || obj_start > strchr(pos, ']')) break;
        
        char *obj_end = strchr(obj_start, '}');
        if (!obj_end) break;
        
        int obj_len = obj_end - obj_start + 1;
        char *obj_str = malloc(obj_len + 1);
        strncpy(obj_str, obj_start, obj_len);
        obj_str[obj_len] = '\0';
        
        char *name = extract_string(obj_str, "name");
        char *cmd = extract_string(obj_str, "cmd");
        int enabled = extract_bool(obj_str, "enabled");
        
        if (name && cmd) {
            strncpy(services[num_services].name, name, sizeof(services[num_services].name) - 1);
            strncpy(services[num_services].cmd, cmd, sizeof(services[num_services].cmd) - 1);
            services[num_services].enabled = enabled;
            services[num_services].active = 0;
            services[num_services].pid = -1;
            services[num_services].pidfd = -1;
            num_services++;
        }
        
        free(obj_str);
        if (name) free(name);
        if (cmd) free(cmd);
        
        pos = obj_end + 1;
    }
    
    free(json);
    return num_services;
}

static pid_t find_pid(const char *name) {
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "pgrep -x %s | head -1", name);
    FILE *fp = popen(cmd, "r");
    if (!fp) return -1;
    
    pid_t pid = -1;
    if (fscanf(fp, "%d", &pid) != 1) pid = -1;
    pclose(fp);
    return pid > 0 ? pid : -1;
}

static void start_service(struct service *svc) {
    log_with_time("[%s] Starting: \"%s\"\n", svc->name, svc->cmd);
    
    pid_t child = fork();
    if (child == 0) {
        setsid();
        execl("/bin/sh", "sh", "-c", svc->cmd, NULL);
        _exit(127);
    }
    
    if (child < 0) {
        log_with_time("[%s] Fork failed\n", svc->name);
        return;
    }
    
    usleep(500000);
    
    svc->pid = find_pid(svc->name);
    if (svc->pid < 0) {
        log_with_time("[%s] Failed to find PID\n", svc->name);
        return;
    }
    
    svc->pidfd = pidfd_open(svc->pid, 0);
    if (svc->pidfd < 0) {
        log_with_time("[%s] pidfd_open failed for [%d]\n", svc->name, svc->pid);
        return;
    }
    
    svc->active = 1;
    log_with_time("[%s] Monitoring [%d]\n", svc->name, svc->pid);
}

static int monitor_service(struct service *svc, int epoll_fd) {
    if (!svc->enabled) return -1;
    
    start_service(svc);
    
    if (svc->pidfd < 0) return -1;
    
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.ptr = svc;
    if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, svc->pidfd, &ev) < 0) {
        log_with_time("[%s] epoll_ctl failed\n", svc->name);
        close(svc->pidfd);
        svc->pidfd = -1;
        return -1;
    }
    
    return 0;
}

static void get_exit_reason(pid_t pid, char *reason, size_t size) {
    // 1. 尝试从 waitpid 获取状态
    int status;
    pid_t result = waitpid(pid, &status, WNOHANG);
    if (result > 0) {
        if (WIFEXITED(status)) {
            int code = WEXITSTATUS(status);
            if (code == 0) {
                snprintf(reason, size, "normal exit (code 0)");
            } else {
                snprintf(reason, size, "abnormal exit (code %d)", code);
            }
            return;
        } else if (WIFSIGNALED(status)) {
            int sig = WTERMSIG(status);
            const char *sig_name = strsignal(sig);
            switch (sig) {
                case SIGKILL:
                    snprintf(reason, size, "killed by SIGKILL (possible: kill -9, OOM killer, cgroup)");
                    break;
                case SIGTERM:
                    snprintf(reason, size, "killed by SIGTERM (possible: kill, systemctl stop)");
                    break;
                case SIGINT:
                    snprintf(reason, size, "killed by SIGINT (possible: Ctrl+C)");
                    break;
                case SIGSEGV:
                    snprintf(reason, size, "crashed by SIGSEGV (segmentation fault)");
                    break;
                case SIGABRT:
                    snprintf(reason, size, "crashed by SIGABRT (assertion failure)");
                    break;
                default:
                    snprintf(reason, size, "killed by signal %d (%s)", sig, sig_name);
            }
            return;
        }
    }
    
    // 2. 检查 /proc/pid/status (如果进程还在)
    char path[256];
    snprintf(path, sizeof(path), "/proc/%d/status", pid);
    FILE *fp = fopen(path, "r");
    if (fp) {
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            if (strncmp(line, "State:", 6) == 0) {
                snprintf(reason, size, "process state: %s", line + 7);
                fclose(fp);
                return;
            }
        }
        fclose(fp);
    }
    
    // 3. 检查 dmesg 中的 Android init 日志
    char cmd[512];
    snprintf(cmd, sizeof(cmd), 
        "dmesg | grep -E 'init:.*Service.*exit.*pid %d|init:.*Sending signal.*pid %d' | tail -1", pid, pid);
    fp = popen(cmd, "r");
    if (fp) {
        if (fgets(reason, size, fp) && strlen(reason) > 10) {
            reason[strcspn(reason, "\n")] = 0;
            pclose(fp);
            return;
        }
        pclose(fp);
    }
    
    // 4. 检查 dmesg 中的 OOM killer 日志
    snprintf(cmd, sizeof(cmd), 
        "dmesg | grep -E 'oom.*%d|Killed process %d' | tail -1", pid, pid);
    fp = popen(cmd, "r");
    if (fp) {
        if (fgets(reason, size, fp) && strlen(reason) > 10) {
            reason[strcspn(reason, "\n")] = 0;
            pclose(fp);
            return;
        }
        pclose(fp);
    }
    
    // 5. 检查 dmesg 中的 cgroup 日志
    snprintf(cmd, sizeof(cmd), 
        "dmesg | grep -E 'cgroup.*%d|libprocessgroup.*%d' | tail -1", pid, pid);
    fp = popen(cmd, "r");
    if (fp) {
        if (fgets(reason, size, fp) && strlen(reason) > 10) {
            reason[strcspn(reason, "\n")] = 0;
            pclose(fp);
            return;
        }
        pclose(fp);
    }
    
    // 6. 检查 systemd 日志
    snprintf(cmd, sizeof(cmd), 
        "journalctl -n 20 --no-pager 2>/dev/null | grep -iE '%d|kill|signal|exit' | tail -1", pid);
    fp = popen(cmd, "r");
    if (fp) {
        if (fgets(reason, size, fp) && strlen(reason) > 10) {
            reason[strcspn(reason, "\n")] = 0;
            pclose(fp);
            return;
        }
        pclose(fp);
    }
    
    // 7. 检查 auth 日志
    snprintf(cmd, sizeof(cmd), 
        "tail -20 /var/log/auth.log 2>/dev/null | grep -i 'kill\\|signal\\|exit' | tail -1");
    fp = popen(cmd, "r");
    if (fp) {
        if (fgets(reason, size, fp) && strlen(reason) > 10) {
            reason[strcspn(reason, "\n")] = 0;
            pclose(fp);
            return;
        }
        pclose(fp);
    }
    
    // 8. 默认
    snprintf(reason, size, "killed by external signal (SIGKILL)");
}

static void restart_service(struct service *svc, int epoll_fd) {
    long long detect_time = current_ms();
    pid_t old_pid = svc->pid;
    
    if (svc->pidfd >= 0) {
        epoll_ctl(epoll_fd, EPOLL_CTL_DEL, svc->pidfd, NULL);
        close(svc->pidfd);
        svc->pidfd = -1;
    }
    svc->active = 0;
    
    // 获取退出原因
    char exit_reason[512];
    get_exit_reason(old_pid, exit_reason, sizeof(exit_reason));
    
    log_with_time("[%s] Process [%d] exited, reason: %s\n", svc->name, old_pid, exit_reason);
    log_with_time("[%s] Attempting restart with \"%s\"...\n", svc->name, svc->cmd);
    
    monitor_service(svc, epoll_fd);
    
    long long recover_time = current_ms();
    log_with_time("[%s] Process [%d] recovered (took %lld ms)\n", 
                  svc->name, svc->pid, recover_time - detect_time);
}

static void print_status() {
    log_with_time("=== Service Status ===\n");
    for (int i = 0; i < num_services; i++) {
        log_with_time("[%s] enabled=%d active=%d [%d]\n", 
                      services[i].name, services[i].enabled, 
                      services[i].active, services[i].pid);
    }
    log_with_time("=====================\n");
}

int main(int argc, char *argv[]) {
    if (argc > 1) {
        if (strcmp(argv[1], "status") == 0) {
            FILE *fp = fopen("/tmp/pidfd-watchdog.pid", "r");
            if (!fp) {
                printf("Not running\n");
                return 1;
            }
            pid_t pid;
            fscanf(fp, "%d", &pid);
            fclose(fp);
            
            if (kill(pid, 0) == 0) {
                printf("Running (PID: %d)\n", pid);
                kill(pid, SIGUSR1);
            } else {
                printf("Not running (stale pidfile)\n");
            }
            return 0;
        }
        return 0;
    }
    
    // 创建日志目录
    mkdir(LOG_DIR, 0755);
    
    // 打开日志文件
    open_log_file();
    if (!log_fp) {
        fprintf(stderr, "Failed to open log file\n");
        return 1;
    }
    
    // 检测并杀掉老的实例
    FILE *old_pid_fp = fopen("/tmp/pidfd-watchdog.pid", "r");
    if (old_pid_fp) {
        pid_t old_pid;
        if (fscanf(old_pid_fp, "%d", &old_pid) == 1) {
            fclose(old_pid_fp);
            if (old_pid > 0 && kill(old_pid, 0) == 0) {
                log_with_time("Found old instance (PID: %d), killing...\n", old_pid);
                kill(old_pid, SIGKILL);
                usleep(500000); // 等待500ms
            }
        } else {
            fclose(old_pid_fp);
        }
    }
    
    // 写入新的PID文件
    FILE *pid_fp = fopen("/tmp/pidfd-watchdog.pid", "w");
    if (pid_fp) {
        fprintf(pid_fp, "%d", getpid());
        fclose(pid_fp);
    }
    
    if (load_config(CONFIG_FILE) < 0) {
        log_with_time("Failed to load config\n");
        return 1;
    }
    
    log_with_time("==========================================\n");
    log_with_time("  pidfd-watchdog started\n");
    log_with_time("==========================================\n");
    log_with_time("  PID: %d\n", getpid());
    log_with_time("  Config: %s\n", CONFIG_FILE);
    log_with_time("  Log: %s\n", log_path);
    log_with_time("  Services: %d\n", num_services);
    for (int i = 0; i < num_services; i++) {
        log_with_time("    [%s] %s (enabled=%d)\n", 
                      services[i].name, services[i].cmd, services[i].enabled);
    }
    log_with_time("==========================================\n");
    
    signal(SIGUSR1, print_status);
    
    int epoll_fd = epoll_create1(0);
    if (epoll_fd < 0) {
        log_with_time("epoll_create1 failed: %s\n", strerror(errno));
        return 1;
    }
    
    for (int i = 0; i < num_services; i++) {
        monitor_service(&services[i], epoll_fd);
    }
    
    log_with_time("Watching for events...\n");
    
    struct epoll_event events[10];
    while (1) {
        int nfds = epoll_wait(epoll_fd, events, 10, -1);
        if (nfds < 0) {
            if (errno == EINTR) continue;
            break;
        }
        
        for (int i = 0; i < nfds; i++) {
            struct service *svc = events[i].data.ptr;
            restart_service(svc, epoll_fd);
        }
    }
    
    if (log_fp) fclose(log_fp);
    close(epoll_fd);
    unlink("/tmp/pidfd-watchdog.pid");
    return 1;
}
