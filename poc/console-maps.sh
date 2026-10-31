#!/bin/sh
# Print the load base and writable segment of the *harness* WebKitWebProcess,
# i.e. the one that has ~/ns2-wk/stage's libwebkit2gtk-4.1.so.0.8.5 mapped.
pat='webkit2gtk-4.1/WebKitWebProcess'
pid=
for i in $(seq 1 150); do
    for p in $(pgrep -f "$pat" 2>/dev/null); do
        if grep -q 'webkit2gtk-4.1\.so\.0\.8\.5' /proc/$p/maps 2>/dev/null; then pid=$p; break; fi
    done
    [ -n "$pid" ] && break
    sleep 0.2
done
[ -z "$pid" ] && { echo "no harness web process" >&2; exit 1; }
echo "pid=$pid"
awk '/webkit2gtk-4\.1\.so\.0\.8\.5/ { print $1, $2, $3, $6 }' /proc/$pid/maps
