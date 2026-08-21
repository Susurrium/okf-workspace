#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_ensure_runtime_dirs
PACKAGE_DIR="$MINERU_SYSROOT/packages"
PYTHON_HEADER="$MINERU_SYSROOT/usr/include/python3.12/Python.h"
LOCK_FILE="$MINERU_CONFIG_DIR/system-deps.lock"
APT_ROOT="$MINERU_SYSROOT/apt"
APT_SOURCES_LIST="$APT_ROOT/sources.list"
APT_LISTS="$APT_ROOT/lists"
APT_CACHE="$APT_ROOT/cache"

install -d -m 0700 \
  "$PACKAGE_DIR" \
  "$MINERU_SYSROOT" \
  "$APT_LISTS/partial" \
  "$APT_CACHE/archives/partial"

exec 6>"$MINERU_RUN_DIR/python-headers.lock"
if ! flock -n 6; then
  echo "Another Python-header installation is running." >&2
  exit 73
fi

command -v apt-get >/dev/null
command -v apt-cache >/dev/null
command -v dpkg-deb >/dev/null
command -v dpkg-query >/dev/null
command -v gcc >/dev/null

runtime_version="$(dpkg-query -W -f='${Version}' libpython3.12-stdlib)"
runtime_base="${runtime_version%%-*}"
header_version=""
deb_file=""

if [[ -f "$LOCK_FILE" ]]; then
  header_version="$(awk -F= '$1 == "header_package_version" || $1 == "version" {print $2; exit}' "$LOCK_FILE")"
fi
if [[ -z "$header_version" ]]; then
  while IFS= read -r candidate_file; do
    candidate_version="$(dpkg-deb -f "$candidate_file" Version)"
    if [[ "${candidate_version%%-*}" == "$runtime_base" ]]; then
      header_version="$candidate_version"
      deb_file="$candidate_file"
      break
    fi
  done < <(find "$PACKAGE_DIR" -maxdepth 1 -type f -name 'libpython3.12-dev_*.deb' -print)
fi

if [[ ! -f "$PYTHON_HEADER" ]]; then
  printf '%s\n' \
    'deb http://mirrors.aliyun.com/ubuntu noble main' \
    'deb http://mirrors.aliyun.com/ubuntu noble-updates main' \
    'deb http://mirrors.aliyun.com/ubuntu noble-security main' \
    > "$APT_SOURCES_LIST"
  chmod 0600 "$APT_SOURCES_LIST"

  apt_options=(
    -o "Dir::Etc::sourcelist=$APT_SOURCES_LIST"
    -o "Dir::Etc::sourceparts=-"
    -o "Dir::State::lists=$APT_LISTS"
    -o "Dir::Cache=$APT_CACHE"
    -o "Dir::Cache::archives=$APT_CACHE/archives"
    -o "APT::Sandbox::User=$USER"
    -o "Acquire::Languages=none"
  )
  apt-get "${apt_options[@]}" update

  candidate="$(LC_ALL=C apt-cache "${apt_options[@]}" policy libpython3.12-dev | awk '$1 == "Candidate:" {print $2}')"
  if apt-cache "${apt_options[@]}" show "libpython3.12-dev=$runtime_version" >/dev/null 2>&1; then
    candidate="$runtime_version"
  fi
  if [[ -z "$candidate" || "$candidate" == "(none)" || "${candidate%%-*}" != "$runtime_base" ]]; then
    echo "No ABI-compatible libpython3.12-dev candidate is available for runtime $runtime_version." >&2
    exit 2
  fi
  header_version="$candidate"

  while IFS= read -r candidate_file; do
    if [[ "$(dpkg-deb -f "$candidate_file" Version)" == "$candidate" ]]; then
      deb_file="$candidate_file"
      break
    fi
  done < <(find "$PACKAGE_DIR" -maxdepth 1 -type f -name 'libpython3.12-dev_*.deb' -print)

  if [[ -z "$deb_file" ]]; then
    (
      cd "$PACKAGE_DIR"
      apt-get "${apt_options[@]}" download "libpython3.12-dev=$candidate"
    )
    while IFS= read -r candidate_file; do
      if [[ "$(dpkg-deb -f "$candidate_file" Version)" == "$candidate" ]]; then
        deb_file="$candidate_file"
        break
      fi
    done < <(find "$PACKAGE_DIR" -maxdepth 1 -type f -name 'libpython3.12-dev_*.deb' -print)
  fi
  if [[ -z "$deb_file" || ! -f "$deb_file" ]]; then
    echo "The Python development header package was not downloaded." >&2
    exit 3
  fi

  dpkg-deb -x "$deb_file" "$MINERU_SYSROOT"
