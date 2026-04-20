#!/usr/bin/env bash
# Downloads and sets up SuperTokens core for local development.
# Stores files in .dev/supertokens/ (gitignored).
set -euo pipefail

ST_DIR="${PROJECT_ROOT:-.}/.dev/supertokens"
ST_CORE_VERSION="11.0.2"
ST_MARKER="$ST_DIR/.setup-done"

if [ -f "$ST_MARKER" ]; then
  exit 0
fi

echo "Setting up SuperTokens core v${ST_CORE_VERSION}..."
mkdir -p "$ST_DIR"

DOWNLOAD_URL="https://api.supertokens.io/0/app/download?pluginName=postgresql&os=linux&mode=DEV&binary=FREE&targetCore=${ST_CORE_VERSION}"

echo "Downloading SuperTokens..."
curl -sL -o "$ST_DIR/supertokens.zip" "$DOWNLOAD_URL" -H "api-version: 0"

echo "Extracting..."
unzip -qo "$ST_DIR/supertokens.zip" -d "$ST_DIR"

echo "Downloading dependencies..."
cd "$ST_DIR/supertokens"
java -classpath "./downloader/*" io.supertokens.downloader.Main

rm -f "$ST_DIR/supertokens.zip"
touch "$ST_MARKER"
echo "SuperTokens setup complete."
