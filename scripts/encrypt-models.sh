#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d ./models ] || [ -z "$(ls -A ./models 2>/dev/null)" ]; then
  echo "No files in ./models to encrypt."
  exit 0
fi

mkdir -p ./models.enc
rm -rf ./models.enc/*

cd ./models
for filename in *; do
  [ -f "$filename" ] || continue
  echo "Encrypting $filename"
  age \
    -r age1yubikey1qgj0kxej36yt7epyp73pqjpvzrreluvcqpx5gugkrwtcularz5yeurpr3qp \
    -r age1yubikey1qdwfpw4nlzcjnvts6kp4wwjwzpz8tm59wyaprvaccjq8uz0yecd4squyee4 \
    -o "../models.enc/$filename.age" \
    "$filename"
done

echo "Done. Encrypted files in ./models.enc/"
