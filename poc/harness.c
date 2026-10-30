/*
 * Minimal WebKitGTK page runner, portable across WebKitGTK 2.40 (the v19
 * engine) and 2.54 (the fixed reference).
 *
 *   harness <page.html> [timeout_ms]
 *
 * Console output is forwarded to stdout as "CONSOLE: ..." through a user
 * content manager script-message handler (the console-message-received signal
 * no longer exists in 2.54).  Title changes print as "TITLE: ...".  At the end
 * a PNG snapshot of the view is written to $HARNESS_OUT/snapshot.png.
 *
 * A sanitizer report from the web process arrives on the same stderr.
 */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdlib.h>
#include <string.h>

static const char* outdir;

static const char* inject_js =
    "(function(){"
    "  function send(s){ try { window.webkit.messageHandlers.log.postMessage(String(s)); } catch (e) {} }"
    "  window.onerror = function(msg, url, line, col, err){ send('UNCAUGHT: ' + msg + ' @' + line + ':' + col); return false; };"
    "  window.addEventListener('unhandledrejection', function(e){ send('UNHANDLED REJECTION: ' + e.reason); });"
    "  send('injected at ' + document.readyState);"
    "})();";

static void on_script_message(WebKitUserContentManager* m, WebKitJavascriptResult* js, gpointer data)
{
    (void)m; (void)data;
    JSCValue* value = webkit_javascript_result_get_js_value(js);
    char* str = jsc_value_to_string(value);
    g_print("CONSOLE: %s\n", str);
    fflush(stdout);
    g_free(str);
}

static void on_title(GObject* obj, GParamSpec* pspec, gpointer data)
{
    (void)pspec; (void)data;
    char* title = NULL;
    g_object_get(obj, "title", &title, NULL);
    g_print("TITLE: %s\n", title ? title : "(null)");
    fflush(stdout);
    g_free(title);
}

static gboolean on_timeout(gpointer data)
{
    (void)data; (void)outdir;
    g_print("HARNESS: timeout, ending run\n");
    fflush(stdout);
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

static gboolean on_load(WebKitWebView* view, WebKitLoadEvent ev, gpointer data)
{
    (void)view; (void)data;
    if (ev == WEBKIT_LOAD_FINISHED) {
        g_print("HARNESS: load finished\n");
        fflush(stdout);
    }
    return FALSE;
}

static gboolean on_terminated(WebKitWebView* view, WebKitWebProcessTerminationReason reason, gpointer data)
{
    (void)view; (void)data;
    const char* why = "unknown";
    switch (reason) {
    case WEBKIT_WEB_PROCESS_CRASHED: why = "crashed"; break;
    case WEBKIT_WEB_PROCESS_EXCEEDED_MEMORY_LIMIT: why = "exceeded memory limit"; break;
    default: break;
    }
    g_print("HARNESS: web process terminated (%s)\n", why);
    fflush(stdout);
    gtk_main_quit();
    return FALSE;
}

int main(int argc, char** argv)
{
    if (argc < 2) {
        g_printerr("usage: %s page.html [timeout_ms]\n", argv[0]);
        return 2;
    }
    int timeout_ms = argc > 2 ? atoi(argv[2]) : 6000;
    outdir = g_getenv("HARNESS_OUT");
    if (!outdir)
        outdir = "/tmp";

    g_setenv("WEBKIT_DISABLE_COMPOSITING_MODE", "1", FALSE);
    g_setenv("LIBGL_ALWAYS_SOFTWARE", "1", FALSE);

    gtk_init(&argc, &argv);

    WebKitUserContentManager* ucm = webkit_user_content_manager_new();
    webkit_user_content_manager_register_script_message_handler(ucm, "log");
    g_signal_connect(ucm, "script-message-received::log", G_CALLBACK(on_script_message), NULL);

    WebKitUserScript* script = webkit_user_script_new(
        inject_js, WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL);
    webkit_user_content_manager_add_script(ucm, script);
    webkit_user_script_unref(script);

    GtkWidget* view = g_object_new(WEBKIT_TYPE_WEB_VIEW, "user-content-manager", ucm, NULL);
    GtkWidget* win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_default_size(GTK_WINDOW(win), 1024, 768);
    gtk_container_add(GTK_CONTAINER(win), view);

    WebKitSettings* settings = webkit_web_view_get_settings(WEBKIT_WEB_VIEW(view));
    webkit_settings_set_enable_webgl(settings, TRUE);
    webkit_settings_set_enable_developer_extras(settings, TRUE);
    webkit_settings_set_enable_write_console_messages_to_stdout(settings, TRUE);

    g_signal_connect(view, "notify::title", G_CALLBACK(on_title), NULL);
    g_signal_connect(view, "load-changed", G_CALLBACK(on_load), NULL);
    g_signal_connect(view, "web-process-terminated", G_CALLBACK(on_terminated), NULL);

    /* argv[1] may carry a query string ("page.html?x=1"); g_filename_to_uri()
       would percent-encode the '?', so split it off and append it raw. */
    char* query = NULL;
    char* page = g_strdup(argv[1]);
    char* mark = strchr(page, '?');
    if (mark) {
        *mark = '\0';
        query = g_strdup(mark + 1);
    }

    char* uri = g_filename_to_uri(page, NULL, NULL);
    if (!uri) {
        g_printerr("bad path: %s\n", page);
        return 2;
    }
    if (query) {
        char* with_query = g_strconcat(uri, "?", query, NULL);
        g_free(uri);
        uri = with_query;
    }
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(view), uri);
    g_free(uri);
    g_free(page);
    g_free(query);

    gtk_widget_show_all(win);
    g_timeout_add(timeout_ms, on_timeout, view);
    gtk_main();
    g_print("HARNESS: clean exit\n");
    fflush(stdout);
    return 0;
}
