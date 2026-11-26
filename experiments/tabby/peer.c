// Node does not expose Unix peer credentials or flock. Keep both checks local to the adapter.
#include <node_api.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <unistd.h>

static napi_value check(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value arg, result;
    void *operation;
    int fd;
    if (napi_get_cb_info(env, info, &argc, &arg, NULL, &operation) != napi_ok ||
        argc != 1 || napi_get_value_int32(env, arg, &fd) != napi_ok || fd < 0) {
        napi_throw_type_error(env, NULL, "Expected file descriptor");
        return NULL;
    }
    int allowed = 0;
    if (operation) {
        allowed = flock(fd, LOCK_EX | LOCK_NB) == 0;
    } else {
#ifdef __APPLE__
        uid_t uid;
        gid_t gid;
        allowed = getpeereid(fd, &uid, &gid) == 0 && uid == geteuid();
#else
        struct ucred cred;
        socklen_t size = sizeof(cred);
        allowed = getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &size) == 0 &&
                  size == sizeof(cred) && cred.uid == geteuid();
#endif
    }
    napi_get_boolean(env, allowed, &result);
    return result;
}
static napi_value init(napi_env env, napi_value exports) {
    static int lock;
    napi_property_descriptor properties[] = {
        {"sameUser", NULL, check, NULL, NULL, NULL, napi_default, NULL},
        {"lock", NULL, check, NULL, NULL, NULL, napi_default, &lock}
    };
    napi_define_properties(env, exports, 2, properties);
    return exports;
}
NAPI_MODULE(peer, init)
