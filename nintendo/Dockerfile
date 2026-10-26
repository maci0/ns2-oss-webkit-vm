# syntax=docker/dockerfile:1
# aarch64 JavaScriptCore from the ACCESS/NetFront (Nintendo Switch 2 browser)
# source drop webkit_3.12.11, grafted onto the upstream 613.3.9 JSCOnly build
# system.
#
# The vendor tree is NOT redistributed here. Put it in the build context first:
#   nintendo/vendor/webkit_3.12.11/{JavaScriptCore,WTF}
# see NINTENDO-BUILD.md section 2.
FROM --platform=linux/arm64 debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build perl python3 ruby \
        bison flex gperf pkg-config patch \
        libicu-dev libedit-dev libxml2-dev libsqlite3-dev zlib1g-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY upstream /upstream
COPY vendor /vendor
COPY graft.sh /graft.sh
COPY patches /patches
RUN /graft.sh

ARG JOBS=16

RUN --mount=type=cache,target=/build,sharing=locked \
    cmake -G Ninja -S /src -B /build \
        -DPORT=JSCOnly \
        -DCMAKE_BUILD_TYPE=Release \
        -DENABLE_STATIC_JSC=ON \
        -DENABLE_API_TESTS=OFF \
        -DENABLE_TOOLS=OFF \
        -DUSE_CAPSTONE=OFF \
    && ninja -C /build -j"${JOBS}" jsc \
    && install -m 0755 "$(find /build -type f -name jsc -perm -u+x | head -n1)" /usr/local/bin/jsc

COPY test-smoke.js /opt/test-smoke.js
COPY error-instance.js /opt/error-instance.js

WORKDIR /work
CMD ["jsc", "--useJIT=false", "/opt/test-smoke.js"]
