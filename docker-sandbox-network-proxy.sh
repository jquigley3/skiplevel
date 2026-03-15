docker sandbox run --name $1 claude . &
sleep 20
docker sandbox network proxy $1 \
  --policy allow
docker sandbox run $1