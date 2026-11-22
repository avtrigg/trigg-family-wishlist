#!/usr/bin/env bash
# Starts the wishlist server behind nginx. Used by the @reboot crontab entry.
# Settings (PORT, APP_ORIGIN, FAMILY_ACCESS_CODE, ...) come from .env.
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Missing .env (copy .env.example and fill it in)." >&2
  exit 1
fi

node --env-file=.env --disable-warning=ExperimentalWarning server.mjs 2>&1 | tee -a wishlist.log
