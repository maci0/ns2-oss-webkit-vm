# syntax=docker/dockerfile:1
# aarch64 JavaScriptCore (jsc-only) test environment for the
# ErrorInstance::computeErrorInfo GC re-entrancy bug (upstream ade92866440).
#
# Source: upstream WebKit tag WebKit-7613.3.9 (613.3.9). The NS2.3 NetFront
# fork tree ships the same vulnerable computeErrorInfo body verbatim but has no
# Source/cmake build infrastructure, so it cannot be configured standalone.
FROM --platform=linux/arm64 debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build perl python3 ruby \
        bison flex gperf pkg-config \
        libicu-dev libedit-dev libxml2-dev libsqlite3-dev zlib1g-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY src /src

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

RUN jsc --version 2>&1 || true

COPY error-instance.js /opt/error-instance.js
COPY sweep.sh /opt/sweep.sh
RUN chmod +x /opt/sweep.sh

WORKDIR /work
CMD ["jsc", "/opt/error-instance.js"]
