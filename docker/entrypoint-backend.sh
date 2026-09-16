#!/bin/sh
set -e

mkdir -p "${QUICKSCOPE_DATA_DIR}"

exec "$@"
