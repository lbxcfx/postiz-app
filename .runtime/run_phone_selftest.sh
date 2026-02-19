#!/usr/bin/env bash
set -euo pipefail
cd /home/lbx/postiz-app/MediaCrawler
timeout 120s ./.venv/bin/python main.py \
  --platform xhs \
  --lt phone \
  --type search \
  --keywords xhs \
  --phone 13141312456 \
  --headless false \
  --save_data_option json \
  --crawl_count 1 \
  --get_comment false \
  --get_sub_comment false
