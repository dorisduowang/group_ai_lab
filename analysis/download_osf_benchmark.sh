#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-data/osf-grail}"
mkdir -p "$output_dir"

download() {
  local url="$1"
  local name="$2"
  local expected_sha256="$3"
  local partial="$output_dir/$name.part"
  curl --fail --location --show-error --silent "$url" -o "$partial"
  local actual_sha256
  actual_sha256="$(shasum -a 256 "$partial" | awk '{print $1}')"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "Checksum mismatch for $name" >&2
    exit 1
  fi
  mv "$partial" "$output_dir/$name"
}

download "https://osf.io/download/ndxbu/" "game.csv" \
  "b1ccc75a8c750bca2e86f7df3e99f5263932e7d21c57826b48178b45598b9fcf"
download "https://osf.io/download/6a453e33b0c809a5ebeb8500/" "player.csv" \
  "fa5372fead0e6b8e1e73018e8119f32659e71cf00aa1647180a9250adcefc4ed"
download "https://osf.io/download/6a453e2ece8d2ba3a5044411/" "dict_fact_detection.json" \
  "6f008263284b6d30e4f26db7b0487ebaaca866299066becf51bcecffe1c53400"
download "https://osf.io/download/6a453e3317af34f713eb822c/" "dict_approved_submissions.json" \
  "7358f735b79e746be0cf8a647f5d642c957322c242fed3489fb8cb2811f6c8d1"
download "https://osf.io/download/6a453e332152a8a43c799b27/" "hpt_stimuli.csv" \
  "3394c7238869d490eccc6f66c19dacb9f51cd386e2f6740e21c2b4985a417af6"

echo "Downloaded the minimal GRAIL benchmark dataset to $output_dir"
