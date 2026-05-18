#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

recip=$(age-plugin-yubikey -l 2>/dev/null | grep -oE "age1yubikey1[a-z0-9]+" | head -n 1)
if [ -z "$recip" ]; then
  echo "Could not find any connected yubikeys, exiting."
  exit 1
fi

recipKeyFile=""
for keyfile in .age-yubikey-identity-*.txt; do
  [ -f "$keyfile" ] || continue
  if grep -q "$recip" "$keyfile"; then
    recipKeyFile="$keyfile"
    break
  fi
done

if [ -z "$recipKeyFile" ]; then
  echo "Could not find identity file for $recip, exiting."
  exit 1
fi

echo "Using identity file: $recipKeyFile"

if [ ! -d ./models.enc ] || [ -z "$(ls -A ./models.enc 2>/dev/null)" ]; then
  echo "No files in ./models.enc to decrypt."
  exit 0
fi

mkdir -p ./models
rm -rf ./models/*

cd ./models.enc
for filename in *; do
  [ -f "$filename" ] || continue
  out="${filename%.age}"
  echo "Decrypting $filename -> models/$out (touch yubikey)"
  age -d -i "../$recipKeyFile" -o "../models/$out" "$filename"
done

echo "Done. Decrypted files in ./models/"