fi

if [[ ! -f "$PYTHON_HEADER" ]]; then
  echo "Python.h is missing after installing the development package." >&2
  exit 4
fi
if [[ -z "$header_version" || "${header_version%%-*}" != "$runtime_base" ]]; then
  echo "Python headers $header_version do not match runtime ABI base $runtime_base." >&2
  exit 4
fi

probe_source="$(mktemp "$MINERU_TMP_DIR/header-canary-XXXXXX.c")"
probe_module="${probe_source%.c}.so"
cleanup_probe() {
  rm -f -- "$probe_source" "$probe_module"
}
trap cleanup_probe EXIT
printf '%s\n' \
  '#include <Python.h>' \
  'static PyObject *runtime_version(PyObject *self, PyObject *args) {' \
  '  return PyUnicode_FromString(PY_VERSION);' \
  '}' \
  'static PyMethodDef methods[] = {{"runtime_version", runtime_version, METH_NOARGS, ""}, {NULL, NULL, 0, NULL}};' \
  'static struct PyModuleDef module = {PyModuleDef_HEAD_INIT, "_mineru_header_canary", NULL, -1, methods};' \
  'PyMODINIT_FUNC PyInit__mineru_header_canary(void) { return PyModule_Create(&module); }' \
  > "$probe_source"
gcc -shared -fPIC "$probe_source" -o "$probe_module"
python3 - "$probe_module" "$runtime_base" <<'PY'
import importlib.util
import sys

path, expected = sys.argv[1:]
spec = importlib.util.spec_from_file_location("_mineru_header_canary", path)
if spec is None or spec.loader is None:
    raise SystemExit("could not load header canary")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
reported = module.runtime_version()
if not reported.startswith(expected):
    raise SystemExit(f"header canary reported {reported}, expected {expected}")
print(f"python_header_canary={reported}")
PY

deb_sha="unknown"
if [[ -z "$deb_file" ]]; then
  while IFS= read -r candidate_file; do
    if [[ "$(dpkg-deb -f "$candidate_file" Version)" == "$header_version" ]]; then
      deb_file="$candidate_file"
      break
    fi
  done < <(find "$PACKAGE_DIR" -maxdepth 1 -type f -name 'libpython3.12-dev_*.deb' -print)
fi
if [[ -n "$deb_file" && -f "$deb_file" ]]; then
  deb_sha="$(sha256sum "$deb_file" | awk '{print $1}')"
fi

{
  printf 'runtime_package=libpython3.12-stdlib\n'
  printf 'runtime_package_version=%s\n' "$runtime_version"
  printf 'header_package=libpython3.12-dev\n'
  printf 'header_package_version=%s\n' "$header_version"
  printf 'python_abi_base=%s\n' "$runtime_base"
  printf 'exact_package_match=%s\n' "$([[ "$runtime_version" == "$header_version" ]] && echo yes || echo no)"
  printf 'compiler_import_canary=passed\n'
  printf 'deb_sha256=%s\n' "$deb_sha"
  printf 'repository=%s\n' 'http://mirrors.aliyun.com/ubuntu'
} > "$LOCK_FILE"
chmod 0600 "$LOCK_FILE"

echo "Python headers validated: runtime=$runtime_version headers=$header_version"
