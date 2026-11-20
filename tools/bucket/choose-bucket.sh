#!/bin/sh
# Run by the nginx image's entrypoint before nginx starts: points /srv/bucket (default.conf's root) at the real
# CMIP6 bucket (/cmip6, from $CMIP6_DIR) when CMIP6_DIR is set and that bucket has a catalog.json, else at the mock
# (/mock, from $DATA_DIR). `docker compose logs data` shows which.
if [ -n "$CMIP6_DIR" ] && [ -f /cmip6/catalog.json ]; then
  ln -sfn /cmip6 /srv/bucket
  echo "bucket: serving the CMIP6 data ($CMIP6_DIR)"
else
  ln -sfn /mock /srv/bucket
  [ -n "$CMIP6_DIR" ] && echo "bucket: no catalog.json in CMIP6_DIR ($CMIP6_DIR); serving the mock instead"
  [ -z "$CMIP6_DIR" ] && echo "bucket: serving the mock (set CMIP6_DIR to serve the CMIP6 data)"
fi
exit 0
